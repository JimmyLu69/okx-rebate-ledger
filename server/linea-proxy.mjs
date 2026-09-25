// Fixed upstreams and a read-only method/parameter allowlist. Never a generic RPC proxy.
export async function handleLinea(request,fetcher=fetch){
 const send=(status,body)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
 if(request.method!=='POST')return send(405,{message:'仅支持只读查询'});
 if(request.headers.get('Origin')!==new URL(request.url).origin||!request.headers.get('Content-Type')?.startsWith('application/json'))return send(403,{message:'请求来源不匹配'});
 let method,params;
 try{
  const text=await request.text();if(text.length>4096)return send(413,{message:'请求过大'});
  ({method,params}=JSON.parse(text));if(!Array.isArray(params))throw Error();
  const hash=x=>/^0x[0-9a-f]{64}$/i.test(x),addr=x=>/^0x[0-9a-f]{40}$/i.test(x),block=x=>/^0x[0-9a-f]{1,16}$/i.test(x);
  const valid=['eth_getTransactionByHash','eth_getTransactionReceipt'].includes(method)?params.length===1&&hash(params[0]):method==='eth_getBlockByHash'?params.length===2&&hash(params[0])&&params[1]===false:method==='eth_getCode'?params.length===2&&addr(params[0])&&block(params[1]):method==='eth_call'?params.length===2&&params[0]&&Object.keys(params[0]).every(k=>['to','data'].includes(k))&&addr(params[0].to)&&['0x313ce567','0x95d89b41'].includes(params[0].data)&&block(params[1]):false;
  if(!valid)throw Error();
 }catch{return send(400,{message:'不支持的只读 Linea 查询'})}
 const errors=[];
 for(const url of ['https://rpc.linea.build','https://linea-rpc.publicnode.com']){
  try{
   const response=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),redirect:'error',signal:AbortSignal.timeout(9000)});
   if(!response.ok)throw Error('HTTP '+response.status);
   const data=await response.json();if(data.error)throw Error(String(data.error.message||'RPC 返回错误').slice(0,160));
   if(data.result==null)throw Error('节点未返回此历史数据');
   return send(200,{jsonrpc:'2.0',id:1,result:data.result});
  }catch(e){errors.push(new URL(url).hostname+'：'+(e.name==='TimeoutError'?'请求超时':String(e.message).slice(0,160)))}
 }
 return send(502,{message:'Linea 服务端查询失败：'+errors.join('；')});
}
