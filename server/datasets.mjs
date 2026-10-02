import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_INSTRUCTIONS } from './decisions.mjs';

export const GENERIC_INSTRUCTIONS='依据题干、选项和给定约束做出选择，注意题干的否定词。判断题判断题干命题是否正确，多选题选择全部且仅有符合题意的选项。仅评估给定信息，不把选项标签或措辞当作标准答案。';
export const MAX_QUESTIONS=10000;
const TYPES={single:'单选题',multiple:'多选题',boolean:'判断题'};
const fail=(location,message)=>{throw Error(`${location}：${message}`);};

function record(value,location,allowed) {
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail(location,'必须是 JSON 对象');
 if(allowed)for(const key of Object.keys(value))if(!allowed.includes(key))fail(location,`不支持字段 ${key}`);
 return value;
}
function text(value,location,max,{empty=false}={}) {
 if(typeof value!=='string')fail(location,'必须是字符串');
 const normalized=value.trim();
 if((!empty&&!normalized)||normalized.length>max)fail(location,`必须${empty?'不超过':'为 1–'}${max} 字`);
 return normalized;
}
function normalize(input) {
 record(input,'数据集',['schemaVersion','name','instructions','questions']);
 if(input.schemaVersion!==1)fail('schemaVersion','仅支持版本 1');
 const name=text(input.name,'name',100);
 const instructions=input.instructions===undefined?GENERIC_INSTRUCTIONS:text(input.instructions,'instructions',3000,{empty:true})||GENERIC_INSTRUCTIONS;
 if(!Array.isArray(input.questions)||input.questions.length<1||input.questions.length>MAX_QUESTIONS)fail('questions',`必须包含 1–${MAX_QUESTIONS} 道题`);
 const ids=new Set();
 const questions=input.questions.map((item,index)=>{
  const location=`questions[${index}]`;
  record(item,location,['id','type','question','options','answer','category','explanation']);
  const id=text(item.id,location+'.id',128);
  if(ids.has(id))fail(location+'.id','编号重复');ids.add(id);
  if(!Object.hasOwn(TYPES,item.type))fail(location+'.type','必须为 single、multiple 或 boolean');
  const question=text(item.question,location+'.question',5000);
  record(item.options,location+'.options');
  const keys=Object.keys(item.options).sort();
  if(keys.length<2||keys.length>7||keys.some((key,i)=>key!==String.fromCharCode(65+i)))fail(location+'.options','必须为 A 起始的 2–7 个连续字母键');
  const options=Object.fromEntries(keys.map(key=>[key,text(item.options[key],location+'.options.'+key,500)]));
  if(item.type==='boolean'&&(keys.length!==2||options.A!=='正确'||options.B!=='错误'))fail(location+'.options','boolean 固定为 A=正确、B=错误');
  if(!Array.isArray(item.answer)||!item.answer.length||item.answer.some(key=>typeof key!=='string'||!keys.includes(key))||new Set(item.answer).size!==item.answer.length)fail(location+'.answer','必须是非空且不重复的已有选项字母数组');
  if(item.type!=='multiple'&&item.answer.length!==1)fail(location+'.answer','single 和 boolean 必须恰好有一个正确答案');
  const answer=[...item.answer].sort();
  const category=item.category===undefined?'未分类':text(item.category,location+'.category',100);
  const explanation=item.explanation===undefined?'':text(item.explanation,location+'.explanation',5000,{empty:true});
  return {id,type:item.type,question,options,answer,category,explanation};
 });
 return {schemaVersion:1,name,instructions,questions};
}
function subjects(questions) {
 const counts=new Map();for(const q of questions)counts.set(q.category,(counts.get(q.category)??0)+1);
 return [...counts].map(([subject,count])=>({subject,count,label:subject}));
}
function importedBank(saved) {
 const {input,id,createdAt}=saved;
 const fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
 const questions=input.questions.map((q,index)=>({...q,number:index+1,type:TYPES[q.type],options:{...q.options},answer:q.answer.join(''),subject:q.category,datasetId:id,instructions:input.instructions,image_local:null}));
 const metadata={id,name:input.name,instructions:input.instructions,builtIn:false,total:questions.length,textOnly:questions.length,withImages:0,subjects:subjects(questions),savedDate:createdAt.slice(0,10),createdAt,fingerprint};
 return {questions,byId:new Map(questions.map(q=>[q.id,q])),fingerprint,metadata};
}

/** Local imported datasets are separate from the bundled example bank. */
export class DatasetStore {
 constructor({bank,store}) {
  this.store=store;this.saved=[];this.pending=Promise.resolve();
  const questions=bank.questions.map(q=>({...q,options:{...q.options},datasetId:'motorcycle',category:q.subject===1?'科目一':'科目四',instructions:DEFAULT_INSTRUCTIONS}));
  const metadata={...bank.metadata,id:'motorcycle',name:'摩托车科目一与科目四',instructions:DEFAULT_INSTRUCTIONS,builtIn:true,fingerprint:bank.fingerprint,subjects:bank.metadata.subjects.map(s=>({...s,label:s.subject===1?'科目一':'科目四'}))};
  this.banks=new Map([['motorcycle',{...bank,questions,byId:new Map(questions.map(q=>[String(q.id),q])),metadata}]]);
 }
 async init() {
  const disk=await this.store.read('datasets.json',{schemaVersion:1,datasets:[]});
  record(disk,'本地数据集存储',['schemaVersion','datasets']);
  if(disk.schemaVersion!==1||!Array.isArray(disk.datasets))fail('本地数据集存储','格式或版本无效');
  const restored=[],banks=new Map([['motorcycle',this.banks.get('motorcycle')]]);
  for(const entry of disk.datasets){
   record(entry,'本地数据集',['id','createdAt','input']);
   const id=text(entry.id,'本地数据集.id',128),createdAt=text(entry.createdAt,'本地数据集.createdAt',32);
   if(id==='motorcycle'||banks.has(id))fail('本地数据集.id','不允许覆盖或重复编号');
   if(!Number.isFinite(Date.parse(createdAt)))fail('本地数据集.createdAt','日期无效');
   const saved={id,createdAt,input:normalize(entry.input)};restored.push(saved);banks.set(id,importedBank(saved));
  }
  this.saved=restored;this.banks=banks;
  return this;
 }
 list() {return [...this.banks.values()].map(bank=>structuredClone(bank.metadata));}
 get(id='motorcycle') {
  const bank=this.banks.get(id);if(!bank)fail('数据集','不存在');return bank;
 }
 import(input) {
  // Validate and copy before queuing any write, so malformed input has no side effects.
  let normalized;try{normalized=normalize(input);}catch(error){return Promise.reject(error);}
  const operation=this.pending.then(async()=>{
   const saved={id:'dataset-'+randomUUID(),createdAt:new Date().toISOString(),input:normalized},bank=importedBank(saved),next=[...this.saved,saved];
   await this.store.write('datasets.json',{schemaVersion:1,datasets:next});
   this.saved=next;this.banks.set(saved.id,bank);
   return structuredClone(bank.metadata);
  });
  this.pending=operation.catch(()=>{});return operation;
 }
}
