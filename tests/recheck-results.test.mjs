import test from 'node:test';import assert from 'node:assert/strict';
import {planRecheck,recheckOutcome} from '../dist/recheck.mjs';
const chainBy=id=>({id,...(id==='56'?{provider:'nodereal'}:{})});
const records=[{id:'a',chain:'56',hash:'tx1',asset:'native',raw:'1',direction:'in'},{id:'b',chain:'56',hash:'tx1',asset:'native',raw:'2',direction:'out'},{id:'c',chain:'solana',hash:'tx2',asset:'native',raw:'3',direction:'in'},{id:'d',chain:'8453',hash:'tx3',asset:'native',raw:'4',direction:'in'}];
test('every pending row is represented, Solana included; duplicate hashes share a request and missing keys stay visible',()=>{
 const {entries,jobs}=planRecheck(records,records,chainBy,{nodereal:'fake',helius:'fake'});
 assert.equal(entries.reduce((n,e)=>n+e.before,0),4);assert.equal(entries.length,3);assert.equal(jobs.length,2);assert.equal(jobs[0].rows.length,2);assert.equal(jobs[1].chain.id,'solana');assert.equal(entries[2].status,'missing');
 assert.equal(planRecheck(records,records,chainBy,{nodereal:'fake',helius:'fake',blockscout:'fake'}).jobs.length,3);
});
test('request success is distinct from accounting resolution, and failures retain their reason',()=>{
 const entry={key:'56:tx1',chain:'56',hash:'tx1',before:2};
 assert.equal(recheckOutcome(entry,records).status,'unresolved');assert.equal(recheckOutcome(entry,records.slice(1)).status,'partial');assert.equal(recheckOutcome(entry,records.slice(2)).status,'resolved');
 const failed=recheckOutcome(entry,records,'数据源限流');assert.equal(failed.status,'failed');assert.equal(failed.error,'数据源限流');assert.equal(failed.after,2);
});

test('Solana recheck fetches the requested signature and preserves enhanced attribution metadata',async()=>{
 const {inspectSolana}=await import('../dist/api.mjs');const {configureWallets}=await import('../dist/ledger.mjs');
 const own='So11111111111111111111111111111111111111112',from='A'.repeat(44),sig='B'.repeat(88);configureWallets('',own);
 const oldFetch=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,options)=>{calls.push(JSON.parse(options.body));return new Response(JSON.stringify(String(url).includes('/v0/transactions')?[{signature:sig,feePayer:from,source:'OKX_DEX_ROUTER'}]:{result:{meta:{err:null},transaction:{message:{accountKeys:[from,own],instructions:[{program:'system',parsed:{type:'transfer',info:{source:from,destination:own,lamports:10}}}]}},blockTime:1}}))};
 try{const rows=await inspectSolana(sig,'test-key');assert.equal(rows.length,1);assert.equal(rows[0].suggestedTrader,from);assert.equal(rows[0].source,'OKX_DEX_ROUTER');assert.deepEqual(calls[0].transactions,[sig]);assert.equal(calls[1].params[0],sig)}finally{globalThis.fetch=oldFetch}
});
