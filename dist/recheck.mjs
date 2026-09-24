// A checkpoint is specific to decoder revision and the exact known transfer rows.
export const RECHECK_REVISION=1;
export function recheckFingerprint(rows){return JSON.stringify(rows.filter(r=>!r.feeEvent).map(r=>[r.id,r.asset,r.raw,r.direction]).sort((a,b)=>a[0].localeCompare(b[0])))}
export async function runRecheckQueue(jobs,inspect,onResult,{signal,concurrency=3}={}){
 let next=0;
 async function lane(){while(!signal?.aborted){const job=jobs[next++];if(job===undefined)return;let result;try{result={job,value:await inspect(job,signal)}}catch(e){if(signal?.aborted)return;result={job,error:e.message||'凭证核验失败'}}await onResult(result)}}
 await Promise.all(Array.from({length:Math.min(concurrency,jobs.length)},lane));
}
