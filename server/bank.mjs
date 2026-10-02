import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
export async function loadBank(root){
 const texts=await Promise.all([1,4].map(s=>readFile(path.join(root,'data',`科目${s}_题库.json`),'utf8')));
 const questions=texts.flatMap(t=>JSON.parse(t).questions);
 const fingerprint=createHash('sha256').update(texts.join('\n')).digest('hex');
 const byId=new Map(questions.map(q=>[String(q.id),q]));
 if(byId.size!==questions.length)throw Error('题库中存在重复编号');
 return {questions,byId,fingerprint,metadata:{total:questions.length,textOnly:questions.filter(q=>!q.image_local).length,withImages:questions.filter(q=>q.image_local).length,subjects:[1,4].map(s=>({subject:s,count:questions.filter(q=>q.subject===s).length})),savedDate:'2026-09-29',fingerprint}};
}
