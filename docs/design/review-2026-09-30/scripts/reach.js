const fs=require('fs'),path=require('path');
const root=path.resolve('src/cobuilding');
const entries=['renderer/index.tsx','renderer/update-entry.tsx','renderer/quick-chat-entry.tsx','renderer/find-bar-entry.tsx','renderer/screenshot-overlay-entry.tsx','renderer/preload.ts','preload.ts','main/index.ts','agent-server/index.ts'];
const forge=fs.readFileSync('forge.config.js','utf8');
const forgeEntries=[...forge.matchAll(/'\.\/src\/cobuilding\/([^']+)'/g)].map(m=>m[1]);
const starts=[...new Set([...entries,...forgeEntries])].map(e=>path.join(root,e)).filter(f=>fs.existsSync(f));
const exts=['.ts','.tsx','.js','.jsx','.css','.json'];
function resolve(from,spec){ if(!spec.startsWith('.'))return null; let p=path.resolve(path.dirname(from),spec); const cands=[p,...exts.map(e=>p+e),...exts.map(e=>path.join(p,'index'+e))]; for(const c of cands){ if(fs.existsSync(c)&&fs.statSync(c).isFile())return c;} return null;}
const seen=new Set(); const q=[...starts];
while(q.length){const f=q.pop(); if(seen.has(f))continue; seen.add(f); if(!/\.(ts|tsx|js|jsx)$/.test(f))continue; const src=fs.readFileSync(f,'utf8'); const re=/(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"]([^'"]+)['"]/g; let m; while((m=re.exec(src))){const r=resolve(f,m[1]); if(r&&!seen.has(r))q.push(r);} }
function walk(d,out){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name); if(e.isDirectory()){ if(e.name==='__tests__'||e.name==='node_modules')continue; walk(p,out);} else if(/\.(ts|tsx|css)$/.test(e.name)&&!/\.test\.|\.d\.ts$/.test(e.name)) out.push(p);} }
const all=[]; walk(path.join(root,'renderer'),all);
let tot=0,totTs=0,totCss=0; const dead=[];
for(const f of all){ if(!seen.has(f)){ const n=fs.readFileSync(f,'utf8').split('\n').length; tot+=n; if(f.endsWith('.css'))totCss+=n; else totTs+=n; dead.push([n,path.relative(root,f)]);} }
dead.sort((a,b)=>b[0]-a[0]); for(const [n,f] of dead)console.log(String(n).padStart(6),f);
console.log('UNREACHABLE renderer files:',dead.length,'lines total:',tot,'(ts/tsx',totTs,'css',totCss,')');
console.log('entries used:',starts.map(s=>path.relative(root,s)).join(', '));
