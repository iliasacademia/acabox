// One-pass analysis of the copied production chat DB. Read-only on the copy.
const { execFileSync } = require('child_process');
const fs = require('fs');
const DB = process.argv[2];
const OUT = process.argv[3];
const raw = execFileSync('sqlite3', ['-json', DB, "select id, session_id, type, created_at, message_id, content from messages order by id"], { maxBuffer: 1 << 30 });
const rows = JSON.parse(raw.toString('utf8'));
const sessRaw = execFileSync('sqlite3', ['-json', DB, "select id, title, app_dir_name, model, effort, created_at, updated_at from sessions"], { maxBuffer: 1 << 26 });
const sessions = Object.fromEntries(JSON.parse(sessRaw.toString('utf8')).map(s => [s.id, s]));
const P = (c) => { try { return JSON.parse(c); } catch { return null; } };
const inc = (m, k, n = 1) => { m[k] = (m[k] || 0) + n; };
const T = (iso) => Date.parse(iso + 'Z');

const toolUse = {}; const toolUseById = {}; const toolErr = {}; const toolTotal = {};
const bySessTools = {};
const scaffolds = []; const buildCalls = []; const openCalls = []; const mcpCalls = {};
const att = { images: 0, documents: 0, other: 0, byMedia: {}, names: {}, msgsWithAtt: 0 };
let quotes = 0, quoteSources = {}, chatLinks = 0, chatLinkMsgs = 0, buildFixMsgs = 0;
const userMsgs = []; const firstUser = {};
let asstTextBlocks = 0, asstQuestionBlocks = 0; const questionSess = {};
const turns = []; // {session, userId, userAt, resultId, resultAt, ms, text}
const errResults = []; const hostResults = [];
const fallbacks = [];
let thinkingChars = 0, textChars = 0, toolInputChars = 0, toolResultChars = 0;
const perSessUser = {};
const bashCmds = {}; const bashKinds = {};
const writeTargets = {}; const editTargets = {}; const readTargets = {};
const toolResultByUse = {};
const notebookExec = { executeCode: 0 };
let pendingUser = null; // per session
const pendingBySess = {};
const resultTexts = [];
const assistantRowsPerTurn = {}; // turn index -> count
let curTurnKey = {};
const turnStats = {};

for (const r of rows) {
  const c = P(r.content);
  const sid = r.session_id;
  if (r.type === 'user') {
    const text = (c && c.text) || '';
    userMsgs.push({ id: r.id, sid, at: r.created_at, text, hasAtt: !!(c && c.attachments && c.attachments.length), hasQuote: !!(c && c.quote) });
    if (!firstUser[sid]) firstUser[sid] = { id: r.id, at: r.created_at, text };
    inc(perSessUser, sid);
    if (c && c.attachments && c.attachments.length) {
      att.msgsWithAtt++;
      for (const a of c.attachments) {
        if (a.type === 'image') att.images++; else if (a.type === 'document') att.documents++; else att.other++;
        inc(att.byMedia, a.mediaType || '?');
        const nm = a.name || '?';
        const cls = /^image\.png$/i.test(nm) ? 'image.png (paste/screenshot)' : /screenshot/i.test(nm) ? 'Screenshot*' : (nm.split('.').pop() || '?').toLowerCase();
        inc(att.names, cls);
      }
    }
    if (c && c.quote) { quotes++; inc(quoteSources, (c.quote.source && c.quote.source.kind) || '?'); }
    const links = (text.match(/acabox:\/\/chat\/[0-9a-f-]+/g) || []).length;
    if (links) { chatLinks += links; chatLinkMsgs++; }
    if (/^The build for `[^`]+` failed\. Diagnose and fix it\./.test(text)) buildFixMsgs++;
    pendingBySess[sid] = { userId: r.id, userAt: r.created_at, text, asst: 0, tools: 0 };
  } else if (r.type === 'assistant') {
    const pend = pendingBySess[sid]; if (pend) pend.asst++;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b.type === 'tool_use') {
        inc(toolUse, b.name); toolUseById[b.id] = b.name; if (pend) pend.tools++;
        inc(bySessTools, sid);
        const inp = b.input || {};
        toolInputChars += JSON.stringify(inp).length;
        if (b.name === 'Bash') {
          const cmd = inp.command || '';
          if (/manage_mini_app\.mjs/.test(cmd)) {
            const m = cmd.match(/--name\s+("([^"]+)"|'([^']+)'|(\S+))/);
            const sub = cmd.match(/manage_mini_app\.mjs\s+(\w+)/);
            scaffolds.push({ sid, id: r.id, at: r.created_at, sub: sub ? sub[1] : '?', name: m ? (m[2] || m[3] || m[4]) : '?', toolUseId: b.id });
          }
          const first = cmd.trim().split(/\s+/)[0] || '?';
          inc(bashKinds, first.replace(/^.*\//, ''));
          if (/\.applications\/install\b/.test(cmd)) inc(bashKinds, '[.applications/install]');
          if (/\bpip\b/.test(cmd)) inc(bashKinds, '[pip mention]');
          if (/\bnpm\b/.test(cmd)) inc(bashKinds, '[npm mention]');
          if (/esbuild|build-app/.test(cmd)) inc(bashKinds, '[esbuild/build-app]');
          if (/python3?\s/.test(cmd)) inc(bashKinds, '[python run]');
          if (/\bcurl\b/.test(cmd)) inc(bashKinds, '[curl]');
          if (/run_in_background/.test(JSON.stringify(inp))) inc(bashKinds, '[run_in_background]');
          if (inp.run_in_background) inc(bashKinds, '[run_in_background=true]');
        }
        if (b.name === 'Write') inc(writeTargets, (inp.file_path || '?').replace(/^.*workspace-data\//, '').split('/').slice(0, 2).join('/'));
        if (b.name === 'Edit') inc(editTargets, (inp.file_path || '?').replace(/^.*workspace-data\//, '').split('/').slice(0, 2).join('/'));
        if (b.name === 'Read') inc(readTargets, (inp.file_path || '?').replace(/^.*workspace-data\//, '').split('/').slice(0, 2).join('/'));
        if (/build_and_open_mini_application/.test(b.name)) buildCalls.push({ sid, id: r.id, at: r.created_at, dir: inp.appDirName || inp.dir_name || inp.dirName || JSON.stringify(inp).slice(0, 80), toolUseId: b.id });
        if (/^mcp__mini-apps__open_mini_application$/.test(b.name)) openCalls.push({ sid, id: r.id, toolUseId: b.id });
        if (/^mcp__/.test(b.name)) inc(mcpCalls, b.name);
      } else if (b.type === 'text') {
        asstTextBlocks++; textChars += (b.text || '').length;
        const t = (b.text || '').trim();
        if (/\?\s*$/.test(t)) { asstQuestionBlocks++; inc(questionSess, sid); }
      } else if (b.type === 'thinking') {
        thinkingChars += (b.thinking || '').length;
      } else if (b.type === 'fallback') {
        fallbacks.push({ sid, at: r.created_at, from: b.from, to: b.to });
      }
    }
  } else if (r.type === 'tool_result') {
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      const name = toolUseById[b.tool_use_id] || '?';
      inc(toolTotal, name);
      if (b.is_error) inc(toolErr, name);
      const cc = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
      toolResultChars += cc.length;
      toolResultByUse[b.tool_use_id] = { is_error: !!b.is_error, head: cc.slice(0, 300) };
    }
  } else if (r.type === 'result') {
    const pend = pendingBySess[sid];
    if (pend) {
      const ms = T(r.created_at) - T(pend.userAt);
      turns.push({ sid, title: sessions[sid] && sessions[sid].title, userId: pend.userId, userAt: pend.userAt, resultId: r.id, resultAt: r.created_at, ms, asst: pend.asst, tools: pend.tools, text: pend.text.slice(0, 160).replace(/\s+/g, ' '), is_error: !!(c && c.is_error), resultLen: ((c && c.result) || '').length });
      pendingBySess[sid] = null;
    } else {
      hostResults.push({ sid, id: r.id, at: r.created_at, head: JSON.stringify(c).slice(0, 200) });
    }
    if (c && c.is_error) errResults.push({ sid, id: r.id, at: r.created_at, title: sessions[sid] && sessions[sid].title, text: ((c.result) || '').slice(0, 400) });
    if (c && c.result === '') inc(turnStats, 'empty_result');
    resultTexts.push(((c && c.result) || '').length);
  }
}

const unanswered = Object.values(pendingBySess).filter(Boolean).map(p => ({ sid: p.sid, userId: p.userId, userAt: p.userAt, title: sessions[p.sid] && sessions[p.sid].title, asst: p.asst, tools: p.tools, text: p.text.slice(0, 120).replace(/\s+/g, ' ') }));

// Build call outcomes
for (const bc of buildCalls) { const tr = toolResultByUse[bc.toolUseId]; bc.ok = tr ? !tr.is_error : null; bc.head = tr ? tr.head.slice(0, 200) : null; }
for (const sc of scaffolds) { const tr = toolResultByUse[sc.toolUseId]; sc.ok = tr ? !tr.is_error : null; sc.head = tr ? tr.head.slice(0, 160) : null; }

const sorted = turns.map(t => t.ms).sort((a, b) => a - b);
const q = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
const fmt = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' + (s % 60) + 's' : Math.floor(s / 3600) + 'h' + Math.floor((s % 3600) / 60) + 'm'; };
const buckets = {}; for (const ms of sorted) { const s = ms / 1000; const k = s < 10 ? '<10s' : s < 30 ? '10-30s' : s < 60 ? '30-60s' : s < 180 ? '1-3m' : s < 600 ? '3-10m' : s < 1800 ? '10-30m' : s < 3600 ? '30-60m' : '>60m'; inc(buckets, k); }

const result = {
  rows: rows.length, userMsgs: userMsgs.length, turns: turns.length, unansweredUserMsgs: unanswered,
  hostAuthoredResults: hostResults.length, hostResultsSample: hostResults.slice(0, 10),
  turnDur: { n: sorted.length, p50: fmt(q(0.5)), p75: fmt(q(0.75)), p90: fmt(q(0.9)), p95: fmt(q(0.95)), max: fmt(sorted[sorted.length - 1] || 0), buckets, totalHours: +(sorted.reduce((a, b) => a + b, 0) / 36e5).toFixed(1), meanMin: +(sorted.reduce((a, b) => a + b, 0) / sorted.length / 6e4).toFixed(1) },
  longest: turns.slice().sort((a, b) => b.ms - a.ms).slice(0, 12).map(t => ({ dur: fmt(t.ms), sid: t.sid.slice(0, 8), title: t.title, asst: t.asst, tools: t.tools, userAt: t.userAt, text: t.text })),
  turnsOver10m: turns.filter(t => t.ms > 6e5).length, turnsOver30m: turns.filter(t => t.ms > 18e5).length,
  turnStats, errResults,
  toolUse: Object.entries(toolUse).sort((a, b) => b[1] - a[1]),
  toolErrRate: Object.entries(toolTotal).sort((a, b) => b[1] - a[1]).map(([n, t]) => [n, t, toolErr[n] || 0, +((100 * (toolErr[n] || 0)) / t).toFixed(1)]),
  mcpCalls: Object.entries(mcpCalls).sort((a, b) => b[1] - a[1]),
  bashKinds: Object.entries(bashKinds).sort((a, b) => b[1] - a[1]).slice(0, 40),
  writeTargets: Object.entries(writeTargets).sort((a, b) => b[1] - a[1]).slice(0, 25),
  editTargets: Object.entries(editTargets).sort((a, b) => b[1] - a[1]).slice(0, 25),
  readTargets: Object.entries(readTargets).sort((a, b) => b[1] - a[1]).slice(0, 25),
  scaffolds, buildCalls, openCalls: openCalls.length,
  attachments: att, quotes, quoteSources, chatLinks, chatLinkMsgs, buildFixMsgs,
  asstTextBlocks, asstQuestionBlocks, questionSessions: Object.keys(questionSess).length,
  chars: { thinking: thinkingChars, text: textChars, toolInput: toolInputChars, toolResult: toolResultChars },
  fallbacks,
  resultLenStats: { zero: resultTexts.filter(x => x === 0).length, n: resultTexts.length, mean: Math.round(resultTexts.reduce((a, b) => a + b, 0) / resultTexts.length) },
  firstUser: Object.entries(firstUser).map(([sid, f]) => ({ sid: sid.slice(0, 8), title: sessions[sid] && sessions[sid].title, app: sessions[sid] && sessions[sid].app_dir_name, at: f.at, len: f.text.length, hasAtt: userMsgs.find(u => u.id === f.id).hasAtt, text: f.text.slice(0, 260).replace(/\s+/g, ' ') })),
  userTextLen: (() => { const l = userMsgs.map(u => u.text.length).sort((a, b) => a - b); return { p50: l[Math.floor(l.length * .5)], p90: l[Math.floor(l.length * .9)], max: l[l.length - 1], under20: l.filter(x => x < 20).length }; })(),
  shortUserMsgs: userMsgs.filter(u => u.text.trim().length < 25).map(u => u.text.trim()).reduce((m, t) => (inc(m, t.toLowerCase()), m), {}),
};
fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
console.log('wrote', OUT, 'rows', rows.length);
