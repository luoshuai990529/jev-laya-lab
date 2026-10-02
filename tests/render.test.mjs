import {test} from 'node:test';
import assert from 'node:assert/strict';
import {timingTable} from '../public/render.js';

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
