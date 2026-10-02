import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DiskStore } from '../server/store.mjs';
import { DatasetStore, GENERIC_INSTRUCTIONS } from '../server/datasets.mjs';

function bank() {
 const question={id:'same-id',subject:1,type:'单选题',question:'内置题目',options:{A:'是',B:'否'},answer:'A',image_local:null};
 return {questions:[question],byId:new Map([[question.id,question]]),fingerprint:'builtin-fingerprint',metadata:{total:1,textOnly:1,withImages:0,subjects:[{subject:1,count:1},{subject:4,count:0}],savedDate:'2026-09-29'}};
}
function data() {
 return {schemaVersion:1,name:'运营决策',questions:[{id:'same-id',type:'single',question:'哪个方案适合？',options:{A:'方案一',B:'方案二'},answer:['B'],category:'运营',explanation:'方案二满足约束'}, {id:'subset',type:'multiple',question:'哪些操作可执行？',options:{A:'检查',B:'校验',C:'删除'},answer:['B','A']}, {id:'truth',type:'boolean',question:'确认已备份。',options:{A:'正确',B:'错误'},answer:['A']}]};
}
async function setup(t) {
 const dir=await mkdtemp(path.join(tmpdir(),'datasets-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=new DiskStore(dir);await store.init();
 const original=bank(),datasets=new DatasetStore({bank:original,store});await datasets.init();
 return {dir,store,datasets,original};
}
test('builtin and imported IDs are isolated, categories and model instructions are normalized',async t=>{
 const {datasets,original}=await setup(t);
 const meta=await datasets.import(data());
 assert.equal(meta.name,'运营决策');assert.equal(meta.total,3);assert.equal(meta.textOnly,3);assert.equal(meta.withImages,0);assert.equal(meta.builtIn,false);
 assert.deepEqual(meta.subjects,[{subject:'运营',count:1,label:'运营'},{subject:'未分类',count:2,label:'未分类'}]);
 const imported=datasets.get(meta.id);assert.equal(imported.byId.get('same-id').answer,'B');assert.equal(imported.byId.get('subset').answer,'AB');
 assert.equal(imported.byId.get('subset').type,'多选题');assert.equal(imported.byId.get('truth').type,'判断题');assert.equal(imported.questions[0].datasetId,meta.id);assert.equal(imported.questions[0].subject,'运营');assert.equal(imported.questions[0].instructions,GENERIC_INSTRUCTIONS);
 assert.equal(datasets.get().byId.get('same-id').answer,'A');assert.equal(datasets.get().metadata.id,'motorcycle');assert.equal(datasets.get().metadata.builtIn,true);
 assert(!Object.hasOwn(original.questions[0],'datasetId'));assert(!Object.hasOwn(original.metadata,'id'));
 assert.throws(()=>datasets.get('missing'),/数据集/);
});
test('invalid imports reject with a question path and leave memory and disk unchanged',async t=>{
 const {datasets,dir}=await setup(t);await datasets.import(data());
 const before=datasets.list(),disk=await readFile(path.join(dir,'datasets.json'),'utf8');
 const cases=[
  [x=>x.extra=true,/extra/],
  [x=>x.questions[0].source='secret',/questions\[0\].*source/],
  [x=>x.questions[0].image_local='image.png',/questions\[0\].*image_local/],
  [x=>x.questions[1].id='same-id',/questions\[1\].id/],
  [x=>x.questions[0].answer=['C'],/questions\[0\].answer/],
  [x=>x.questions[0].answer=['A','B'],/questions\[0\].answer/],
  [x=>x.questions[1].answer=['A','A'],/questions\[1\].answer/],
  [x=>x.questions[2].options.B='否',/questions\[2\].options/],
  [x=>x.questions[0].options={A:'一',C:'三'},/questions\[0\].options/],
  [x=>x.questions[0].options={A:'一',B:'二',__proto__:{hidden:'x'}},/questions\[0\].options/],
  [x=>x.questions[0].type='choice',/questions\[0\].type/],
  [x=>x.questions[0].question='x'.repeat(5001),/questions\[0\].question/],
  [x=>x.instructions='x'.repeat(3001),/instructions/],
  [x=>x.questions[0].options.B='x'.repeat(501),/questions\[0\].options.B/],
  [x=>x.questions=Array.from({length:10001},(_,i)=>({...x.questions[0],id:String(i)})),/questions/],
 ];
 for(const [modify,pattern] of cases){const candidate=data();modify(candidate);await assert.rejects(datasets.import(candidate),pattern);assert.deepEqual(datasets.list(),before);assert.equal(await readFile(path.join(dir,'datasets.json'),'utf8'),disk);}
});
test('saved datasets restore exactly and equivalent answer ordering has the same fingerprint',async t=>{
 const {datasets,store}=await setup(t);
 const input=data();input.instructions='  按预算与风险作答。  ';const a=await datasets.import(input);
 const equivalent=data();equivalent.instructions='按预算与风险作答。';equivalent.questions[1].answer=['A','B'];const b=await datasets.import(equivalent);
 assert.notEqual(a.id,b.id);assert.equal(a.fingerprint,b.fingerprint);
 const reopened=new DatasetStore({bank:bank(),store});await reopened.init();
 assert.deepEqual(reopened.list(),datasets.list());assert.deepEqual(reopened.get(a.id).questions,datasets.get(a.id).questions);assert.equal(reopened.get(a.id).metadata.instructions,'按预算与风险作答。');
});
test('failed writes never publish a dataset, and concurrent imports do not overwrite each other',async t=>{
 const {datasets,store}=await setup(t);const write=store.write.bind(store);let reject=true;
 store.write=async(...args)=>{if(reject)throw Error('disk failure');return write(...args);};
 await assert.rejects(datasets.import(data()),/disk failure/);assert.equal(datasets.list().length,1);
 reject=false;const [a,b]=await Promise.all([datasets.import(data()),datasets.import({...data(),name:'第二份'})]);assert.equal(datasets.list().length,3);
 const reopened=new DatasetStore({bank:bank(),store});await reopened.init();assert.equal(reopened.list().length,3);assert.equal(reopened.get(a.id).metadata.name,'运营决策');assert.equal(reopened.get(b.id).metadata.name,'第二份');
});
