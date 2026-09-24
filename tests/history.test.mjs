import {seed} from './fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {incrementalStreams,historyBackup,restoreHistory} from '../dist/history.mjs';
import {scanRanges} from '../dist/extended-api.mjs';
import {scanEVM,scanSolana} from '../dist/api.mjs';
import {nonceRanges} from '../dist/xlayer-api.mjs';
const noop=()=>{};
test('completed streams reopen only the new range; interrupted streams keep exact cursors',()=>{
 const start={tokentx:{complete:true,endBlock:100},transactions:{complete:true,highBlock:500},solana:{complete:true,headSignature:'head'},pending:{complete:false,cursor:{index:2},endBlock:800}};
 const next=incrementalStreams(start);assert.equal(next.tokentx.minBlock,101);assert.equal(next.transactions.stopBlock,436);assert.equal(next.solana.until,'head');assert.deepEqual(next.pending,start.pending);assert.equal(start.tokentx.complete,true);
});
test('forward and reverse incremental windows cover new blocks once and never scan genesis',async()=>{
 for(const reverse of [true,false]){const calls=[],checkpoints=[];
 await scanRanges({chain:{id:'1',name:'test'},streams:['token'],windowSize:100,endBlock:330,start:{token:{minBlock:151}},reverse,fetchPage:async(s,a,b)=>{calls.push([a,b]);return {hashes:[],more:false}},onPage:async(r,p)=>checkpoints.push(p),onProgress:noop});
 const heights=calls.flatMap(([a,b])=>Array.from({length:b-a+1},(_,i)=>a+i));assert.equal(heights.length,180);assert.equal(new Set(heights).size,180);assert.equal(Math.min(...heights),151);assert.equal(Math.max(...heights),330);assert.equal(checkpoints.at(-1).complete,true);
 }
});
test('versioned wallet history round trip preserves cursors and rejects different wallet',()=>{
 const wallets={evm:seed.to,sol:''},state={version:1,decoderVersion:3,records:[seed],coverage:{'4663':{status:'complete',streams:{transactions:{complete:true,highBlock:500}},inspected:[seed.hash]}},selected:['4663']};
 const backup=JSON.parse(JSON.stringify(historyBackup(state,wallets)));
 assert.deepEqual(restoreHistory(backup,wallets,noop),state);
 assert.throws(()=>restoreHistory(backup,{evm:seed.trader,sol:''},noop),/钱包/);
 assert.deepEqual(restoreHistory({records:[seed],coverage:state.coverage},wallets,noop).coverage,{});
 assert.equal(JSON.stringify(backup).includes('credentials'),false);
});
test('Blockscout incremental scan stops at saved boundary and retains same-block records',async()=>{
 const original=globalThis.fetch,calls=[],pages=[];
 globalThis.fetch=async(u,opt)=>{const q=JSON.parse(opt.body);calls.push(q);return new Response(JSON.stringify({items:[600,436,435].map((block,i)=>({block_number:block,status:'ok',from:{hash:seed.to},to:{hash:seed.trader},hash:'0x'+String(i+1).repeat(64),value:'1'})),next_page_params:{index:999}}))};
 try{await scanEVM({id:'4663',name:'test',decimals:18,symbol:'ETH'},'test',{},async(r,p)=>pages.push({r,p}),noop,undefined,{transactions:{stopBlock:436},'internal-transactions':{complete:true},'token-transfers':{complete:true}});assert.equal(calls.length,1);assert.equal(pages[0].r.length,2);assert.equal(pages[0].p.highBlock,600);assert.equal(pages[0].p.complete,true)}finally{globalThis.fetch=original}
});
test('Solana incremental scan stops at signature and does not refetch old transaction details',async()=>{
 const original=globalThis.fetch;let list=0,rpc=0,saved;
 globalThis.fetch=async u=>{if(String(u).includes('/addresses/')){list++;return new Response(JSON.stringify([{signature:'new',transactionError:'failed'},{signature:'old'},{signature:'older'}]))}rpc++;throw Error('Old transaction must not be fetched')};
 try{await scanSolana('test',async(r,p)=>saved=p,noop,undefined,{until:'old',headSignature:'old'});assert.equal(list,1);assert.equal(rpc,0);assert.equal(saved.complete,true);assert.equal(saved.headSignature,'new')}finally{globalThis.fetch=original}
});
test('X Layer nonce ranges count only new outgoing transactions',async()=>{
 const heights=[];const result=await nonceRanges(100,h=>{heights.push(h);return h<50?20:22},10,50);assert.equal(result.total,2);assert.equal(result.baseline,20);assert.ok(result.ranges.every(r=>r.from>=50));assert.ok(heights.every(h=>h>=49));
});
test('old completed history can establish incremental anchors without re-fetching every receipt',()=>{
 const record={...seed,stream:'token-transfers'};
 const next=incrementalStreams({'token-transfers':{complete:true}},[record]);assert.deepEqual(next['token-transfers'].anchors,[seed.hash]);
 const sol=incrementalStreams({solana:{complete:true}},[{...seed,chain:'solana',hash:'saved-signature'}]);assert.equal(sol.solana.until,'saved-signature');
});
