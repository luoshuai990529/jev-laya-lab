import { test } from 'node:test';
import assert from 'node:assert/strict';
const { compileQuestion, interpret, summarize, selectQuestions } = await import('../server/decisions.mjs').catch(() => ({}));
const single = { id:'10', subject:1, type:'单选题', question:'驾驶摩托车应当佩戴什么？', options:{A:'安全头盔', B:'帽子', C:'护目镜', D:'耳机'}, answer:'A', explanation:'秘密解析', source_url:'秘密地址' };
const multi = { ...single, id:'20', type:'多选题', answer:'AC' };
const judge = { ...single, id:'30', type:'判断题', question:'驾驶时必须佩戴安全头盔。', options:{A:'正确',B:'错误'}, answer:'A' };
const choice = (c='A',p={A:.8,B:.1,C:.06,D:.04}) => ({type:'choice',choice:c,probabilities:p,confidence:.72});
test('custom datasets use their own domain and instructions without exam context',()=>{
 const q={...single,datasetId:'custom',subject:'客服',category:'客服',instructions:'按客服规则分类',question:'用户请求退款'};
 const r=compileQuestion(q,'choice');
 assert.equal(r.state.category,'客服');assert(!('subject' in r.state));
 assert.match(r.questions.pick.instructions,/客服规则/);assert(!JSON.stringify(r).includes('摩托车'));
 assert(!JSON.stringify(r).includes('秘密'));
});
test('requests whitelist model input and never contain answers or explanations', () => {
 assert.equal(typeof compileQuestion,'function');
 const r=compileQuestion(single,'choice');
 assert.deepEqual(r.state,{subject:'摩托车科目一',question:single.question,options:single.options});
 assert.equal(r.questions.pick.type,'choice');assert.deepEqual(r.questions.pick.criteria,single.options);
 assert(!JSON.stringify(r).includes('秘密'));assert(!('answer' in r.state));
});
test('image questions require a manual description and pass only that text', () => {
 assert.equal(typeof compileQuestion,'function');
 assert.throws(()=>compileQuestion({...single,image_local:'media/x.jpg'},'choice'),/图片描述/);
 const r=compileQuestion({...single,image_local:'media/x.jpg'},'choice',{imageDescription:'蓝底圆形的头盔标志'});
 assert.equal(r.state.image_description,'蓝底圆形的头盔标志');assert(!JSON.stringify(r).includes('media/'));
});
test('Choice multi-select candidates cover nonempty sets without leaking expected set', () => {
 assert.equal(typeof compileQuestion,'function'); const q=compileQuestion(multi,'choice');
 assert.equal(Object.keys(q.questions.pick.criteria).length,15);
 assert.equal(q.questions.pick.criteria.AC,'A. 安全头盔；C. 护目镜');
 assert.equal(interpret(multi,'choice',{answers:{pick:choice('CA',{CA:1})}}).selected,'AC');
});
test('Noul judgement treats the original proposition as true, not the option label',()=>{
 assert.equal(typeof compileQuestion,'function'); const r=compileQuestion(judge,'noul');
 assert.equal(Object.keys(r.questions).length,1);assert.match(r.questions.truth.instructions,/题干/);
 const result=interpret(judge,'noul',{answers:{truth:{type:'noul',noul:.1}}});
 assert.equal(result.selected,'B');assert.equal(result.correct,false);assert.equal(result.support,.9);
});
test('single Noul uses argmax, multi uses threshold and supports empty selection',()=>{
 assert.equal(typeof interpret,'function');
 const a={answers:{opt_A:{type:'noul',noul:.7},opt_B:{type:'noul',noul:.1},opt_C:{type:'noul',noul:.8},opt_D:{type:'noul',noul:.4}}};
 assert.equal(interpret(single,'noul',a).selected,'C');
 assert.equal(interpret(multi,'noul',a,{noulThreshold:.5}).selected,'AC');
 assert.equal(interpret(multi,'noul',a,{noulThreshold:.9}).selected,'');
 assert.equal(interpret(multi,'noul',a).correct,true);
});
test('Score uses continuous normalized ratings and never labels them probabilities',()=>{
 assert.equal(typeof interpret,'function');
 const scores={A:3.5,B:.1,C:3.4,D:.8};
 const answers=Object.fromEntries(Object.entries(scores).map(([k,v])=>['score_'+k,{type:'score',score:v,probabilities:{0:1-v/4,1:0,2:0,3:0,4:v/4},legend:{0:'错',1:'偏错',2:'不确定',3:'偏对',4:'对'},confidence:.4}]));
 const result=interpret(multi,'score',{answers},{scoreThreshold:.75});
 assert.equal(result.selected,'AC');assert.equal(result.supportKind,'rating');
 assert.equal(result.evidence.find(x=>x.label==='A').value,.875);
});
test('Mixed reports each primitive and disagreements in one response',()=>{
 assert.equal(typeof compileQuestion,'function');
 const r=compileQuestion(single,'mixed');assert.equal(Object.keys(r.questions).length,9);
 const answers={pick:choice()};for(const k of Object.keys(single.options)){
 answers['opt_'+k]={type:'noul',noul:k==='B'?.9:.1};
 const s=k==='C'?4:0;answers['score_'+k]={type:'score',score:s,probabilities:{0:1-s/4,1:0,2:0,3:0,4:s/4},legend:{0:'错',1:'偏错',2:'不确定',3:'偏对',4:'对'},confidence:1};}
 const out=interpret(single,'mixed',{answers});assert.equal(out.selected,'A');
 assert.deepEqual(out.companions,{noul:'B',score:'C'});assert.equal(out.disagreement,true);
});
test('malformed or missing decisions cannot become correct answers',()=>{
 assert.equal(typeof interpret,'function');
 for(const p of [NaN,1.5,-.1,'0.8']) assert.throws(()=>interpret(judge,'noul',{answers:{truth:{type:'noul',noul:p}}}),/响应/);
 assert.throws(()=>interpret(single,'choice',{answers:{pick:choice('Z')}}),/响应/);
 assert.throws(()=>interpret(single,'choice',{answers:{pick:choice('A',{A:.8,B:.8,C:0,D:0})}}),/响应/);
 assert.throws(()=>interpret(single,'noul',{answers:{}}),/响应/);
});
test('strict multi grading ignores order but never gives partial credit',()=>{
 assert.equal(typeof interpret,'function');
 assert.equal(interpret(multi,'choice',{answers:{pick:choice('AC',{AC:1})}}).correct,true);
 assert.equal(interpret(multi,'choice',{answers:{pick:choice('A',{A:1})}}).correct,false);
});
test('statistics separate failed requests from accuracy and count retained coverage',()=>{
 assert.equal(typeof summarize,'function');
 const s=summarize([{status:'ok',correct:true,support:.9,retained:true,durationMs:100},{status:'ok',correct:false,support:.6,retained:false,durationMs:300},{status:'error',error:'bad',durationMs:20}]);
 assert.equal(s.success,2);assert.equal(s.errors,1);assert.equal(s.accuracy,.5);assert.equal(s.retainedAccuracy,1);assert.equal(s.coverage,.5);assert.equal(s.medianMs,200);
 assert.equal(summarize([]).accuracy,null);
});
test('seeded filters reproduce exact samples and default to text-only',()=>{
 assert.equal(typeof selectQuestions,'function');
 const bank=Array.from({length:80},(_,i)=>({...single,id:String(i),subject:i%2?4:1,image_local:i%4===0?'x':null}));
 const f={count:12,seed:'test',subject:'all',type:'all',images:'text'};
 assert.deepEqual(selectQuestions(bank,f).map(x=>x.id),selectQuestions(bank,f).map(x=>x.id));
 assert.equal(selectQuestions(bank,f).length,12);assert(selectQuestions(bank,f).every(x=>!x.image_local));
 assert.notDeepEqual(selectQuestions(bank,f).map(x=>x.id),selectQuestions(bank,{...f,seed:'other'}).map(x=>x.id));
 assert.throws(()=>selectQuestions(bank,{...f,count:-1}),/数量/);
});
