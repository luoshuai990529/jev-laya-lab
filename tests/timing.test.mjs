import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunManager } from '../server/jobs.mjs';
import { ConfigStore } from '../server/providers.mjs';
import { DiskStore } from '../server/store.mjs';
import { selectQuestions, summarize } from '../server/decisions.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function makeBank(id='motorcycle', count=6) {
 const questions=Array.from({length:count},(_,i)=>({id:String(i+1),datasetId:id,subject:1,type:'单选题',question:id+' question '+(i+1),options:{A:'first',B:'second'},answer:'A',explanation:'private explanation',image_local:null}));
 return {questions,byId:new Map(questions.map(q=>[q.id,q])),fingerprint:id+'-fingerprint',metadata:{id,name:id==='motorcycle'?'摩托车题库':'自定义选择',fingerprint:id+'-fingerprint'}};
}
async function setup(t, {handler, delay=100, bank=makeBank(), datasets}={}) {
 const received=[];
 const server=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  const payload=JSON.parse(body);received.push(payload);
  if(handler)return handler(req,res,payload,received);
  await pause(delay);
  const answers={};for(const [id,q] of Object.entries(payload.questions)) {
   if(q.type==='choice')answers[id]={type:'choice',choice:'A',probabilities:{A:1,B:0}};
   if(q.type==='noul')answers[id]={type:'noul',noul:id==='opt_A'?.9:.1};
  }
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:payload.model,answers}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const dir=await mkdtemp(path.join(tmpdir(),'decision-timing-'));
 const store=new DiskStore(dir);await store.init();
 const config=new ConfigStore(store);await config.init();
 for(const provider of ['jev','laya'])await config.update({provider,endpoint:'http://127.0.0.1:'+server.address().port+'/v1/systemone',model:provider,key:provider==='jev'?'never-expose-this-key':''});
 const manager=new RunManager({bank,datasets,config,store,descriptions:{values:{}}});await manager.init();
 t.after(async()=>{await manager.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
 return {manager,received,store,bank};
}
async function settled(manager,id) {
 for(let i=0;i<300;i++){const run=manager.get(id);if(run.status!=='running')return run;await pause(10);}
 throw Error('run did not settle');
}

test('each provider and mode runs an independent same-order sample with concurrent wall time',async t=>{
 const {manager,received}=await setup(t);
 const start=await manager.start({filter:{count:6,seed:'timing'},providers:['jev','laya'],modes:['choice','noul'],concurrency:3});
 const run=await settled(manager,start.id);
 assert.equal(run.status,'completed');assert.equal(run.timings.length,4);
 assert.deepEqual(run.timings.map(g=>[g.provider,g.mode]),[['jev','choice'],['jev','noul'],['laya','choice'],['laya','noul']]);
 const requests=received.map(p=>({provider:p.model,mode:p.questions.pick?'choice':'noul',question:p.state.question}));
 for(const [i,g] of run.timings.entries()) {
  assert.equal(g.planned,6);assert.equal(g.attempted,6);assert.equal(g.success,6);assert.equal(g.errors,0);assert.equal(g.status,'completed');assert.equal(g.concurrency,3);
  assert(g.wallMs>=100,'group includes real request time');assert(g.wallMs<g.requestMs,'parallel elapsed time is less than sum of request durations');
  assert(g.startedAt&&g.finishedAt);assert.equal(g.requestMs,summarize(run.results.filter(r=>r.provider===g.provider&&r.mode===g.mode)).requestMs);
  assert.deepEqual(requests.slice(i*6,(i+1)*6).map(r=>r.question),requests.slice(0,6).map(r=>r.question));
  assert(requests.slice(i*6,(i+1)*6).every(r=>r.provider===g.provider&&r.mode===g.mode));
 }
 assert(run.wallMs>=run.timings.reduce((sum,g)=>sum+g.wallMs,0)-4);
 assert.equal(run.summary.requestMs,run.timings.reduce((sum,g)=>sum+g.requestMs,0));
 assert.equal(run.dataset.id,'motorcycle');assert.equal(run.dataset.fingerprint,'motorcycle-fingerprint');
 assert.equal(run.questionSnapshots.length,6);assert(!JSON.stringify(run).includes('never-expose-this-key'));
 for(const payload of received){assert(!('answer' in payload.state));assert(!('explanation' in payload.state));}
});

test('request time includes unsuccessful responses but legacy wall time stays unknown',()=>{
 const summary=summarize([{status:'ok',correct:true,retained:true,durationMs:100},{status:'error',durationMs:250}]);
 assert.equal(summary.requestMs,350);assert.equal(summary.errors,1);assert(!('wallMs' in summary));
 assert.equal(summarize([]).requestMs,0);
});

test('a run uses a deep snapshot of the chosen dataset through changes and restart',async t=>{
 const bank=makeBank(),custom=makeBank('custom',2),sources=new Map([['motorcycle',bank],['custom',custom]]);
 const {manager,received,store}=await setup(t,{bank,datasets:{get(id='motorcycle'){return sources.get(id);}},delay:40});
 manager.descriptions.values['1']='description from a motorcycle question with the same id';
 const start=await manager.start({datasetId:'custom',questionIds:['1','2'],providers:['laya'],modes:['choice'],concurrency:1});
 custom.questions[1].question='changed while running';custom.questions[1].answer='B';custom.metadata.name='changed name';custom.fingerprint='changed-fingerprint';
 const run=await settled(manager,start.id);
 assert.deepEqual(received.map(p=>p.state.question),['custom question 1','custom question 2']);
 assert(received.every(payload=>!('image_description' in payload.state)),'built-in image descriptions cannot cross dataset IDs');
 assert.equal(run.dataset.name,'自定义选择');assert.equal(run.dataset.fingerprint,'custom-fingerprint');assert.equal(run.summary.correct,2);
 assert.equal(run.questionSnapshots[1].answer,'A');assert.equal(run.questionSnapshots[1].question,'custom question 2');
 const reopened=new RunManager({bank,store,config:manager.config,descriptions:{values:{}},datasets:{get(){throw Error('dataset deleted');}}});await reopened.init();
 assert.deepEqual(reopened.get(run.id).questionSnapshots,run.questionSnapshots);assert.deepEqual(reopened.get(run.id).timings,run.timings);
 assert(!('questionSnapshots' in reopened.list()[0]),'listing excludes large historical question bodies');
});

test('failed responses are counted and fatal authentication stops all later groups',async t=>{
 const {manager,received}=await setup(t,{handler:async(_req,res)=>{await pause(30);res.writeHead(401,{'Content-Type':'application/json'});res.end('{"error":"invalid key"}');}});
 const run=await settled(manager,(await manager.start({filter:{count:6},providers:['jev','laya'],modes:['choice'],concurrency:1})).id);
 assert.equal(run.status,'failed');assert.equal(received.length,1);assert.equal(run.timings[0].status,'failed');
 assert.equal(run.timings[0].attempted,1);assert.equal(run.timings[0].success,0);assert.equal(run.timings[0].errors,1);
 assert(run.timings[0].requestMs>0);assert(run.timings[0].wallMs>0);assert.notEqual(run.timings[1].status,'completed');
 assert.equal(run.timings[1].attempted,0);assert.equal(run.timings[1].wallMs,null);
});

test('cancel preserves partial timing and does not schedule another model',async t=>{
 const {manager,received}=await setup(t,{delay:300});
 const id=(await manager.start({filter:{count:6},providers:['jev','laya'],modes:['choice'],concurrency:1})).id;
 while(!received.length)await pause(5);
 await pause(25);manager.cancel(id);
 const run=await settled(manager,id);
 assert.equal(run.status,'cancelled');assert.equal(received.length,1);assert.equal(run.timings[0].status,'cancelled');
 assert.equal(run.timings[0].attempted,1);assert.equal(run.timings[0].errors,1);assert(run.timings[0].wallMs>0);
 assert.equal(run.timings[1].attempted,0);assert.equal(run.timings[1].wallMs,null);assert(run.wallMs>0);
});

test('restarting interrupts unfinished timing without inventing time for old runs',async t=>{
 const {manager,store,bank}=await setup(t);
 await store.write('runs/legacy.json',{id:'legacy',status:'completed',createdAt:'2026-01-01T00:00:00Z',results:[]});
 await store.write('runs/unfinished.json',{id:'unfinished',status:'running',createdAt:'2026-01-02T00:00:00Z',wallMs:25,results:[],timings:[{provider:'jev',mode:'choice',status:'completed',wallMs:100},{provider:'laya',mode:'choice',status:'running',wallMs:25}]});
 const reopened=new RunManager({bank,store,config:manager.config,descriptions:{values:{}}});await reopened.init();
 const legacy=reopened.get('legacy');assert.equal(legacy.timings,undefined);assert.equal(legacy.wallMs,undefined);
 const interrupted=reopened.get('unfinished');assert.equal(interrupted.status,'interrupted');assert.equal(interrupted.wallMs,null);
 assert.equal(interrupted.timings[0].status,'completed');assert.equal(interrupted.timings[0].wallMs,100);
 assert.equal(interrupted.timings[1].status,'interrupted');assert.equal(interrupted.timings[1].wallMs,null);
});

test('selection and explicit question ids accept up to 10000 questions',async t=>{
 const bank=makeBank('motorcycle',1200),{manager}=await setup(t,{bank});
 assert.equal(selectQuestions(bank.questions,{count:10000}).length,1200);
 assert.equal(manager.plan({questionIds:bank.questions.map(q=>q.id),providers:['laya']}).questionIds.length,1200);
 assert.throws(()=>selectQuestions(bank.questions,{count:10001}),/数量/);
 const categories=[{...bank.questions[0],subject:'pricing'},{...bank.questions[1],subject:'support'}];
 assert.equal(selectQuestions(categories,{count:2,subject:'pricing'}).length,1);
});
