import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import path from 'node:path';
export class DiskStore {
 constructor(dir){this.dir=dir;this.pending=Promise.resolve();}
 async init(){await mkdir(this.dir,{recursive:true,mode:0o700});await mkdir(path.join(this.dir,'runs'),{recursive:true,mode:0o700});}
 async read(name,fallback){try{return JSON.parse(await readFile(path.join(this.dir,name),'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
 write(name,value){
  const data=JSON.stringify(value,null,2),file=path.join(this.dir,name);
  const operation=this.pending.then(async()=>{await writeFile(file+'.tmp',data,{mode:0o600});await rename(file+'.tmp',file);});
  this.pending=operation.catch(()=>{});return operation;
 }
 async runs(){return Promise.all((await readdir(path.join(this.dir,'runs'))).filter(n=>n.endsWith('.json')).map(n=>this.read('runs/'+n,null)));}
 async flush(){await this.pending;}
}
