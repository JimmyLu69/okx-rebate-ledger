import {configureWallets} from './ledger.mjs';
import {inspectEVM} from './api.mjs';
import {inspectExtended} from './extended-api.mjs';
import {inspectXLayer} from './xlayer-api.mjs';
import {runRecheckQueue} from './recheck.mjs';
let controller;
self.onmessage=async({data})=>{
 if(data.type==='cancel'){controller?.abort();return}
 if(data.type!=='start'||controller)return;
 controller=new AbortController();
 const {jobs,keys,routers,wallets}=data;configureWallets(wallets.evm,wallets.sol);
 try{
  // Blockscout has one shared limiter in this worker. Other providers stay serial
  // per provider, since their free quotas differ.
  const groups=Object.groupBy(jobs,j=>j.chain.provider||'blockscout');
  await Promise.all(Object.entries(groups).map(([provider,tasks])=>runRecheckQueue(tasks,async(job,signal)=>{
   const {chain,hash,rows}=job,key=keys[provider];
   if(provider==='blockscout'){const r=await inspectEVM(chain,hash,key,routers,rows,signal);return [...r.replace,...r.fees]}
   return (provider==='xlayer'?inspectXLayer:inspectExtended)(chain,hash,key,routers,signal);
  },r=>self.postMessage({type:'result',key:r.job.key,fingerprint:r.job.fingerprint,chain:r.job.chain.id,hash:r.job.hash,rows:r.value,error:r.error}),{signal:controller.signal,concurrency:provider==='blockscout'?3:1})));
  self.postMessage({type:'done',aborted:controller.signal.aborted});
 }catch(e){self.postMessage({type:'fatal',error:e.message})}
 finally{controller=null}
};
