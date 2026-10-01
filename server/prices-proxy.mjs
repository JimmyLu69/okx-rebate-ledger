import {lookupPrices} from '../dist/prices.mjs';
import {readJsonLimited,onlyKeys,relayResponse,cachedPublicQuery} from './safety.mjs';
export async function handlePrices(request,fetcher=fetch){
 if(request.method!=='POST')return relayResponse(405,{message:'只接受报价查询'});
 if(request.headers.get('Origin')!==new URL(request.url).origin||!request.headers.get('Content-Type')?.startsWith('application/json'))return relayResponse(403,{message:'请求来源不匹配'});
 let assets;
 try{
  const input=await readJsonLimited(request,16000);if(!onlyKeys(input,['assets']))throw Error();assets=input.assets;
  if(!Array.isArray(assets)||assets.length>30||assets.some(a=>!onlyKeys(a,['chain','asset'])||typeof a.chain!=='string'||!(a.chain==='solana'||/^\d{1,12}$/.test(a.chain))||typeof a.asset!=='string'||!(a.asset==='native'||(a.chain==='solana'?/^[1-9A-HJ-NP-Za-km-z]{32,44}$/:/^0x[\da-fA-F]{40}$/).test(a.asset))))throw Error();
  assets=[...new Map(assets.map(a=>{const v={chain:a.chain,asset:a.chain==='solana'?a.asset:a.asset.toLowerCase()};return [v.chain+':'+v.asset,v]})).values()].sort((a,b)=>(a.chain+':'+a.asset).localeCompare(b.chain+':'+b.asset));
 }catch(e){return relayResponse(e.status||400,{message:e.status===413?'请求过大':'报价资产格式错误'})}
 try{return relayResponse(200,await cachedPublicQuery(fetcher,'prices:'+JSON.stringify(assets),30000,()=>lookupPrices(assets,fetcher)))}catch{return relayResponse(502,{message:'报价源暂不可用，请稍后重试'})}
}
