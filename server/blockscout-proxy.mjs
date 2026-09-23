// Same-origin, read-only relay: Blockscout PRO does not allow browser CORS.
export async function handleBlockscout(request, fetcher = fetch) {
  const respond = (status, body) => new Response(JSON.stringify(body), {status, headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  if (request.method !== 'POST') return respond(405,{message:'只接受查询请求'});
  if (request.headers.get('Origin') !== new URL(request.url).origin || !request.headers.get('Content-Type')?.startsWith('application/json')) return respond(403,{message:'请求来源不匹配'});
  let stage='parse', secret='';
  try {
    const raw=await request.text(); if(raw.length>16384)return respond(413,{message:'请求过大'});
    const {chain,path,key,params={}}=JSON.parse(raw);
    if(!/^\d{1,12}$/.test(String(chain)) || typeof key!=='string' || key.length>512 || !key || !/^(addresses\/0x[\da-fA-F]{40}\/(transactions|internal-transactions|token-transfers)|transactions\/0x[\da-fA-F]{64}(\/logs)?|tokens\/0x[\da-fA-F]{40})$/.test(path))return respond(400,{message:'无效的只读历史查询'});
    secret=key;stage='url';
    const url=new URL(`https://api.blockscout.com/${chain}/api/v2/${path}`);
    for(const [k,v]of Object.entries(params)){if(!/^[a-z_]+$/.test(k)||k==='apikey'||typeof v==='object')return respond(400,{message:'无效分页参数'});url.searchParams.set(k,String(v));}
    url.searchParams.set('apikey',key);
    stage='fetch';
    const r=await fetcher(url.toString(),{redirect:'manual',signal:AbortSignal.timeout(25000)});
    if(!r.ok)return respond(r.status,{message:r.status===402?'免费额度已用完':r.status===401||r.status===403?'Blockscout 凭证或权限无效':`Blockscout HTTP ${r.status}`});
    return new Response(await r.text(),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
  }catch(e){const message=String(e.message||'').split(secret||'__none__').join('[已隐藏]').replace(/https?:\/\/[^\s]+/g,'[接口地址]').slice(0,180);return respond(502,{message:`Blockscout ${stage} ${e.name}: ${message}`});}
}
