import {test} from 'node:test';
import assert from 'node:assert/strict';
import {timingTable,summaryCards,summaryTable} from '../public/render.js';

const group=(provider,wallMs)=>({provider,mode:'choice',planned:400,attempted:400,success:400,errors:0,wallMs,requestMs:wallMs*2,status:'completed',concurrency:2});
const run={modes:['choice'],concurrency:2,dataset:{name:'对照数据'},timings:[group('jev',10000),group('laya',5000)],wallMs:15000};
test('timing comparison reports elapsed difference and ratio for complete equivalent groups',()=>{
 const html=timingTable(run);assert.match(html,/400 题/);assert.match(html,/Jev 比 Laya 多用 5.00 s/);assert.match(html,/2.00×/);assert.match(html,/整批总耗时/);assert.match(html,/请求耗时合计/);
});
test('partial, failed, mismatched concurrency and legacy runs do not invent a speed comparison',()=>{
 for(const override of [{errors:1,success:399},{status:'cancelled'},{attempted:100},{concurrency:1},{wallMs:null}]){
  const html=timingTable({...run,timings:[run.timings[0],{...run.timings[1],...override}]});assert(!html.includes('多用'));assert(!html.includes('2.00×'));
 }
 const old=timingTable({results:[]});assert.match(old,/旧记录未采集/);assert(!old.includes('0 ms'));
});
test('result overview uses the arithmetic mean of successful requests and keeps median separate',()=>{
 const results=[100,100,1000].map((durationMs,index)=>({provider:'jev',mode:'choice',status:'ok',durationMs,correct:index<2,retained:true}));
 results.push({provider:'jev',mode:'choice',status:'error',durationMs:900000});
 const table=summaryTable(results),cards=summaryCards({results,config:{jev:{model:'fixture<model>'}},timings:[{provider:'jev',mode:'choice',wallMs:4321}]});
 assert.match(table,/<th>平均请求耗时<\/th><th>中位耗时<\/th>/);
 assert.match(table,/<td class="numeric">400\.0 ms<\/td><td class="numeric">100 ms<\/td>/);
 assert.match(cards,/66\.7%/);assert.match(cards,/<dd>2 \/ 3<\/dd>/);assert.match(cards,/<dd>400\.0 ms<\/dd>/);assert.match(cards,/<dd>4\.32 s<\/dd>/);
 assert.match(cards,/fixture&lt;model&gt;/);assert(!cards.includes('fixture<model>'));
});

test('three providers retain their identity and get all pairwise timing comparisons',()=>{
 const data={...run,timings:[...run.timings,group('startlux',20000)]};
 const html=timingTable(data);assert.match(html,/StartLux 4B Q8 比 Jev 多用 10.00 s/);assert.match(html,/StartLux 4B Q8 比 Laya 多用 15.00 s/);
 const cards=summaryCards({results:[{provider:'startlux',mode:'choice',status:'ok',correct:true,durationMs:50,retained:true}],timings:data.timings});
 assert.match(cards,/StartLux 4B Q8/);assert(!cards.includes('>Laya<'));
});
