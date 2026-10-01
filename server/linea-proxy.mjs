import {readJsonLimited,onlyKeys,relayResponse,cachedPublicQuery,safeRelayError} from './safety.mjs';
// Fixed upstreams and a read-only method/parameter allowlist. Never a generic RPC proxy.
export function validateLineaQuery(input){
 if(!onlyKeys(input,['method','params']))throw Error('不支持的只读 Linea 查询');
 const {method,params}=input;
 if(!Array.isArray(params))throw Error('不支持的只读 Linea 查询');
 const hash=x=>typeof x==='string'&&/^0x[0-9a-f]{64}$/i.test(x);
 const addr=x=>typeof x==='string'&&/^0x[0-9a-f]{40}$/i.test(x);
 const block=x=>typeof x==='string'&&/^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/i.test(x);
 const valid=['eth_getTransactionByHash','eth_getTransactionReceipt'].includes(method)
  ?params.length===1&&hash(params[0])
  :method==='eth_getBlockByHash'?params.length===2&&hash(params[0])&&params[1]===false
  :method==='eth_getBlockByNumber'?params.length===2&&(params[0]==='finalized'||block(params[0]))&&params[1]===false
  :method==='eth_getCode'?params.length===2&&addr(params[0])&&block(params[1])
  :method==='eth_call'?params.length===2&&onlyKeys(params[0],['to','data'])&&addr(params[0].to)&&['0x313ce567','0x95d89b41'].includes(params[0].data)&&block(params[1]):false;
 if(!valid)throw Error('不支持的只读 Linea 查询');
 return {method,params};
}
export async function handleLinea(request,fetcher=fetch){
 if(request.method!=='POST')return relayResponse(405,{message:'仅支持只读查询'});
 if(request.headers.get('Origin')!==new URL(request.url).origin||!request.headers.get('Content-Type')?.startsWith('application/json'))return relayResponse(403,{message:'请求来源不匹配'});
 let query;
 try{query=validateLineaQuery(await readJsonLimited(request,4096))}catch(e){return relayResponse(e.status||400,{message:e.status===413?'请求过大':'不支持的只读 Linea 查询'})}
 try{
  const result=await cachedPublicQuery(fetcher,'linea:'+JSON.stringify(query),query.params[0]==='finalized'?10000:60000,async()=>{
   const errors=[];
   for(const url of ['https://rpc.linea.build','https://linea-rpc.publicnode.com']){
    try{
     const response=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,...query}),redirect:'error',signal:AbortSignal.timeout(9000)});
     if(!response.ok)throw Error('HTTP '+response.status);
     const data=await readJsonLimited(response,2*1024*1024);if(data.error||data.result==null)throw Error('节点未返回此历史数据');
     return {jsonrpc:'2.0',id:1,result:data.result};
    }catch(e){errors.push(new URL(url).hostname+'：'+safeRelayError(e))}
   }
   throw Error('Linea 服务端查询失败：'+errors.join('；'));
  });
  return relayResponse(200,result);
 }catch(e){return relayResponse(502,{message:e.message})}
}
