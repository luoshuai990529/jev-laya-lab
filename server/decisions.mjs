export const MODES = ['choice', 'noul', 'score', 'mixed'];
export const SCORE_LEVELS = ['该选项完全错误，不应选择', '该选项倾向错误', '无法判断该选项是否正确', '该选项倾向正确', '该选项完全正确，应当选择'];
export const DEFAULT_INSTRUCTIONS = '依据中国机动车道路交通安全法规与摩托车安全驾驶知识作答。判断题判断题干命题是否正确，选择题选择符合题意的答案；注意题干的否定词。仅评估给定信息，不把选项中写的正确或错误当作标准答案。';
export const isMulti = q => q.type === '多选题';
export const canonical = value => [...new Set(String(value).split(''))].sort().join('');
const fail = message => { throw new Error(message); };
const unit = (x, label) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1 ? x : fail('模型响应无效：'+label+' 应为 0–1 数值');
export function thresholds(options = {}) {
 const out = {noulThreshold:options.noulThreshold ?? .5,scoreThreshold:options.scoreThreshold ?? .75,gate:options.gate ?? 0};
 for (const [k,v] of Object.entries(out)) unit(v,k);
 return out;
}
function choices(q) {
 if (!isMulti(q)) return {...q.options};
 const keys=Object.keys(q.options);
 if(keys.length>7) fail('多选选项过多，请使用 Noul 模式');
 const criteria={};
 for(let mask=1;mask<2**keys.length;mask++){
  const set=keys.filter((_,i)=>mask & (1<<i));
  criteria[set.join('')]=set.map(k=>`${k}. ${q.options[k]}`).join('；');
 }
 return criteria;
}
export function compileQuestion(q,mode,options={}) {
 if(!MODES.includes(mode)) fail('未知答题模式'); thresholds(options);
 const description=String(options.imageDescription??'').trim();
 if(q.image_local && !description) fail('此题依赖配图，请先填写图片描述，或选择无图题');
 if(description.length>3000 || String(options.instructions??'').length>3000) fail('补充说明或图片描述最多 3000 字');
 const generic=q.datasetId&&q.datasetId!=='motorcycle';
 const state={...(generic?{category:q.category??String(q.subject??'通用')}:{subject:q.subject===1?'摩托车科目一':'摩托车科目四'}),question:q.question,options:{...q.options}};
 if(description) state.image_description=description;
 const instructions=String(options.instructions??'').trim() || q.instructions || (generic?'根据给定问题、上下文与选项作答，选择符合题意的答案；注意否定词。仅评估给定信息。':DEFAULT_INSTRUCTIONS);
 const questions={};
 if(mode==='choice'||mode==='mixed') questions.pick={type:'choice',instructions:instructions+(isMulti(q)?'\n从候选答案集合中选出全部且仅有应选择的选项。':'\n选择唯一正确的答案。'),criteria:choices(q)};
 if(mode==='noul'||mode==='mixed'){
  if(q.type==='判断题') questions.truth={type:'noul',instructions:instructions+'\n题干所陈述的命题是否正确？',criteria:{true:'题干命题正确',false:'题干命题错误'}};
  else for(const [k,v] of Object.entries(q.options)) questions['opt_'+k]={type:'noul',instructions:instructions+`\n对照题干，选项「${v}」是否应被选中？`,criteria:{true:'符合题意，应该选中',false:'不符合题意，不应选中'}};
 }
 if(mode==='score'||mode==='mixed') for(const [k,v] of Object.entries(q.options)) questions['score_'+k]={type:'score',instructions:instructions+`\n对照题干，评价选项「${v}」应被选择的程度。`,criteria:SCORE_LEVELS};
 return {state,questions};
}
function distribution(answer,allowed) {
 if(!answer?.probabilities || typeof answer.probabilities!=='object'||Array.isArray(answer.probabilities)) fail('模型响应无效：缺少概率分布');
 let sum=0;
 const entries=Object.entries(answer.probabilities);
 if(!entries.length) fail('模型响应无效：空概率分布');
 for(const [k,p] of entries){if(!allowed.has(k))fail('模型响应无效：未知候选 '+k);sum+=unit(p,'probabilities.'+k);}
 if(Math.abs(sum-1)>.025) fail('模型响应无效：概率之和不为 1');
 if(answer.confidence!==undefined) unit(answer.confidence,'confidence');
 return entries;
}
function choiceResult(q,answers){
 const a=answers.pick;if(a?.type!=='choice'||typeof a.choice!=='string') fail('模型响应无效：缺少 Choice 答案');
 const candidates=choices(q), normalized=canonical(a.choice);
 if(!Object.hasOwn(candidates,normalized)||normalized.length!==a.choice.length) fail('模型响应无效：选择了未知或重复选项');
 const allowed=new Set(Object.keys(candidates));
 // Equivalent letter ordering is harmless for a multi-select set.
 const probabilities=Object.fromEntries(Object.entries(a.probabilities??{}).map(([k,v])=>[canonical(k),v]));
 const entries=distribution({...a,probabilities},allowed);
 const support=probabilities[normalized];unit(support,'选中答案概率');
 if(entries.some(([,p])=>p>support+1e-5))fail('模型响应无效：Choice 不是最高概率候选');
 return {selected:normalized,support,supportKind:'probability',evidence:entries.map(([label,value])=>({label,value,kind:'probability',description:candidates[label]})),nativeConfidence:a.confidence??null};
}
function noulResult(q,answers,t){
 const entries=q.type==='判断题'?['A','B'].map((label,i)=>{
  const a=answers.truth;if(a?.type!=='noul')fail('模型响应无效：缺少 Noul 答案');const p=unit(a.noul,'noul');return {label,value:i?1-p:p,kind:'probability',description:q.options[label]};
 }):Object.entries(q.options).map(([label,description])=>{
  const a=answers['opt_'+label];if(a?.type!=='noul')fail('模型响应无效：缺少 Noul 答案 '+label);return {label,value:unit(a.noul,'noul'),kind:'probability',description};
 });
 const selected=isMulti(q)?entries.filter(e=>e.value>=t).map(e=>e.label).join(''):[...entries].sort((a,b)=>b.value-a.value)[0].label;
 const support=isMulti(q)?Math.min(...entries.map(e=>selected.includes(e.label)?e.value:1-e.value)):entries.find(e=>e.label===selected).value;
 return {selected,support,supportKind:isMulti(q)?'weakest_probability':'probability',evidence:entries,nativeConfidence:null};
}
function scoreResult(q,answers,t){
 const entries=Object.entries(q.options).map(([label,description])=>{
  const a=answers['score_'+label];if(a?.type!=='score'||typeof a.score!=='number'||!Number.isFinite(a.score)||a.score<0||a.score>4) fail('模型响应无效：缺少或越界的 Score 答案 '+label);
  distribution(a,new Set(['0','1','2','3','4']));
  const mean=Object.entries(a.probabilities).reduce((s,[k,p])=>s+Number(k)*p,0);
  if(Math.abs(mean-a.score)>.05)fail('模型响应无效：Score 与返回分布不一致');
  return {label,value:a.score/4,rawScore:a.score,kind:'rating',description,nativeConfidence:a.confidence??null,probabilities:a.probabilities};
 });
 const selected=isMulti(q)?entries.filter(e=>e.value>=t).map(e=>e.label).join(''):[...entries].sort((a,b)=>b.value-a.value)[0].label;
 const support=isMulti(q)?Math.min(...entries.map(e=>selected.includes(e.label)?e.value:1-e.value)):entries.find(e=>e.label===selected).value;
 return {selected,support,supportKind:'rating',evidence:entries,nativeConfidence:null};
}
export function interpret(q,mode,response,options={}){
 if(!MODES.includes(mode))fail('未知答题模式');const t=thresholds(options),answers=response?.answers;
 if(!answers||typeof answers!=='object'||Array.isArray(answers)) fail('模型响应无效：缺少 answers');
 let r;
 if(mode==='choice')r=choiceResult(q,answers);
 else if(mode==='noul')r=noulResult(q,answers,t.noulThreshold);
 else if(mode==='score')r=scoreResult(q,answers,t.scoreThreshold);
 else {
  r=choiceResult(q,answers);const n=noulResult(q,answers,t.noulThreshold),s=scoreResult(q,answers,t.scoreThreshold);
  r.companions={noul:n.selected,score:s.selected};r.companionEvidence={noul:n.evidence,score:s.evidence};r.disagreement=r.selected!==n.selected||r.selected!==s.selected;
 }
 return {...r,correct:canonical(r.selected)===canonical(q.answer),expected:q.answer,retained:r.support>=t.gate};
}
export function summarize(results){
 const ok=results.filter(r=>r.status==='ok'),retained=ok.filter(r=>r.retained),times=ok.map(r=>r.durationMs).filter(Number.isFinite).sort((a,b)=>a-b);
 const countCorrect=xs=>xs.filter(r=>r.correct).length;
 const requestMs=results.reduce((sum,r)=>sum+(Number.isFinite(r.durationMs)?r.durationMs:0),0);
 return {completed:results.length,success:ok.length,errors:results.length-ok.length,correct:countCorrect(ok),accuracy:ok.length?countCorrect(ok)/ok.length:null,retained:retained.length,retainedAccuracy:retained.length?countCorrect(retained)/retained.length:null,coverage:ok.length?retained.length/ok.length:null,medianMs:times.length?(times[Math.floor((times.length-1)/2)]+times[Math.floor(times.length/2)])/2:null,p95Ms:times.length?times[Math.max(0,Math.ceil(times.length*.95)-1)]:null,disagreements:ok.filter(r=>r.disagreement).length,requestMs};
}
export function selectQuestions(bank,filter={},descriptions={}){
 const count=filter.count??20;if(!Number.isInteger(count)||count<1||count>10000)fail('数量必须为 1–10000 的整数');
 let list=bank.filter(q=>(!filter.subject||filter.subject==='all'||String(q.subject)===String(filter.subject))&&(!filter.type||filter.type==='all'||q.type===filter.type));
 const image=filter.images??'text';if(!['text','described'].includes(image))fail('图片筛选无效');
 list=list.filter(q=>!q.image_local||image==='described'&&Boolean(descriptions[q.id]?.trim()));
 let seed=2166136261;for(const c of String(filter.seed??'20261001')) seed=Math.imul(seed^c.charCodeAt(0),16777619)>>>0;
 const random=()=>{seed=(seed+0x6D2B79F5)>>>0;let t=Math.imul(seed^(seed>>>15),1|seed);t^=t+Math.imul(t^(t>>>7),61|t);return ((t^(t>>>14))>>>0)/4294967296;};
 for(let i=list.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[list[i],list[j]]=[list[j],list[i]];}
 return list.slice(0,count);
}
