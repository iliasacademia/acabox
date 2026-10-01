const fs=require('fs'),path=require('path'),readline=require('readline');
const dir=process.argv[2];
const files=fs.readdirSync(dir).filter(f=>f.endsWith('.jsonl')).map(f=>path.join(dir,f));
const subFiles=[];for(const d of fs.readdirSync(dir,{withFileTypes:true})){if(d.isDirectory()){const sd=path.join(dir,d.name,'subagents');try{for(const f of fs.readdirSync(sd))if(f.endsWith('.jsonl'))subFiles.push(path.join(sd,f));}catch{}}}
const byModel={};const types={};const apiErr={};let compacts=0,apiErrLines=0,sidechain=0;const perFile=[];const sysSub={};let attachKinds={};let queueOps={};let taskNotif=0;let stopReasons={};
const add=(m,u)=>{const o=byModel[m]||(byModel[m]={msgs:0,in:0,cacheW:0,cacheR:0,out:0});o.msgs++;o.in+=u.input_tokens||0;o.cacheW+=u.cache_creation_input_tokens||0;o.cacheR+=u.cache_read_input_tokens||0;o.out+=u.output_tokens||0;};
async function scan(f,isSub){const rl=readline.createInterface({input:fs.createReadStream(f),crlfDelay:Infinity});let ft={msgs:0,out:0,in:0,cacheR:0,cacheW:0,models:{}};
 for await(const l of rl){if(!l.trim())continue;let j;try{j=JSON.parse(l)}catch{continue}types[(isSub?'sub:':'')+j.type]=(types[(isSub?'sub:':'')+j.type]||0)+1;
  if(j.isSidechain)sidechain++;
  if(j.isCompactSummary||j.compactMetadata)compacts++;
  if(j.isApiErrorMessage){apiErrLines++;const t=JSON.stringify(j.message&&j.message.content||'').replace(/[0-9]+/g,'<n>').slice(0,160);apiErr[t]=(apiErr[t]||0)+1;}
  if(j.type==='system'){sysSub[j.subtype||'?']=(sysSub[j.subtype||'?']||0)+1;}
  if(j.type==='attachment'){const k=j.attachment&&j.attachment.type||'?';attachKinds[k]=(attachKinds[k]||0)+1;}
  if(j.type==='queue-operation'){queueOps[j.operation||'?']=(queueOps[j.operation||'?']||0)+1;}
  if(j.type==='user'&&typeof (j.message&&j.message.content)==='string'&&/<task-notification>/.test(j.message.content))taskNotif++;
  if(j.type==='assistant'&&j.message&&j.message.usage){const m=j.message.model||'?';add(isSub?'[sub] '+m:m,j.message.usage);ft.msgs++;ft.out+=j.message.usage.output_tokens||0;ft.in+=j.message.usage.input_tokens||0;ft.cacheR+=j.message.usage.cache_read_input_tokens||0;ft.cacheW+=j.message.usage.cache_creation_input_tokens||0;ft.models[m]=(ft.models[m]||0)+1;if(j.message.stop_reason)stopReasons[j.message.stop_reason]=(stopReasons[j.message.stop_reason]||0)+1;}
 }
 if(!isSub)perFile.push({f:path.basename(f).slice(0,8),...ft});
}
(async()=>{for(const f of files)await scan(f,false);for(const f of subFiles)await scan(f,true);
 console.log('files',files.length,'subagent files',subFiles.length);console.log('line types',types);console.log('system subtypes',sysSub);console.log('attachment kinds',attachKinds);console.log('queue ops',queueOps);console.log('task-notification user lines',taskNotif);console.log('compact summaries',compacts,'sidechain lines',sidechain);console.log('stop reasons',stopReasons);
 console.log('API error lines',apiErrLines);console.log(Object.entries(apiErr).sort((a,b)=>b[1]-a[1]).slice(0,15));
 console.log('tokens by model');for(const [m,o] of Object.entries(byModel).sort((a,b)=>b[1].out-a[1].out))console.log(m,JSON.stringify(o));
 const tot=Object.values(byModel).reduce((a,o)=>({msgs:a.msgs+o.msgs,in:a.in+o.in,cacheW:a.cacheW+o.cacheW,cacheR:a.cacheR+o.cacheR,out:a.out+o.out}),{msgs:0,in:0,cacheW:0,cacheR:0,out:0});console.log('TOTAL',JSON.stringify(tot));
 console.log('top 8 transcripts by output tokens');for(const p of perFile.sort((a,b)=>b.out-a.out).slice(0,8))console.log(JSON.stringify(p));
})();
