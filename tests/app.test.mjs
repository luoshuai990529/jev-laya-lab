import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { createApp }=await import('../server/app.mjs').catch(()=>({}));
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function listen(server){await new Promise(r=>server.listen(0,'127.0.0.1',r));return 'http://127.0.0.1:'+server.address().port;}
async function fixture(fn){
 const requests=[];
 const server=http.createServer(async(req,res)=>{
  let b='';for await(const x of req)b+=x;
  if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({models:[{name:'fixture-checkpoint'}],status:'ok'}));return;}
  const payload=JSON.parse(b);requests.push({payload,auth:req.headers.authorization});
  if(fn)return fn(req,res,payload);
  const answers={};for(const [id,q] of Object.entries(payload.questions)){
   if(q.type==='choice'){const c=Object.keys(q.criteria)[0];answers[id]={type:'choice',choice:c,confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k===c?1:0]))};}
   if(q.type==='noul')answers[id]={type:'noul',noul:.8};
   if(q.type==='score')answers[id]={type:'score',score:3,probabilities:{0:0,1:0,2:0,3:1,4:0},confidence:1,legend:{0:'0',1:'1',2:'2',3:'3',4:'4'}};
  }
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:'fixture-checkpoint',answers,usage:{input_tokens:42,output_tokens:0}}));
 });
 return {server,url:await listen(server),requests};
}
async function setup(t,fn){
 assert.equal(typeof createApp,'function','local app factory must exist');
 const fake=await fixture(fn),localDir=await mkdtemp(path.join(tmpdir(),'decision-lab-'));
 const app=await createApp({root,localDir}),url=await listen(app.server);
 t.after(async()=>{await app.close();fake.server.closeAllConnections();await new Promise(r=>fake.server.close(r));});
 const call=async(p,body,extra={})=>{const res=await fetch(url+p,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body)});return {status:res.status,data:await res.json()};};
 return {app,url,call,fake,localDir};
}
async function wait(call,id){for(let i=0;i<100;i++){const x=(await call('/api/runs/'+id)).data;if(x.status!=='running')return x;await new Promise(r=>setTimeout(r,20));}throw Error('job did not settle');}
test('configuration never exposes keys and only remembers them by explicit choice',async t=>{
 const {call,localDir,fake}=await setup(t);
 let x=await call('/api/config',{provider:'jev',endpoint:fake.url+'/v1/systemone',model:'fixture',key:'private-test-key',remember:false});
 assert.equal(x.status,200);assert.equal(x.data.jev.hasKey,true);assert(!JSON.stringify(x.data).includes('private-test-key'));
 assert(!((await readFile(path.join(localDir,'config.json'),'utf8')).includes('private-test-key')));
 x=await call('/api/config',{provider:'jev',remember:true});
 assert((await readFile(path.join(localDir,'config.json'),'utf8')).includes('private-test-key'));
 assert.equal((await stat(path.join(localDir,'config.json'))).mode & 0o777,0o600);
 await call('/api/config',{provider:'jev',clearKey:true});assert(!(await readFile(path.join(localDir,'config.json'),'utf8')).includes('private-test-key'));
});
test('endpoint validation prevents accidental key transport over plain remote HTTP',async t=>{
 const {call}=await setup(t);
 assert.equal((await call('/api/config',{provider:'jev',endpoint:'http://remote.example/v1/systemone',key:'secret'})).status,400);
 assert.equal((await call('/api/config',{provider:'jev',endpoint:'file:///tmp/x'})).status,400);
});
test('batch calls both providers on exactly the same sample without answer leakage',async t=>{
 const {call,fake}=await setup(t);
 await call('/api/config',{provider:'jev',endpoint:fake.url+'/v1/systemone',key:'private-test-key'});
 await call('/api/config',{provider:'laya',endpoint:fake.url+'/v1/systemone'});
 const body={filter:{count:3,seed:'fixture',subject:'all',images:'text'},providers:['jev','laya'],modes:['choice','noul','score','mixed'],options:{gate:.5},concurrency:2};
 const preview=await call('/api/preview',body);assert.equal(preview.data.total,24);
 const start=await call('/api/runs',body);assert.equal(start.status,201);
 const run=await wait(call,start.data.id);assert.equal(run.status,'completed');assert.equal(run.results.length,24);assert.equal(run.summary.errors,0);
 assert.equal(fake.requests.length,24);assert.equal(run.summary.success,24);
 assert(!JSON.stringify(run).includes('private-test-key'));
 for(const {payload} of fake.requests){assert(!('answer' in payload.state));assert(!('explanation' in payload.state));assert(!('source_url' in payload.state));}
 assert.deepEqual(new Set(run.results.filter(x=>x.provider==='jev').map(x=>x.questionId)),new Set(run.results.filter(x=>x.provider==='laya').map(x=>x.questionId)));
 const history=(await call('/api/runs')).data;assert.equal(history.length,1);assert.equal(history[0].id,run.id);
});
test('authentication failures halt the remaining paid requests and preserve the error',async t=>{
 const {call,fake}=await setup(t,(_req,res)=>{res.writeHead(401,{'Content-Type':'application/json'});res.end('{"error":"invalid key"}');});
 await call('/api/config',{provider:'jev',endpoint:fake.url+'/v1/systemone',key:'wrong-test-key'});
 const run=await wait(call,(await call('/api/runs',{filter:{count:20},providers:['jev'],modes:['choice'],concurrency:1})).data.id);
 assert.equal(run.status,'failed');assert.equal(fake.requests.length,1);assert.equal(run.results[0].httpStatus,401);assert.equal(run.summary.accuracy,null);
});
test('cancel stops scheduling and a disk run survives a fresh app instance',async t=>{
 const {call,app,fake,localDir}=await setup(t,(_req,res,payload)=>{setTimeout(()=>res.end(JSON.stringify({model:'fixture',answers:{pick:{type:'choice',choice:'A',probabilities:{A:1},confidence:1}}})),400);});
 await call('/api/config',{provider:'laya',endpoint:fake.url+'/v1/systemone'});
 const id=(await call('/api/runs',{filter:{count:20},providers:['laya'],modes:['choice'],concurrency:1})).data.id;
 await new Promise(r=>setTimeout(r,40));await call('/api/runs/'+id+'/cancel',{});
 const run=await wait(call,id);assert.equal(run.status,'cancelled');assert(fake.requests.length<=1);
 await app.flush();const reopened=await createApp({root,localDir});t.after(()=>reopened.close());assert.equal(reopened.manager.get(id).status,'cancelled');
});
test('cross-origin writes, unavailable providers and unknown questions are rejected',async t=>{
 const {call}=await setup(t);
 assert.equal((await call('/api/config',{provider:'jev'}, {Origin:'https://attacker.example'})).status,403);
 assert.equal((await call('/api/runs',{filter:{count:1},providers:['jev'],modes:['choice']})).status,400);
 assert.equal((await call('/api/preview',{questionIds:['missing'],providers:['laya'],modes:['choice']})).status,400);
});
test('custom typed playground handles mixed primitives without grading as exam results',async t=>{
 const {call,fake}=await setup(t);await call('/api/config',{provider:'laya',endpoint:fake.url+'/v1/systemone'});
 const x=await call('/api/playground',{provider:'laya',state:'骑车前佩戴头盔',questions:{safe:{type:'noul',instructions:'是否佩戴头盔？'}}});
 assert.equal(x.status,200);assert.equal(x.data.rawResponse.answers.safe.noul,.8);assert.equal(x.data.rawResponse.model,'fixture-checkpoint');assert(!('correct' in x.data));
 assert.equal((await call('/api/runs')).data.length,0);
});
test('simultaneous starts reserve exactly one active job',async t=>{
 const {call,fake}=await setup(t,(_req,res)=>{setTimeout(()=>res.end('{"model":"fixture","answers":{"pick":{"type":"choice","choice":"A","probabilities":{"A":1},"confidence":1}}}'),150);});
 await call('/api/config',{provider:'laya',endpoint:fake.url+'/v1/systemone'});
 const body={filter:{count:2},providers:['laya'],modes:['choice']};
 const starts=await Promise.all([call('/api/runs',body),call('/api/runs',body)]);
 assert.deepEqual(starts.map(r=>r.status).sort(),[201,400]);
});
test('invalid model response is retained for inspection and excluded from accuracy',async t=>{
 const {call,fake}=await setup(t,(_req,res)=>res.end('{"model":"fixture-bad","answers":{"pick":{"type":"choice","choice":"Z","probabilities":{"Z":1}}}}'));
 await call('/api/config',{provider:'laya',endpoint:fake.url+'/v1/systemone'});
 const run=await wait(call,(await call('/api/runs',{filter:{count:1},providers:['laya'],modes:['choice']})).data.id);
 assert.equal(run.summary.success,0);assert.equal(run.summary.errors,1);assert.equal(run.results[0].rawResponse.model,'fixture-bad');
});
test('dataset imports validate atomically, stay isolated, and persist with snapshot history',async t=>{
 const {call,fake,localDir}=await setup(t);
 const input={schemaVersion:1,name:'客服分类',instructions:'根据用户请求选择部门',questions:[{id:'10',type:'single',category:'客服',question:'希望退款',options:{A:'账单',B:'技术'},answer:['A'],explanation:'不发送的解析'}]};
 const imported=await call('/api/datasets',input);assert.equal(imported.status,201);
 const id=imported.data.id;assert(id);assert.equal((await call('/api/datasets')).data.length,2);
 assert.equal((await call('/api/questions?datasetId='+id)).data[0].question,'希望退款');
 const bad=await call('/api/datasets',{...input,questions:[{...input.questions[0],answer:['Z']}]});assert.equal(bad.status,400);
 assert.equal((await call('/api/datasets')).data.length,2);
 const preview=await call('/api/preview',{datasetId:id,questionIds:['10'],providers:['laya'],modes:['choice']});
 assert.equal(preview.status,200);assert.equal(preview.data.dataset.id,id);
 assert(!JSON.stringify(preview.data).includes('不发送的解析'));assert(!('questionSnapshots' in preview.data));
 await call('/api/config',{provider:'laya',endpoint:fake.url+'/v1/systemone'});
 const run=await wait(call,(await call('/api/runs',{datasetId:id,questionIds:['10'],providers:['laya'],modes:['choice']})).data.id);
 assert.equal(run.results[0].correct,true);assert.equal(run.questionSnapshots[0].question,'希望退款');
 assert(!JSON.stringify(fake.requests).includes('不发送的解析'));assert(!JSON.stringify(fake.requests).includes('摩托车'));
 const reopened=await createApp({root,localDir});t.after(()=>reopened.close());
 assert.equal(reopened.datasets.get(id).metadata.name,'客服分类');assert.equal(reopened.manager.get(run.id).dataset.id,id);
});
test('custom question ids cannot inherit a bundled image description',async t=>{
 const {call,app}=await setup(t);
 const imageQuestion=app.bank.questions.find(q=>q.image_local);
 await call('/api/descriptions',{questionId:imageQuestion.id,description:'默认摩托车图片的独有描述'});
 const imported=await call('/api/datasets',{schemaVersion:1,name:'相同编号',questions:[{id:String(imageQuestion.id),type:'single',question:'选择部门',options:{A:'客服',B:'财务'},answer:['A']}]});
 const preview=await call('/api/preview',{datasetId:imported.data.id,questionIds:[imageQuestion.id],providers:['laya']});
 assert.equal(preview.status,200);
 assert(!('image_description' in preview.data.requests[0].request.state));
 assert(!JSON.stringify(preview.data).includes('独有描述'));
});
