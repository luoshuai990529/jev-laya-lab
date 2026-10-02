import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadBank } from './bank.mjs';
import { DiskStore } from './store.mjs';
import { ConfigStore, checkProvider, callProvider, validatePlayground } from './providers.mjs';
import { RunManager } from './jobs.mjs';
import { LayaService } from './laya.mjs';
import { DEFAULT_INSTRUCTIONS } from './decisions.mjs';
import { DatasetStore } from './datasets.mjs';
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.webp':'image/webp'};
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
async function body(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>8*1024*1024)throw Error('请求过大：最多 8 MiB');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw Error('请求不是有效 JSON');}}
export async function createApp({root,localDir=path.join(root,'.local')}){
 const bank=await loadBank(root),store=new DiskStore(localDir);await store.init();const config=new ConfigStore(store);await config.init();
 const datasets=new DatasetStore({bank,store});await datasets.init();
 const descriptions={values:await store.read('descriptions.json',{})},manager=new RunManager({bank,store,config,descriptions,datasets});await manager.init();
 const laya=new LayaService(root),assets=new Set(bank.questions.map(q=>q.image_local).filter(Boolean));
 const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  try{
   const host=req.headers.host??'';
   if(!/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host))return json(res,403,{error:'仅允许本机访问'});
   const origin=req.headers.origin;if(origin&&origin!==`http://${host}`)return json(res,403,{error:'不允许跨站调用本地服务'});
   if(!['GET','POST'].includes(req.method))return json(res,405,{error:'请求方法不支持'});
   if(req.method==='POST'&&!req.headers['content-type']?.startsWith('application/json'))return json(res,415,{error:'需要 application/json 请求'});
   const url=new URL(req.url,`http://${host}`),p=url.pathname;
   if(req.method==='GET'){
    if(p==='/api/bootstrap')return json(res,200,{bank:datasets.get('motorcycle').metadata,datasets:datasets.list(),config:config.public(),descriptions:descriptions.values,defaultInstructions:DEFAULT_INSTRUCTIONS});
    if(p==='/api/datasets')return json(res,200,datasets.list());
    if(p==='/api/dataset-template')return json(res,200,JSON.parse(await readFile(path.join(root,'examples','decision-sample.json'),'utf8')));
    if(p==='/api/dataset-schema')return json(res,200,JSON.parse(await readFile(path.join(root,'examples','dataset.schema.json'),'utf8')));
    if(p==='/api/questions')return json(res,200,datasets.get(url.searchParams.get('datasetId')??'motorcycle').questions);
    if(p==='/api/config')return json(res,200,config.public());
    if(p==='/api/runs')return json(res,200,manager.list());
    if(/^\/api\/runs\/[\w-]+$/.test(p))return json(res,200,manager.get(p.split('/')[3]));
    if(p==='/api/laya/status')return json(res,200,laya.status());
    const name=p==='/'?'index.html':p.slice(1);
    const publicNames=new Set(['index.html','styles.css','app.js','render.js','guides.js']);
    let file;if(publicNames.has(name))file=path.join(root,'public',name);else if(assets.has(name))file=path.join(root,name);else return json(res,404,{error:'资源不存在'});
    const info=await stat(file);if(!info.isFile())return json(res,404,{error:'资源不存在'});
    res.writeHead(200,{'Content-Type':MIME[path.extname(file)]??'application/octet-stream','Cache-Control':publicNames.has(name)?'no-cache':'public, max-age=86400'});res.end(await readFile(file));return;
   }
   const input=await body(req);
   if(p==='/api/datasets')return json(res,201,await datasets.import(input));
   if(p==='/api/config')return json(res,200,await config.update(input));
   if(p==='/api/connection')return json(res,200,await checkProvider(input.provider,config.snapshot(input.provider)));
   if(p==='/api/descriptions'){
    const q=bank.byId.get(String(input.questionId));if(!q?.image_local)throw Error('请选择含配图的题目');
    if(typeof input.description!=='string'||input.description.length>3000)throw Error('图片描述最多 3000 字');
    const values={...descriptions.values,[q.id]:input.description.trim()};await store.write('descriptions.json',values);descriptions.values=values;return json(res,200,{saved:true});
   }
   if(p==='/api/preview'){const plan=manager.plan(input);const {configs,cases,dataset,providers,modes,options,concurrency,filter,questionIds,total,withDescriptions}=plan;return json(res,200,{dataset,providers,modes,options,concurrency,filter,questionIds,total,withDescriptions,requests:cases.slice(0,8).map(c=>({provider:c.provider,mode:c.mode,questionId:c.questionId,request:{model:configs[c.provider].model,...c.payload}}))});}
   if(p==='/api/runs')return json(res,201,await manager.start(input));
   if(/^\/api\/runs\/[\w-]+\/cancel$/.test(p))return json(res,200,manager.cancel(p.split('/')[3]));
   if(p==='/api/playground'){
    const payload=validatePlayground(input.state,input.questions),c=config.snapshot(input.provider);
    const response=await callProvider(input.provider,c,payload);return json(res,200,{request:{model:c.model,...payload},...response});
   }
   if(p==='/api/laya/prepare')return json(res,202,await laya.prepare());
   if(p==='/api/laya/stop')return json(res,200,laya.stop());
   return json(res,404,{error:'接口不存在'});
  }catch(e){if(!res.headersSent)json(res,e.httpStatus??400,{error:e.message});else res.end();}
 });
 return {server,manager,bank,config,datasets,flush:()=>store.flush(),async close(){await manager.close();laya.stop();await store.flush();if(server.listening){server.closeAllConnections();await new Promise(r=>server.close(r));}}};
}
