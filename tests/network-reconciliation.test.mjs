import './fixtures.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {EVM,SOL,autoAccount} from '../dist/ledger.mjs';
import {inspectSolana,explorerRows} from '../dist/api.mjs';
import {inspectExtended} from '../dist/extended-api.mjs';
import {runSync} from '../dist/sync-controller.mjs';
import {clearEvidenceCache,configureEvidenceCache} from '../dist/evidence-cache.mjs';
const address=n=>'0x'+n.repeat(40),hash=n=>'0x'+n.repeat(64),chain={id:'4663',name:'test',symbol:'ETH',decimals:18};
test('ordinary Solana inspection needs only finalized RPC, not enhanced-parser availability',async()=>{
 const old=globalThis.fetch;let calls=0;configureEvidenceCache({active:false});
 globalThis.fetch=async url=>{calls++;assert(String(url).includes('mainnet.helius-rpc.com'));return Response.json({result:{blockTime:1,meta:{err:null,preTokenBalances:[],postTokenBalances:[],innerInstructions:[]},transaction:{message:{accountKeys:[{pubkey:'A'.repeat(44),signer:true},{pubkey:SOL}],instructions:[{program:'system',programId:'11111111111111111111111111111111',parsed:{type:'transfer',info:{source:'A'.repeat(44),destination:SOL,lamports:'2'}}}]}}}})};
 try{const rows=await inspectSolana('B'.repeat(88),'synthetic');assert.equal(rows[0].raw,'2');assert.equal(calls,1)}finally{globalThis.fetch=old}
});
test('one broken token precision preserves its raw amount without blocking another asset',async()=>{
 const old=globalThis.fetch;configureEvidenceCache({active:false});const txhash=hash('a'),blockHash=hash('b'),good=address('c'),bad=address('d'),sender=address('e'),topic=a=>'0x'+'0'.repeat(24)+a.slice(2),logs=[good,bad].map((asset,i)=>({address:asset,topics:['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',topic(sender),topic(EVM)],data:'0x'+(123+i).toString(16).padStart(64,'0'),logIndex:'0x'+i}));
 globalThis.fetch=async(url,options)=>{const q=JSON.parse(options.body);let result;
 if(q.method==='eth_getTransactionByHash')result={hash:txhash,blockHash,blockNumber:'0x10',from:sender,to:good,value:'0x0'};
 else if(q.method==='eth_getTransactionReceipt')result={transactionHash:txhash,blockHash,blockNumber:'0x10',status:'0x1',logs};
 else if(q.method==='eth_getBlockByHash')result={hash:blockHash,timestamp:'0x1'};
 else if(q.method==='eth_getCode')result='0x';
 else if(q.method==='eth_call'){if(q.params[0].to===bad)return Response.json({error:{code:3,message:'execution reverted'}});result=q.params[0].data==='0x313ce567'?'0x6':'0x'+Buffer.from('USDC').toString('hex').padEnd(64,'0')}
 else throw Error(q.method);return Response.json({result})};
 try{const rows=await inspectExtended({id:'196',symbol:'OKB',decimals:18},txhash,'synthetic',{},undefined,async()=>[]);assert.equal(rows.length,2);assert.equal(rows.find(r=>r.asset===good).decimals,6);assert.equal(rows.find(r=>r.asset===bad).raw,'124');assert(rows.find(r=>r.asset===bad).metadataError);assert.equal(autoAccount(rows).find(r=>r.asset===bad).kind,'pending') }finally{globalThis.fetch=old}
});
test('Blockscout metadata errors are isolated from normal transfer rows',()=>{
 const items=[{transaction_hash:hash('a'),log_index:1,from:{hash:address('e')},to:{hash:EVM},total:{value:'12'},token:{type:'ERC-20',address_hash:address('c'),decimals:null}}, {transaction_hash:hash('a'),log_index:2,from:{hash:address('e')},to:{hash:EVM},total:{value:'13'},token:{type:'ERC-20',address_hash:address('d'),decimals:'6'}}];
 const rows=explorerRows(items,'token-transfers',chain);assert.equal(rows.length,2);assert(rows[0].metadataError);assert.equal(rows[1].metadataError,undefined);
});
const options=state=>({state,ids:[chain.id],chains:[chain],keys:{blockscout:'synthetic'},routers:{},wallets:{evm:EVM,sol:SOL},onChange(){},onProgress(){},onCheckpoint:async()=>{}});
const native=(h,block=90)=>({id:`4663:${h}:transactions:0`,chain:'4663',hash:h,asset:'native',symbol:'ETH',decimals:18,raw:'20',from:address('e'),to:EVM,trader:'',direction:'in',kind:'pending',stream:'transactions',blockNumber:block,blockHash:hash('f'),time:''});
test('recent overlap rebuilds known receipts and holds missing canonical transactions instead of trusting stale proofs',async()=>{
 const old=globalThis.fetch;await clearEvidenceCache();const existing=native(hash('a')),missing=native(hash('b')),older=native(hash('c'),10),seen=[];
 const state={version:1,records:[existing,missing,older,{...existing,id:`4663:${hash('a')}:fee:9`,feeEvent:true,kind:'commission'}],decisions:{},coverage:{4663:{status:'complete',inspected:[hash('a'),hash('b'),hash('c')],streams:Object.fromEntries(['transactions','internal-transactions','token-transfers'].map(s=>[s,{complete:true,highBlock:100}]))}}};
 const canonical={hash:hash('a'),status:'ok',block_number:92,block_hash:hash('d'),from:{hash:address('e'),is_contract:false},to:{hash:EVM},value:'30'};
 globalThis.fetch=async(url,opts)=>{const q=JSON.parse(opts.body);seen.push(q.path);
 if(q.path.startsWith('addresses/'))return Response.json({items:q.path.endsWith('/transactions')?[canonical]:[],next_page_params:null});
 if(q.path===`transactions/${hash('a')}`)return Response.json(canonical);
 if(q.path===`transactions/${hash('b')}`)return new Response('{}',{status:404});
 if(q.path.startsWith(`transactions/${hash('a')}/`))return Response.json({items:[],next_page_params:null});
 throw Error('Unexpected '+q.path)};
 try{await runSync(options(state));assert.equal(state.records.find(r=>r.id===existing.id).raw,'30');assert.equal(state.records.find(r=>r.id===existing.id).blockHash,hash('d'));assert(!state.records.some(r=>r.feeEvent));assert(state.records.find(r=>r.id===missing.id).canonicalMissing);assert(!seen.includes(`transactions/${hash('c')}`));assert.deepEqual(state.coverage[chain.id].inspected.sort(),[hash('a'),hash('c')].sort())}finally{globalThis.fetch=old;configureEvidenceCache({active:false})}
});
test('initial receipt verification overlaps latency with at most three Blockscout transactions',async()=>{
 const old=globalThis.fetch;await clearEvidenceCache();let active=0,peak=0;
 const records=['a','b','c'].map(n=>({...native(hash(n)),direction:'out',from:EVM,to:address('e')}));
 const state={version:1,records,decisions:{},coverage:{4663:{status:'running',inspected:[],streams:Object.fromEntries(['transactions','internal-transactions','token-transfers'].map(s=>[s,{complete:true}]))}}};
 globalThis.fetch=async(url,opts)=>{const q=JSON.parse(opts.body);active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,700));active--;return Response.json({hash:q.path.split('/')[1],status:'ok',block_number:90,block_hash:hash('d'),from:{hash:EVM,is_contract:false},to:{hash:address('e')},value:'20'})};
 try{await runSync(options(state));assert.equal(peak,3);assert.equal(state.coverage[chain.id].inspected.length,3)}finally{globalThis.fetch=old;configureEvidenceCache({active:false})}
});
