import test from 'node:test';
import assert from 'node:assert/strict';
import {valueGroups,filterMinimum,addressTotals} from '../dist/valuation.mjs';
import {decodeFeeLogs,LEGACY_FEE_TOPICS,EVM,configureWallets} from '../dist/ledger.mjs';
import {handlePrices} from '../server/prices-proxy.mjs';
const g={chain:'1',asset:'native',trader:'alice',decimals:6,due:'100000',paid:'0',remaining:'100000',excess:'0',status:'unpaid'};
const prices={'1:native':{usd:'1',at:Date.now()}};
test('strict configurable threshold, exact boundary, overpayment and disabled option',()=>{
 assert.equal(valueGroups([g],prices)[0].status,'unpaid');
 assert.equal(valueGroups([{...g,due:'99999',remaining:'99999'}],prices)[0].status,'settled');
 assert.equal(valueGroups([g],prices,{threshold:'0.11'})[0].status,'settled');
 assert.equal(valueGroups([g],prices,{threshold:'0.11',enabled:false})[0].status,'unpaid');
 const over=valueGroups([{...g,due:'0',paid:'1',remaining:'0',excess:'1',status:'over'}],prices)[0];assert.equal(over.status,'settled');assert.equal(over.excess,'1');
 assert.equal(valueGroups([g],{'1:native':{usd:'1e-3',at:Date.now()}})[0].status,'settled');
});
test('missing or stale quotes never settle debt and never hide unknown-value addresses',()=>{
 assert.equal(valueGroups([g],{})[0].status,'unpaid');assert.equal(valueGroups([g],prices,{},Date.now()+16*60000)[0].priced,false);
 const rows=valueGroups([g,{...g,asset:'unknown'}],prices);assert.equal(filterMinimum(rows,100).length,2);assert.equal(addressTotals(rows).get('evm:alice').missing,1);
 assert.equal(filterMinimum(valueGroups([g],prices),1).length,0);
});
test('legacy three-word commission events decode exact receipt amount for selected wallet',()=>{
 configureWallets('0x'+'1'.repeat(40),'');const log={topics:[LEGACY_FEE_TOPICS[1]],data:'0x'+'e'.repeat(40).padStart(64,'0')+'5586d2fe423e'.padStart(64,'0')+EVM.slice(2).padStart(64,'0'),address:'0x'+'2'.repeat(40),logIndex:'0x1'};
 const tx={status:'0x1',hash:'0x'+'a'.repeat(64),from:{hash:'0x'+'3'.repeat(40),is_contract:false},to:{hash:log.address}};
 assert.equal(decodeFeeLogs([log],{id:'59144',symbol:'ETH',decimals:18},tx)[0].raw,'94037553857086');configureWallets('0x'+'4'.repeat(40),'');assert.equal(decodeFeeLogs([log],{id:'59144',symbol:'ETH',decimals:18},tx).length,0);
});
test('price relay matches exact base contract and rejects low liquidity / wrong-chain ticker',async()=>{
 const asset='0x'+'1'.repeat(40);const req=new Request('https://ledger.test/api/prices',{method:'POST',headers:{Origin:'https://ledger.test'},body:JSON.stringify({assets:[{chain:'1',asset}]})});
 const result=await handlePrices(req,async()=>Response.json([{chainId:'bsc',baseToken:{address:asset},priceUsd:'999',liquidity:{usd:1e6}},{chainId:'ethereum',baseToken:{address:asset},priceUsd:'2',liquidity:{usd:20000}}]));assert.equal((await result.json()).prices['1:'+asset].usd,'2');
});
