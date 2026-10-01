const { execFileSync } = require('child_process');
const DB = process.argv[2];
const rows = JSON.parse(execFileSync('sqlite3', ['-json', DB, "select id, session_id, type, created_at, content from messages where type in ('assistant','tool_result') order by id"], { maxBuffer: 1 << 30 }).toString());
const P = (c) => { try { return JSON.parse(c); } catch { return null; } };
const uses = {}; const want = new Set(['Monitor','NotebookEdit','AskUserQuestion','DesignSync','Skill','Agent','mcp__mini-apps__build_and_open_mini_application','WebFetch','Edit','Bash','Read']);
const skillNames = {}; const agentTypes = {}; const agentErrs = []; const results = {};
for (const r of rows) {
  const c = P(r.content); if (!Array.isArray(c)) continue;
  if (r.type === 'assistant') { for (const b of c) { if (b.type === 'tool_use' && want.has(b.name)) { uses[b.id] = { name: b.name, input: b.input || {}, at: r.created_at, sid: r.session_id }; if (b.name === 'Skill') skillNames[(b.input && (b.input.skill || b.input.name)) || '?'] = (skillNames[(b.input && (b.input.skill || b.input.name)) || '?'] || 0) + 1; if (b.name === 'Agent') { const t = (b.input && (b.input.subagent_type || b.input.type)) || 'general'; agentTypes[t] = (agentTypes[t] || 0) + 1; } } } }
  else { for (const b of c) { const u = uses[b.tool_use_id]; if (!u) continue; const txt = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || ''); results[b.tool_use_id] = { err: !!b.is_error, txt }; } }
}
const show = (name, n = 6) => { console.log('=== ' + name + ' results'); let k = 0; for (const [id, u] of Object.entries(uses)) { if (u.name !== name) continue; const r = results[id]; if (!r) continue; if (name !== 'Monitor' && name !== 'NotebookEdit' && name !== 'AskUserQuestion' && name !== 'DesignSync' && !r.err) continue; if (k++ >= n) break; console.log(JSON.stringify({ at: u.at.slice(0, 16), sid: u.sid.slice(0, 8), err: r.err, input: JSON.stringify(u.input).slice(0, 140), result: r.txt.replace(/\s+/g, ' ').slice(0, 260) })); } };
show('Monitor'); show('NotebookEdit'); show('AskUserQuestion'); show('DesignSync'); show('Skill', 3);
console.log('=== Skill names', skillNames);
console.log('=== Agent subagent types', agentTypes);
// Agent error signatures
const sig = {}; for (const [id, u] of Object.entries(uses)) { if (u.name !== 'Agent') continue; const r = results[id]; if (r && r.err) { const s = r.txt.replace(/[0-9]+/g, '<n>').replace(/\s+/g, ' ').slice(0, 140); sig[s] = (sig[s] || 0) + 1; } }
console.log('=== Agent error signatures', Object.entries(sig).sort((a, b) => b[1] - a[1]).slice(0, 8));
// Bash / Read / Edit error signatures
for (const nm of ['Bash', 'Read', 'Edit', 'WebFetch']) { const s2 = {}; for (const [id, u] of Object.entries(uses)) { if (u.name !== nm) continue; const r = results[id]; if (r && r.err) { const s = r.txt.replace(/[0-9]+/g, '<n>').replace(/\/Users\/[^ ]+/g, '<path>').replace(/\s+/g, ' ').slice(0, 110); s2[s] = (s2[s] || 0) + 1; } } console.log('=== ' + nm + ' error signatures', Object.entries(s2).sort((a, b) => b[1] - a[1]).slice(0, 8)); }
// build failures detail text
console.log('=== build failure texts'); for (const [id, u] of Object.entries(uses)) { if (u.name !== 'mcp__mini-apps__build_and_open_mini_application') continue; const r = results[id]; if (r && r.err) console.log(JSON.stringify(r.txt.slice(0, 300))); }
