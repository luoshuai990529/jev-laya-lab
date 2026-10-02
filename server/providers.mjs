export const DEFAULT_CONFIG = {
 jev:{endpoint:'https://api.typesafe.ai/v1/systemone',model:'jev-1.13.0',key:'',remember:false,timeoutMs:45000},
 laya:{endpoint:'http://127.0.0.1:8011/v1/systemone',model:'multilingual',key:'',remember:false,timeoutMs:180000}
};
export function validateEndpoint(endpoint){
 let u;try{u=new URL(endpoint);}catch{throw Error('接口地址无效，请填写完整 URL');}
 const local=['127.0.0.1','localhost','[::1]'].includes(u.hostname);
 if(u.username||u.password||u.hash||u.search||!(u.protocol==='https:'||u.protocol==='http:'&&local))throw Error('远程接口必须使用 HTTPS，本机接口可使用 HTTP；地址不能含凭据或查询参数');
 if(!u.pathname.endsWith('/systemone'))throw Error('请输入完整的 /v1/systemone 决策接口地址');
 return u.toString();
}
export class ConfigStore {
 constructor(store){this.store=store;this.values=structuredClone(DEFAULT_CONFIG);}
 async init(){const saved=await this.store.read('config.json',{});for(const k of ['jev','laya'])if(saved[k])this.values[k]={...this.values[k],...saved[k]};}
 public(){return Object.fromEntries(Object.entries(this.values).map(([k,v])=>[k,{endpoint:v.endpoint,model:v.model,timeoutMs:v.timeoutMs,remember:v.remember,hasKey:Boolean(v.key)}]));}
 snapshot(provider){if(!Object.hasOwn(this.values,provider))throw Error('未知模型服务');return {...this.values[provider]};}
 async update(body){
  const {provider}=body;const prior=this.snapshot(provider),next={...prior};
  if(body.endpoint!==undefined){next.endpoint=validateEndpoint(String(body.endpoint).trim());if(next.endpoint!==prior.endpoint)next.key='';}
  if(body.model!==undefined){next.model=String(body.model).trim();if(!next.model||next.model.length>128)throw Error('模型名称不能为空，且不超过 128 字符');}
  if(body.key!==undefined){if(typeof body.key!=='string'||body.key.length>1000||/[\r\n]/.test(body.key))throw Error('Key 格式无效');if(body.key.trim())next.key=body.key.trim();}
  if(body.clearKey)next.key='';
  if(body.remember!==undefined){if(typeof body.remember!=='boolean')throw Error('记住 Key 的值无效');next.remember=body.remember;}
  if(body.timeoutMs!==undefined){if(!Number.isInteger(body.timeoutMs)||body.timeoutMs<1000||body.timeoutMs>600000)throw Error('超时应为 1–600 秒');next.timeoutMs=body.timeoutMs;}
  const values={...this.values,[provider]:next};
  await this.store.write('config.json',Object.fromEntries(Object.entries(values).map(([k,v])=>[k,{...v,key:v.remember?v.key:''}])));
  this.values=values;return this.public();
 }
}
export class ProviderError extends Error {
 constructor(message,status=null){super(message);this.httpStatus=status;}
}
export function ready(provider,config){validateEndpoint(config.endpoint);if(provider==='jev'&&!config.key)throw Error('请在模型配置中填写 Jev API Key');}
function sanitize(message,key){return key?message.split(key).join('[Key 已隐藏]'):message;}
async function jsonRequest(config,url,method,body,signal){
 const start=performance.now();
 try{
  const response=await fetch(url,{method,headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{}),...(config.key?{Authorization:'Bearer '+config.key}:{})},body:body?JSON.stringify(body):undefined,redirect:'manual',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(config.timeoutMs)]):AbortSignal.timeout(config.timeoutMs)});
  const reader=response.body.getReader();let size=0;const chunks=[];
  while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024){await reader.cancel();throw new ProviderError('模型响应过大（超过 2 MB）',response.status);}chunks.push(value);}
  const text=Buffer.concat(chunks).toString('utf8');
  if(!response.ok){
   const hint={401:'API Key 无效或已过期，请检查模型配置',403:'服务拒绝访问，请检查 Key 权限',422:'请求被接口拒绝，请检查模型名称和请求格式',429:'请求限流，本次未自动重试，请稍后重新测试',529:'服务暂时过载，本次未自动重试'}[response.status]??'接口返回 HTTP '+response.status;
   throw new ProviderError(hint+'。'+sanitize(text.slice(0,500),config.key),response.status);
  }
  let parsed;try{parsed=JSON.parse(text);}catch{throw new ProviderError('接口没有返回 JSON，请检查决策接口地址');}
  return {rawResponse:parsed,durationMs:Math.round(performance.now()-start)};
 }catch(e){
  if(e instanceof ProviderError)throw e;
  if(signal?.aborted)throw new ProviderError('用户已取消');
  if(e.name==='TimeoutError'||e.name==='AbortError')throw new ProviderError('模型请求超时，未自动重试；本地 Laya 首次需要下载权重，可在配置页查看状态');
  throw new ProviderError(sanitize('无法连接模型服务，请检查地址、网络和服务状态。'+(e.cause?.code??e.message),config.key));
 }
}
export async function callProvider(provider,config,payload,signal){ready(provider,config);return jsonRequest(config,config.endpoint,'POST',{model:config.model,...payload},signal);}
export async function checkProvider(provider,config){
 ready(provider,config);const url=new URL(config.endpoint);url.pathname=url.pathname.replace(/\/v1\/systemone$/,provider==='jev'?'/v1/models':'/health');
 if(url.pathname.endsWith('systemone'))throw Error('连接检测需要 /v1/systemone 接口，定制路径请直接单题测试');
 return jsonRequest(config,url.toString(),'GET');
}
export function validatePlayground(state,questions){
 if(state===null||state===undefined||!['string','object'].includes(typeof state))throw Error('state 需要文字、JSON 对象或数组');
 if(JSON.stringify(state).length>50000)throw Error('state 最多 50,000 字符');
 if(!questions||typeof questions!=='object'||Array.isArray(questions))throw Error('questions 需要 JSON 对象');
 const entries=Object.entries(questions);if(!entries.length||entries.length>32)throw Error('一次请求需要 1–32 个问题');
 const clean={};for(const [id,q] of entries){
  if(!q||!['choice','noul','score'].includes(q.type)||q.instructions===undefined||q.instructions===null)throw Error('每个问题需要 type 与 instructions');
  if(q.type==='choice'&&(!q.criteria||Array.isArray(q.criteria)||typeof q.criteria!=='object'||Object.keys(q.criteria).length<2||Object.keys(q.criteria).length>100))throw Error('Choice 需要 2–100 个候选项');
  if(q.type==='score'&&(!Array.isArray(q.criteria)||q.criteria.length<2||q.criteria.length>10||q.criteria.some(x=>x==null)))throw Error('Score 需要 2–10 个非空等级');
  clean[id]={type:q.type,instructions:q.instructions,...(q.criteria!==undefined?{criteria:q.criteria}:{})};
 }
 if(JSON.stringify(clean).length>50000)throw Error('问题描述过长');return {state,questions:clean};
}
