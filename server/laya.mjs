import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
export class LayaService {
 constructor(root){this.root=root;this.child=null;this.state='idle';this.logs=[];this.stage='尚未准备';}
 status(){return {state:this.state,stage:this.stage,logs:this.logs.slice(-24),endpoint:'http://127.0.0.1:8011/v1/systemone',version:'0.3.21'};}
 log(data){for(const line of data.toString().split(/\r?\n/)){if(line.trim())this.logs.push(line.slice(0,600));}if(this.logs.length>150)this.logs.splice(0,this.logs.length-150);}
 async prepare(){
  if(this.child||this.state==='preparing')throw Error('Laya 准备或推理服务已经在运行');
  this.logs=[];this.state='preparing';this.stage='正在准备 Python 环境、依赖和 multilingual 权重';
  try{await mkdir(path.join(this.root,'.local','cache'),{recursive:true});}catch(e){this.state='error';this.stage='无法准备缓存目录';throw e;}
  if(this.state!=='preparing')return this.status();
  const child=spawn('/bin/sh',[path.join(this.root,'scripts','laya-service.sh'),'prepare-and-start'],{cwd:this.root,env:{...process.env,UV_CACHE_DIR:path.join(this.root,'.local/cache/uv'),UV_PYTHON_INSTALL_DIR:path.join(this.root,'.local/cache/python'),HF_HOME:path.join(this.root,'.local/cache/huggingface'),TORCH_HOME:path.join(this.root,'.local/cache/torch')},stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
  this.child=child;child.stdout.on('data',d=>this.log(d));child.stderr.on('data',d=>{this.log(d);if(d.toString().includes('Application startup complete')){this.state='running';this.stage='本地 Laya 服务已启动';}});
  child.on('error',e=>{this.log(e.message);this.state='error';this.stage='启动失败，请查看下方日志';this.child=null;});
  child.on('exit',code=>{if(this.child!==child)return;this.child=null;if(this.state!=='idle'){this.state=code===0?'idle':'error';this.stage=code===0?'服务已停止':'准备或启动失败，请查看日志';}});
  return this.status();
 }
 stop(){if(this.child){try{if(process.platform==='win32')this.child.kill('SIGTERM');else process.kill(-this.child.pid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}this.child=null;}this.state='idle';this.stage='服务已停止';return this.status();}
}
