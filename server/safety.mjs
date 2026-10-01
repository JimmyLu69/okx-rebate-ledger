// Request limits are measured while reading bytes, before JSON parsing/allocation.
export class BodyLimitError extends Error { constructor(message='请求过大'){super(message);this.status=413} }
export async function readJsonLimited(message,limit=16384){
 const declared=message.headers.get('content-length');
 if(declared&&(!/^\d+$/.test(declared)||Number(declared)>limit)){await message.body?.cancel().catch(()=>{});throw new BodyLimitError()}
 if(!message.body)throw new SyntaxError('缺少 JSON 请求');
 const reader=message.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let length=0,text='';
 try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>limit){await reader.cancel();throw new BodyLimitError()}text+=decoder.decode(value,{stream:true})}text+=decoder.decode();return JSON.parse(text)}catch(error){await reader.cancel().catch(()=>{});throw error}finally{reader.releaseLock()}
}
export function plainObject(value){return !!value&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null)}
export function onlyKeys(value,keys){return plainObject(value)&&Object.keys(value).every(k=>keys.includes(k))}
export function relayResponse(status,body,extra={}){return Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra}})}
// This bounds one running instance, not a global rate/credit budget. Netlify's
// deployed config.rateLimit separately enforces per-IP limits across instances.
let relayActive=0;
export async function withRelaySlot(run){
 if(relayActive>=8)return relayResponse(429,{message:'当前查询较多，请稍后重试'},{'Retry-After':'2'});
 relayActive++;try{return await run()}finally{relayActive--}
}
// No credentials or credential-bearing queries are ever stored here.
const publicRelayCaches=new WeakMap();
export async function cachedPublicQuery(fetcher,key,ttl,run){
 let cache=publicRelayCaches.get(fetcher);if(!cache){cache=new Map();publicRelayCaches.set(fetcher,cache)}
 const now=Date.now(),prior=cache.get(key);if(prior&&prior.expires>now)return prior.value;
 if(prior)cache.delete(key);while(cache.size>=64)cache.delete(cache.keys().next().value);
 const value=Promise.resolve().then(run);cache.set(key,{value,expires:now+ttl});
 try{const result=await value;const bytes=new TextEncoder().encode(JSON.stringify(result)).byteLength;if(bytes>256*1024&&cache.get(key)?.value===value)cache.delete(key);return result}catch(e){if(cache.get(key)?.value===value)cache.delete(key);throw e}
}
export function safeRelayError(error){
 if(error?.name==='TimeoutError'||error?.name==='AbortError')return '请求超时';
 // Provider errors can include a request URL. Do not reflect arbitrary text.
 return '连接失败或节点暂不可用';
}
