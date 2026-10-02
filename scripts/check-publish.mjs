import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';

// Inspect exact index blobs, never print credential values or scan local run contents.
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',maxBuffer:64*1024*1024});
const files=git('ls-files','-z').split('\0').filter(Boolean);
if(!files.length)throw Error('发布检查需要已暂存的文件');
let keys=[];
try{const c=JSON.parse(await readFile('.local/config.json','utf8'));keys=Object.values(c).map(x=>x?.key).filter(x=>typeof x==='string'&&x.length>=8);}catch(e){if(e.code!=='ENOENT')throw e;}
const blocked=[];
for(const file of files){
 if(/^(?:\.local|\.venv[^/]*|node_modules|\.impeccable)(?:\/|$)|(?:^|\/)(?:\.env(?:\..*)?|[^/]+\.(?:pem|key|zip|log))$|^data\/(?:raw|indexes)\//.test(file)){blocked.push(file+' [本地或敏感文件]');continue;}
 const blob=execFileSync('git',['show',':'+file],{maxBuffer:64*1024*1024});
 const value=blob.toString('utf8');
 if(keys.some(k=>blob.includes(Buffer.from(k))))blocked.push(file+' [本地 Key 精确匹配]');
 if(/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(value))blocked.push(file+' [疑似真实凭据]');
 if(/\/(?:Users|home)\/[a-zA-Z0-9_.-]+\//.test(value))blocked.push(file+' [个人绝对路径]');
}
if(blocked.length){console.error('发布检查未通过：\n'+blocked.join('\n'));process.exitCode=1;}
else console.log(`发布检查通过：${files.length} 个暂存文件；本地运行目录与配置未纳入，已扫描本地 Key 精确匹配和高置信凭据模式。`);
