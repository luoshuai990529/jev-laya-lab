// Evaluate saved paired Choice requests without translating or changing their prompts.
// Usage: node scripts/benchmark-paired.mjs paired-dataset.json output-directory
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DiskStore} from '../server/store.mjs';
import {ConfigStore,callProvider,checkProvider} from '../server/providers.mjs';
import {interpret,summarize} from '../server/decisions.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const [input,output]=process.argv.slice(2);
if(!input||!output)throw Error('Provide paired input and a new output directory');
const bytes=await readFile(input),pairs=JSON.parse(bytes),fingerprint=createHash('sha256').update(bytes).digest('hex');
if(!Array.isArray(pairs)||!pairs.length||new Set(pairs.map(x=>x.id)).size!==pairs.length)throw Error('Invalid paired dataset');
for(const pair of pairs)for(const language of ['zh','en']){
 const request=pair[language+'Request'];
 if(!request?.questions?.pick||request.questions.pick.type!=='choice')throw Error('Only paired Choice is supported');
 if(Object.keys(request.state).some(k=>!['subject','question','options'].includes(k)))throw Error('Unexpected state field');
 if(!Object.hasOwn(request.questions.pick.criteria,pair.expected))throw Error('Answer not in options');
 if(JSON.stringify(request.state.options)!==JSON.stringify(request.questions.pick.criteria))throw Error('Options mismatch');
}
const store=new DiskStore(path.join(root,'.local'));await store.init();
const config=new ConfigStore(store);await config.init();
const providers=['jev','laya','startlux'],configs=Object.fromEntries(providers.map(p=>[p,config.snapshot(p)]));
if(configs.laya.model!=='multilingual'||configs.startlux.model!=='StartLux-Decision-4B-Q8_0')throw Error('Unexpected checkpoint configuration');
await mkdir(output,{recursive:true});
const lock=await writeFile(path.join(output,'started.json'),JSON.stringify({createdAt:new Date().toISOString(),fingerprint}),{flag:'wx'});
await copyFile(input,path.join(output,'paired-dataset.json'));
const metadata={createdAt:new Date().toISOString(),fingerprint,count:pairs.length,providers,mode:'choice',concurrency:1,retries:0,
 layaCheckpoint:'multilingual',languages:['zh','en'],runIds:{},health:{},warmups:[],
 measurement:'Each language/provider is serial and timed independently. Warmup and model loading excluded. Wall time includes response interpretation and per-item disk persistence. HTTP latency includes network and service overhead.',
 translation:'Reuses the exact prior paired dataset; translated questions, subject, options and instructions. No human translation audit; original option order and original answer key retained.',
};
for(const provider of providers){
 metadata.health[provider]=(await checkProvider(provider,configs[provider])).rawResponse;
 // Unscored neutral warmup; never includes the answer key for the evaluated bank.
 const payload={state:'A customer asks for a refund of a duplicate charge.',questions:{pick:{type:'choice',instructions:'Which team should handle the request?',criteria:{A:'Billing',B:'Technical support',C:'Delivery'}}}};
 const response=await callProvider(provider,configs[provider],payload);
 if(!response.rawResponse.answers?.pick?.choice)throw Error('Warmup failed: '+provider);
 metadata.warmups.push({provider,...response});
}
await writeFile(path.join(output,'protocol.json'),JSON.stringify(metadata,null,2));
for(const language of ['zh','en']){
 const runStarted=performance.now(),id=randomUUID();metadata.runIds[language]=id;
 const snapshots=pairs.map((p,i)=>({id:p.id,number:i+1,type:p.questionType,subject:1,category:p.questionType,question:p[language+'Request'].state.question,options:p[language+'Request'].state.options,answer:p.expected,explanation:'',image_local:null}));
 const run={id,status:'running',createdAt:new Date().toISOString(),finishedAt:null,dataset:{id:'paired-'+language+'-'+fingerprint.slice(0,8),name:`${pairs.length} 道配对题 · ${language==='zh'?'中文':'英文'} · 三模型重测`,fingerprint},bankFingerprint:fingerprint,questionSnapshots:snapshots,
  total:pairs.length*providers.length,questionIds:pairs.map(p=>p.id),providers,modes:['choice'],options:{gate:0,noulThreshold:.5,scoreThreshold:.75,instructions:''},concurrency:1,withDescriptions:0,
  config:Object.fromEntries(providers.map(p=>[p,{endpoint:configs[p].endpoint,model:configs[p].model}])),results:[],summary:summarize([]),timings:[],wallMs:null,
  benchmark:{language,fingerprint,runner:'scripts/benchmark-paired.mjs',warmup:true},
 };
 const save=async()=>{run.summary=summarize(run.results);run.wallMs=Math.round(performance.now()-runStarted);await store.write('runs/'+id+'.json',run);};
 await save();
 for(const provider of providers){
  const began=performance.now(),timing={provider,mode:'choice',planned:pairs.length,attempted:0,success:0,errors:0,wallMs:null,requestMs:0,status:'running',startedAt:new Date().toISOString(),finishedAt:null,concurrency:1};
  run.timings.push(timing);let consecutiveErrors=0;
  for(let i=0;i<pairs.length;i++){
   const pair=pairs[i],q=snapshots[i],{model:unused,...payload}=pair[language+'Request'];
   const result={id:randomUUID(),questionId:pair.id,subject:1,questionType:pair.questionType,provider,mode:'choice',inputKind:'text',request:{model:configs[provider].model,...payload},createdAt:new Date().toISOString()};
   const tick=performance.now();timing.attempted++;
   try{
    const response=await callProvider(provider,configs[provider],payload);
    Object.assign(result,response,{actualModel:response.rawResponse.model??null,usage:response.rawResponse.usage??null});
    if(provider==='laya'&&response.rawResponse.routing?.model!=='multilingual')throw Error('Laya checkpoint drift');
    if(provider==='startlux'&&response.rawResponse.model!=='StartLux-Decision-4B-Q8_0')throw Error('StartLux model drift');
    Object.assign(result,{status:'ok'},interpret(q,'choice',response.rawResponse,run.options));timing.success++;consecutiveErrors=0;
   }catch(error){
    Object.assign(result,{status:'error',error:error.message,httpStatus:error.httpStatus??null,durationMs:Math.round(performance.now()-tick)});timing.errors++;consecutiveErrors++;
   }
   run.results.push(result);timing.requestMs+=result.durationMs;timing.wallMs=Math.round(performance.now()-began);await save();
   if((i+1)%50===0||i===pairs.length-1)console.log(JSON.stringify({language,provider,completed:i+1,correct:run.results.filter(r=>r.provider===provider&&r.correct).length,errors:timing.errors,wallMs:timing.wallMs}));
   if([401,403].includes(result.httpStatus)||consecutiveErrors>=3){
    run.status='failed';run.stopReason='Authentication failure or three consecutive failures; no automatic retries.';timing.status='failed';run.finishedAt=timing.finishedAt=new Date().toISOString();await save();await writeFile(path.join(output,language+'-run.json'),JSON.stringify(run,null,2));throw Error(run.stopReason);
   }
  }
  timing.wallMs=Math.round(performance.now()-began);timing.finishedAt=new Date().toISOString();timing.status='completed';await save();
 }
 run.status='completed';run.finishedAt=new Date().toISOString();await save();
 await writeFile(path.join(output,language+'-run.json'),JSON.stringify(run,null,2));
 await writeFile(path.join(output,'protocol.json'),JSON.stringify(metadata,null,2));
}
for(const provider of providers)metadata.health[provider+'After']=(await checkProvider(provider,configs[provider])).rawResponse;
metadata.finishedAt=new Date().toISOString();await writeFile(path.join(output,'protocol.json'),JSON.stringify(metadata,null,2));
console.log('COMPLETED',JSON.stringify(metadata.runIds));
