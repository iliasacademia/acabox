// Minimal Chrome DevTools Protocol driver for the dev Acabox window.
// usage: node cdp.mjs <port> targets
//        node cdp.mjs <port> eval '<js>'
//        node cdp.mjs <port> shot <file.png>
//        node cdp.mjs <port> run <steps.json>
// steps.json: [{"eval":"js"},{"click":"css"},{"clickText":"Chats","tag":"button"},{"type":{"selector":"css","text":"hi"}},{"shot":"file.png"},{"wait":500},{"key":{"selector":"css","key":"Enter"}}]
import fs from 'node:fs';

const [,, portArg, cmd, ...rest] = process.argv;
const port = portArg || '9333';

async function pickTarget() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  if (process.env.CDP_TARGET === 'iframe') {
    const frame = list.find((t) => t.type === 'iframe');
    return { list, main: frame };
  }
  const pages = list.filter((t) => t.type === 'page');
  const main = pages.find((t) => /cobuilding_window/.test(t.url)) || pages.find((t) => !/devtools|quick|find|overlay|update/.test(t.url)) || pages[0];
  return { list, main };
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      close() { ws.close(); },
    });
    const api = {
      onEvent: null,
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      close() { ws.close(); },
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error))); else res(msg.result);
      } else if (msg.method && api.onEvent) {
        api.onEvent(msg);
      }
    };
    ws.onerror = (e) => reject(e);
  });
}

async function evalJs(c, expression) {
  const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 800));
  return r.result.value;
}

async function shot(c, file) {
  const dims = await evalJs(c, '({w: window.innerWidth, h: window.innerHeight})');
  const r = await c.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: dims.w, height: dims.h, scale: 1 },
    captureBeyondViewport: false,
  });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return `${file} (${dims.w}x${dims.h})`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const helpers = `
window.__q = (sel) => document.querySelector(sel);
window.__byText = (text, tag) => {
  const els = Array.from(document.querySelectorAll(tag || '*'));
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const t = norm(text);
  let best = null;
  for (const el of els) {
    if (!el.offsetParent && el.tagName !== 'BODY') continue;
    const own = norm(el.innerText || el.textContent);
    if (own === t || (own.includes(t) && own.length < t.length + 40)) {
      if (!best || el.contains(best) === false && own.length <= norm(best.innerText||best.textContent).length) best = el;
    }
  }
  return best;
};
window.__setValue = (el, text) => {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
true;`;

async function runSteps(c, steps) {
  await evalJs(c, helpers);
  const out = [];
  for (const step of steps) {
    try {
      if (step.wait != null) { await sleep(step.wait); out.push(`wait ${step.wait}`); }
      else if (step.eval) { const v = await evalJs(c, step.eval); out.push(`eval => ${JSON.stringify(v)?.slice(0, 2000)}`); }
      else if (step.click) { const v = await evalJs(c, `(()=>{const el=__q(${JSON.stringify(step.click)}); if(!el) return 'NOT FOUND'; el.click(); return 'clicked '+el.tagName+' '+(el.className||'')})()`); out.push(`click ${step.click} => ${v}`); }
      else if (step.clickText) { const v = await evalJs(c, `(()=>{const el=__byText(${JSON.stringify(step.clickText)}, ${JSON.stringify(step.tag || null)}); if(!el) return 'NOT FOUND'; el.click(); return 'clicked '+el.tagName+' '+(el.className||'')})()`); out.push(`clickText ${step.clickText} => ${v}`); }
      else if (step.type) { const v = await evalJs(c, `(()=>{const el=__q(${JSON.stringify(step.type.selector)}); if(!el) return 'NOT FOUND'; el.focus(); __setValue(el, ${JSON.stringify(step.type.text)}); return 'typed into '+el.tagName})()`); out.push(`type => ${v}`); }
      else if (step.key) { const v = await evalJs(c, `(()=>{const el=__q(${JSON.stringify(step.key.selector)})||document.activeElement; const ev=new KeyboardEvent('keydown',{key:${JSON.stringify(step.key.key)},code:${JSON.stringify(step.key.key)},bubbles:true,cancelable:true,metaKey:${!!step.key.meta}}); el.dispatchEvent(ev); return 'key '+${JSON.stringify(step.key.key)}+' on '+el.tagName})()`); out.push(`key => ${v}`); }
      else if (step.shot) { out.push(`shot => ${await shot(c, step.shot)}`); }
      else out.push(`unknown step ${JSON.stringify(step)}`);
    } catch (e) {
      out.push(`ERROR in ${JSON.stringify(step).slice(0, 120)}: ${e.message.slice(0, 500)}`);
    }
  }
  return out;
}

const { list, main } = await pickTarget();
if (cmd === 'targets') {
  for (const t of list) console.log(`${t.type}\t${t.title}\t${t.url}`);
  process.exit(0);
}
if (!main) { console.error('no page target'); process.exit(1); }
const c = await connect(main.webSocketDebuggerUrl);
try {
  await c.send('Page.enable');
  if (cmd === 'eval') console.log(JSON.stringify(await evalJs(c, rest.join(' ')), null, 1));
  else if (cmd === 'shot') console.log(await shot(c, rest[0]));
  else if (cmd === 'run') { const steps = JSON.parse(fs.readFileSync(rest[0], 'utf8')); for (const line of await runSteps(c, steps)) console.log(line); }
  else if (cmd === 'probe-frame') {
    // Install error listeners before the document loads, reload, then report what fired.
    const ms = Number(rest[0] || 6000);
    const events = [];
    c.onEvent = (m) => events.push(m);
    await c.send('Runtime.enable');
    await c.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__errs=[];window.addEventListener('error',e=>__errs.push('error:'+String(e.message)+' @'+String(e.filename).slice(-40)+':'+e.lineno));window.addEventListener('unhandledrejection',e=>__errs.push('rejection:'+String(e.reason&&e.reason.stack||e.reason).slice(0,400)));window.addEventListener('cobuild-error',e=>__errs.push('cobuild-error:'+JSON.stringify(e.detail).slice(0,600)));`,
    });
    await c.send('Runtime.evaluate', { expression: 'location.reload()' });
    await sleep(ms);
    try {
      const r = await c.send('Runtime.evaluate', { expression: 'JSON.stringify({errs: window.__errs, root: document.getElementById("root") && document.getElementById("root").children.length, ready: document.readyState})', returnByValue: true });
      console.log('PROBE', r.result.value);
    } catch (e) { console.log('probe eval failed:', e.message.slice(0, 300)); }
    for (const e of events) {
      if (e.method === 'Runtime.exceptionThrown') console.log('EXCEPTION', JSON.stringify(e.params.exceptionDetails).slice(0, 1200));
      else if (e.method === 'Runtime.consoleAPICalled') console.log('CONSOLE.' + e.params.type, e.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 600));
    }
    console.log(`(${events.length} runtime events)`);
  }
  else if (cmd === 'listen') {
    // Collect console messages + exceptions for N ms, optionally after reloading the document.
    const ms = Number(rest[0] || 5000);
    const reload = rest[1] === 'reload';
    const events = [];
    c.onEvent = (m) => events.push(m);
    await c.send('Runtime.enable');
    await c.send('Log.enable');
    if (reload) await c.send('Runtime.evaluate', { expression: 'location.reload()' });
    await sleep(ms);
    for (const e of events) {
      if (e.method === 'Runtime.exceptionThrown') console.log('EXCEPTION', JSON.stringify(e.params.exceptionDetails).slice(0, 1200));
      else if (e.method === 'Runtime.consoleAPICalled') console.log('CONSOLE.' + e.params.type, e.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 600));
      else if (e.method === 'Log.entryAdded') console.log('LOG.' + e.params.entry.level, (e.params.entry.text || '').slice(0, 600), e.params.entry.url || '');
    }
    console.log(`(${events.length} events)`);
  }
  else console.error('unknown command');
} finally {
  c.close();
}
