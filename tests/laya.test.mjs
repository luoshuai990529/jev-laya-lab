import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {LayaService} from '../server/laya.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'laya-lifecycle-'));
 await mkdir(path.join(root,'scripts'));
 await writeFile(path.join(root,'scripts/laya-service.sh'),'#!/bin/sh\nsleep 300 &\necho $! >> child.pid\necho "Application startup complete" >&2\nwait\n');
 const service=new LayaService(root);
 t.after(async()=>{service.stop();try{for(const pid of (await readFile(path.join(root,'child.pid'),'utf8')).trim().split(/\s+/))try{process.kill(Number(pid),'SIGTERM');}catch{}}catch{}});
 return {root,service};
}
test('stopping preparation terminates its download subprocesses too',async t=>{
 const {root,service}=await fixture(t);await service.prepare();
 let pid;
 for(let i=0;i<30;i++){try{pid=Number(await readFile(path.join(root,'child.pid'),'utf8'));break;}catch{await pause(10);}}
 assert(pid);process.kill(pid,0);service.stop();
 let alive=true;for(let i=0;i<30;i++){try{process.kill(pid,0);await pause(10);}catch{alive=false;break;}}
 assert.equal(alive,false,'stopping Laya must not orphan an active downloader');
});
test('concurrent prepare requests reserve one service before async filesystem work',async t=>{
 const {service}=await fixture(t);const result=await Promise.allSettled([service.prepare(),service.prepare()]);
 assert.equal(result.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(result.filter(x=>x.status==='rejected').length,1);
});
