// A checkpoint is specific to decoder revision and the exact known transfer rows.
export const RECHECK_REVISION=2;
export function recheckFingerprint(rows){return JSON.stringify(rows.filter(r=>!r.feeEvent).map(r=>[r.id,r.asset,r.raw,r.direction]).sort((a,b)=>a[0].localeCompare(b[0])))}
export async function runRecheckQueue(jobs,inspect,onResult,{signal,concurrency=3}={}){
 let next=0;
 async function lane(){while(!signal?.aborted){const job=jobs[next++];if(job===undefined)return;let result;try{result={job,value:await inspect(job,signal)}}catch(e){if(signal?.aborted)return;result={job,error:e.message||'凭证核验失败'}}await onResult(result)}}
 await Promise.all(Array.from({length:Math.min(concurrency,jobs.length)},lane));
}

export function planRecheck(pending,records,chainBy,keys){
 const grouped=new Map();for(const r of pending){const key=r.chain+':'+r.hash;if(!grouped.has(key))grouped.set(key,{key,chain:r.chain,hash:r.hash,before:0});grouped.get(key).before++}
 const byTx=new Map();for(const r of records){if(r.feeEvent)continue;const key=r.chain+':'+r.hash;if(!byTx.has(key))byTx.set(key,[]);byTx.get(key).push(r)}
 const entries=[],jobs=[];
 for(const entry of grouped.values()){
  const chain=chainBy(entry.chain),provider=chain.id==='solana'?'helius':chain.provider||'blockscout',rows=byTx.get(entry.key)||[];
  const status=keys[provider]?'queued':'missing';
  entries.push({...entry,status,after:entry.before,error:status==='missing'?'缺少 '+provider+' API 凭证':''});
  if(status==='queued')jobs.push({key:entry.key,chain,hash:entry.hash,rows,fingerprint:recheckFingerprint(rows)});
 }return {entries,jobs};
}
export function recheckOutcome(entry,pending,error){
 const after=pending.filter(r=>r.chain===entry.chain&&r.hash===entry.hash).length;
 return {...entry,after,status:error?'failed':after===0?'resolved':after<entry.before?'partial':'unresolved',error:error||''};
}
