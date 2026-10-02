import { randomUUID } from 'node:crypto';
import { compileQuestion, interpret, MODES, summarize, selectQuestions, thresholds } from './decisions.mjs';
import { callProvider, ready } from './providers.mjs';

const timestamp=()=>new Date().toISOString();
const elapsed=start=>Math.round(performance.now()-start);

export class RunManager {
 constructor({bank,datasets,config,store,descriptions}) {
  Object.assign(this,{bank,datasets,config,store,descriptions});this.runs=new Map();this.active=null;
 }
 async init() {
  for(const run of await this.store.runs()) {
   if(run.status==='running') {
    run.status='interrupted';run.finishedAt=timestamp();run.stopReason='本地服务重启，已保存结果，不自动重复请求';
    // A restart cannot recover the elapsed end of an unfinished monotonic clock.
    if(Object.hasOwn(run,'wallMs'))run.wallMs=null;
    for(const group of run.timings??[])if(['running','pending'].includes(group.status)) {
     group.status='interrupted';group.finishedAt=run.finishedAt;group.wallMs=null;
    }
    await this.store.write('runs/'+run.id+'.json',run);
   }
   this.runs.set(run.id,run);
  }
 }
 plan(body,requireReady=false) {
  const providers=body.providers??['jev'],modes=body.modes??['choice'];
  const options={...thresholds(body.options),instructions:String(body.options?.instructions??'')};
  if(!Array.isArray(providers)||!providers.length||providers.length>2||new Set(providers).size!==providers.length||providers.some(p=>!['jev','laya'].includes(p)))throw Error('请选择 Jev、Laya 或两者');
  if(!Array.isArray(modes)||!modes.length||new Set(modes).size!==modes.length||modes.some(m=>!MODES.includes(m)))throw Error('请选择有效的答题模式');
  const concurrency=body.concurrency??1;
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw Error('并发数应为 1–4 的整数');
  const datasetId=body.datasetId??'motorcycle';
  const source=this.datasets?this.datasets.get(datasetId):datasetId==='motorcycle'?this.bank:null;
  if(!source)throw Error('数据集不存在：'+datasetId);
  // Snapshot once at planning time: neither an import nor a UI dataset switch can change a run.
  const questionsSnapshot=structuredClone(source.questions),metadata=structuredClone(source.metadata??{});
  const bank={questions:questionsSnapshot,byId:new Map(questionsSnapshot.map(q=>[String(q.id),q])),fingerprint:source.fingerprint,metadata};
  const dataset={id:datasetId,name:metadata.name??source.name??'摩托车题库',fingerprint:bank.fingerprint};
  const descriptions=datasetId==='motorcycle'?this.descriptions.values:{};
  let questions;
  if(body.questionIds!==undefined) {
   if(!Array.isArray(body.questionIds)||!body.questionIds.length||body.questionIds.length>10000||new Set(body.questionIds.map(String)).size!==body.questionIds.length)throw Error('题目编号列表无效');
   questions=body.questionIds.map(id=>{const q=bank.byId.get(String(id));if(!q)throw Error('题目不存在：'+id);return q;});
  }else questions=selectQuestions(bank.questions,body.filter,descriptions);
  if(!questions.length)throw Error('没有符合条件的题目，请更换筛选条件或补充图片描述');
  const configs=Object.fromEntries(providers.map(provider=>{
   const config=this.config.snapshot(provider);if(requireReady)ready(provider,config);return [provider,config];
  }));
  const cases=[];
  for(const q of questions)for(const mode of modes) {
   const perQuestion={...options,imageDescription:descriptions[q.id]??''};
   const payload=compileQuestion(q,mode,perQuestion);
   for(const provider of providers)cases.push({questionId:q.id,q,provider,mode,options:perQuestion,payload});
  }
  return {bank,dataset,questionSnapshots:questions,cases,configs,providers,modes,options,concurrency,filter:structuredClone(body.filter??null),questionIds:questions.map(q=>q.id),total:cases.length,withDescriptions:questions.filter(q=>q.image_local).length,preview:cases[0]?.payload};
 }
 async start(body) {
  if(this.active)throw Error('已有测试正在运行，请等待完成或取消');
  const plan=this.plan(body,true),id=randomUUID(),began=performance.now();
  const timings=plan.providers.flatMap(provider=>plan.modes.map(mode=>({provider,mode,planned:plan.questionIds.length,attempted:0,success:0,errors:0,wallMs:null,requestMs:0,status:'pending',startedAt:null,finishedAt:null,concurrency:plan.concurrency})));
  const run={id,status:'running',createdAt:timestamp(),finishedAt:null,dataset:plan.dataset,bankFingerprint:plan.dataset.fingerprint,questionSnapshots:plan.questionSnapshots,total:plan.total,questionIds:plan.questionIds,filter:plan.filter,providers:plan.providers,modes:plan.modes,options:plan.options,concurrency:plan.concurrency,withDescriptions:plan.withDescriptions,timings,wallMs:null,config:Object.fromEntries(plan.providers.map(provider=>{const c=plan.configs[provider];return [provider,{endpoint:c.endpoint,model:c.model}];})),results:[],summary:summarize([])};
  const controller=new AbortController();this.active={id,controller,promise:null};
  try{await this.store.write('runs/'+id+'.json',run);}catch(error){this.active=null;throw error;}
  this.runs.set(id,run);
  this.active.promise=this.execute(run,plan,controller,began).catch(async error=>{
   controller.abort();run.status='failed';run.finishedAt=timestamp();run.wallMs=elapsed(began);run.stopReason='结果保存失败：'+error.message;
   for(const group of run.timings)if(group.status==='running') {group.status='failed';group.finishedAt=run.finishedAt;}
   else if(group.status==='pending') {group.status='cancelled';group.finishedAt=run.finishedAt;}
   try{await this.store.write('runs/'+id+'.json',run);}catch{/* The in-memory failure remains readable if the disk is unavailable. */}
   if(this.active?.id===id)this.active=null;
  });
  return {id,total:plan.total,status:run.status};
 }
 async execute(run,plan,controller,runStarted=performance.now()) {
  let fatal=false;
  // Independent groups avoid counting another provider's queue wait as model time.
  for(const group of run.timings) {
   if(controller.signal.aborted)break;
   const cases=plan.cases.filter(item=>item.provider===group.provider&&item.mode===group.mode);
   const groupStarted=performance.now();let cursor=0;
   group.status='running';group.startedAt=timestamp();
   await this.store.write('runs/'+run.id+'.json',run);
   const work=async()=>{
    while(!controller.signal.aborted&&cursor<cases.length) {
     const item=cases[cursor++],q=item.q,began=performance.now();group.attempted++;
     let result={id:randomUUID(),questionId:q.id,subject:q.subject,questionType:q.type,provider:item.provider,mode:item.mode,inputKind:q.image_local?'manual_image_description':'text',request:{model:plan.configs[item.provider].model,...item.payload},createdAt:timestamp()};
     try {
      const response=await callProvider(item.provider,plan.configs[item.provider],item.payload,controller.signal);
      result={...result,...response,actualModel:response.rawResponse.model??null,usage:response.rawResponse.usage??null};
      result={...result,status:'ok',...interpret(q,item.mode,response.rawResponse,item.options)};
     }catch(error) {
      result={...result,status:'error',error:error.message,httpStatus:error.httpStatus??null,durationMs:elapsed(began)};
      if([401,403].includes(error.httpStatus)) {
       fatal=true;run.stopReason='认证失败，已停止剩余请求，请检查模型配置';controller.abort();
      }
     }
     run.results.push(result);run.summary=summarize(run.results);
     if(result.status==='ok')group.success++;else group.errors++;
     group.requestMs+=Number.isFinite(result.durationMs)?result.durationMs:0;
     group.wallMs=elapsed(groupStarted);run.wallMs=elapsed(runStarted);
     try{await this.store.write('runs/'+run.id+'.json',run);}catch(error){controller.abort();throw error;}
    }
   };
   // Wait for every worker, including aborted in-flight requests, before releasing the active run.
   const workers=await Promise.allSettled(Array.from({length:plan.concurrency},work));
   group.wallMs=elapsed(groupStarted);group.finishedAt=timestamp();
   const rejected=workers.find(worker=>worker.status==='rejected');
   if(rejected){group.status='failed';throw rejected.reason;}
   group.status=fatal?'failed':controller.signal.aborted?'cancelled':'completed';
   run.wallMs=elapsed(runStarted);
   await this.store.write('runs/'+run.id+'.json',run);
  }
  run.status=fatal?'failed':controller.signal.aborted?'cancelled':'completed';run.finishedAt=timestamp();run.wallMs=elapsed(runStarted);
  if(run.status==='cancelled')run.stopReason='用户停止了测试，已保留完成的结果';
  for(const group of run.timings)if(group.status==='pending'){group.status='cancelled';group.finishedAt=run.finishedAt;}
  await this.store.write('runs/'+run.id+'.json',run);
  if(this.active?.id===run.id)this.active=null;
 }
 cancel(id){const run=this.get(id);if(this.active?.id===id)this.active.controller.abort();return {id,status:run.status};}
 get(id){const run=this.runs.get(id);if(!run)throw Error('测试记录不存在');return structuredClone(run);}
 list(){return [...this.runs.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(({results,questionSnapshots,...run})=>structuredClone(run));}
 async close(){if(this.active){this.active.controller.abort();await this.active.promise;}}
}
