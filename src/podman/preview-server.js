const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;
const OUTPUT_DIR = '/workspace/output';

// ── Live reload via Server-Sent Events ──────────────────────────

const sseClients = new Set();

// SSE endpoint — browsers connect here to listen for reload signals
app.get('/__livereload', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('data: connected\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function notifyReload() {
  for (const client of sseClients) {
    client.write('data: reload\n\n');
  }
}

// Watch the output directory for changes
let debounceTimer = null;
function startWatcher() {
  try {
    fs.watch(OUTPUT_DIR, { recursive: true }, () => {
      // Debounce: wait 300ms after last change before notifying
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(notifyReload, 300);
    });
    console.log('[preview-server] Watching for file changes...');
  } catch {
    // Directory may not exist yet — retry in 2s
    setTimeout(startWatcher, 2000);
  }
}
startWatcher();

// Script injected into HTML responses for auto-reload
const RELOAD_SCRIPT = `
<script>
(function() {
  var es = new EventSource('/__livereload');
  es.onmessage = function(e) {
    if (e.data === 'reload') location.reload();
  };
  es.onerror = function() {
    setTimeout(function() { location.reload(); }, 2000);
  };
})();
</script>`;

// ── Serve chart libraries from node_modules as /vendor/* ────────

app.use('/vendor/chart.js', express.static(path.join(__dirname, 'node_modules/chart.js/dist')));
app.use('/vendor/plotly', express.static(path.join(__dirname, 'node_modules/plotly.js-dist-min')));
app.use('/vendor/d3', express.static(path.join(__dirname, 'node_modules/d3/dist')));
app.use('/vendor/papaparse', express.static(path.join(__dirname, 'node_modules/papaparse')));

// Serve workspace data files (CSVs etc.) as /data/*
app.use('/data', express.static('/workspace'));

// ── Serve output files with live-reload injection ───────────────

// For HTML files, inject the reload script before </body> or at the end
app.use((req, res, next) => {
  // Skip non-file requests and vendor/data routes (already handled above)
  if (req.path.startsWith('/vendor/') || req.path.startsWith('/data/') || req.path === '/__livereload') {
    return next();
  }

  // Determine file path
  let filePath = path.join(OUTPUT_DIR, req.path);
  if (req.path === '/') {
    // Show directory listing for root
    return serveDirectoryListing(res);
  }

  // Check if file exists
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      // Try index.html inside directory
      filePath = path.join(filePath, 'index.html');
      if (!fs.existsSync(filePath)) return serveDirectoryListing(res);
    }
  } catch {
    return next();
  }

  // Only inject into HTML files
  if (!filePath.endsWith('.html') && !filePath.endsWith('.htm')) {
    return res.sendFile(filePath);
  }

  let html = fs.readFileSync(filePath, 'utf-8');
  // Inject reload script before </body> if present, otherwise append
  if (html.includes('</body>')) {
    html = html.replace('</body>', RELOAD_SCRIPT + '</body>');
  } else {
    html += RELOAD_SCRIPT;
  }
  res.type('html').send(html);
});

function serveDirectoryListing(res) {
  let files = [];
  try {
    files = fs.readdirSync(OUTPUT_DIR).filter(f => !f.startsWith('.'));
  } catch {
    // output dir may not exist yet
  }

  const fileLinks = files.length > 0
    ? files.map(f => `<li><a href="/${f}">${f}</a></li>`).join('\n')
    : '<li><em>No files yet. Use Claude to generate output to /workspace/output/</em></li>';

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Preview Server</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #333; }
    h1 { font-size: 20px; }
    ul { line-height: 1.8; }
    a { color: #0066cc; }
    .vendor { margin-top: 24px; padding: 16px; background: #f5f5f5; border-radius: 8px; font-size: 13px; }
    .vendor h3 { margin: 0 0 8px 0; font-size: 14px; }
    code { background: #e8e8e8; padding: 2px 5px; border-radius: 3px; font-size: 12px; }
  </style>
</head>
<body>
  <h1>Preview Server</h1>
  <p>Files in <code>/workspace/output/</code>:</p>
  <ul>${fileLinks}</ul>
  <div class="vendor">
    <h3>Available Libraries (use in generated HTML)</h3>
    <ul>
      <li><code>&lt;script src="/vendor/chart.js/chart.umd.js"&gt;&lt;/script&gt;</code> — Chart.js</li>
      <li><code>&lt;script src="/vendor/plotly/plotly.min.js"&gt;&lt;/script&gt;</code> — Plotly.js</li>
      <li><code>&lt;script src="/vendor/d3/d3.min.js"&gt;&lt;/script&gt;</code> — D3.js</li>
      <li><code>&lt;script src="/vendor/papaparse/papaparse.min.js"&gt;&lt;/script&gt;</code> — PapaParse (CSV)</li>
    </ul>
    <p>Data files from <code>/workspace/</code> are available at <code>/data/filename.csv</code></p>
  </div>
${RELOAD_SCRIPT}
</body>
</html>`);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[preview-server] Listening on port ${PORT}`);
  console.log(`[preview-server] Serving files from ${OUTPUT_DIR}`);
  console.log(`[preview-server] Live reload enabled`);
});
