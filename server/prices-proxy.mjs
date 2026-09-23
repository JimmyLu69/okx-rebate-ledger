import {lookupPrices} from '../dist/prices.mjs';
export async function handlePrices(request,fetcher=fetch){
 const send=(status,data)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
 if(request.method!=='POST')return send(405,{message:'POST required'});
 if(request.headers.get('Origin')!==new URL(request.url).origin)return send(403,{message:'Origin mismatch'});
 let assets;try{const text=await request.text();if(text.length>16000)throw Error();assets=JSON.parse(text).assets;if(!Array.isArray(assets)||assets.length>30||assets.some(a=>!a||!(a.chain==='solana'||/^\d{1,12}$/.test(a.chain))||!(a.asset==='native'||(a.chain==='solana'?/^[1-9A-HJ-NP-Za-km-z]{32,44}$/:/^0x[\da-fA-F]{40}$/).test(a.asset))))throw Error()}catch{return send(400,{message:'Invalid assets'})}
 return send(200,await lookupPrices(assets,fetcher));
}
