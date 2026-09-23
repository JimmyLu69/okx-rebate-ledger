import {seed} from './fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {handleBlockscout} from '../server/blockscout-proxy.mjs';
import {summarize,byAddress} from '../dist/ledger.mjs';
test('address totals add each asset separately and subtract refunds exactly',()=>{
 const records=[seed,{...seed,id:'another',raw:'25000000000000'},{...seed,id:'refund',direction:'out',kind:'refund',raw:'10000000000000'},{...seed,id:'otherchain',chain:'1',raw:'30'},{...seed,id:'token',asset:'0x'+'2'.repeat(40),symbol:'USDC',decimals:6,raw:'3000000'},{...seed,id:'pending',kind:'pending',raw:'99999999999'},{...seed,id:'over',trader:'0x'+'3'.repeat(40),direction:'out',kind:'refund',raw:'10'}];
 const addresses=byAddress(summarize(records));assert.equal(addresses.length,2);
 const a=addresses.find(a=>a.address===seed.trader);assert.equal(a.assets.length,3);
 const eth=a.assets.find(g=>g.chain===seed.chain&&g.asset==='native');assert.equal(eth.due,'40000000000000');assert.equal(eth.paid,'10000000000000');assert.equal(eth.remaining,'30000000000000');assert.equal(eth.status,'partial');
 assert.equal(addresses.find(a=>a.address!==seed.trader).assets[0].excess,'10');
});
test('Blockscout relay uses same-origin and fixed read-only endpoints without leaking keys',async()=>{
 const input={chain:'4663',path:`addresses/${seed.to}/internal-transactions`,key:'test-secret-key',params:{index:2}};
 const req=(body,origin='http://localhost')=>new Request('http://localhost/api/blockscout',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
 let calls=0;
 const fetcher=async(u,o)=>{calls++;u=new URL(u);assert.equal(u.origin,'https://api.blockscout.com');assert.equal(u.searchParams.get('apikey'),input.key);assert.equal(o.redirect,'manual');return new Response('{"items":[],"next_page_params":null}')};
 const r=await handleBlockscout(req(input),fetcher);assert.equal(r.status,200);assert.equal((await r.text()).includes(input.key),false);assert.equal(calls,1);
 assert.equal((await handleBlockscout(req(input,'https://other.test'),fetcher)).status,403);
 assert.equal((await handleBlockscout(req({...input,path:'../withdraw'}),fetcher)).status,400);
 assert.equal(calls,1);
});
test('automatic accounting recognizes proven fees and OKX Solana, offsets payments only to known invitees',async()=>{
 const {autoAccount,SOL}=await import('../dist/ledger.mjs');
 const solTrader='6rqBjSVY2Av7r6geJpZoJehaLWtHJKPBQZBzi2hLyBae';
 const sol={...seed,id:'solfee',chain:'solana',asset:'native',symbol:'SOL',decimals:9,from:solTrader,to:SOL,trader:solTrader,suggestedTrader:solTrader,source:'OKX_DEX_ROUTER',kind:'pending',raw:'100'};
 const records=[{...seed,id:'event',kind:'pending',feeEvent:true},{...seed,id:'underlying',kind:'ignore',supersededBy:['event']},{...seed,id:'paid',from:seed.to,to:seed.trader,direction:'out',kind:'pending',raw:'5000000000000'},sol,{...sol,id:'solpaid',from:SOL,to:solTrader,direction:'out',raw:'40'},{...sol,id:'randomdeposit',source:'UNKNOWN',raw:'9999'},{...sol,id:'vaultpayment',from:'11111111111111111111111111111111',raw:'9999'},{...seed,id:'unrelatedout',from:seed.to,to:'0x'+'9'.repeat(40),direction:'out',kind:'pending'}];
 const accounted=autoAccount(records),groups=summarize(accounted);
 assert.equal(groups.find(g=>g.chain==='4663').remaining,'10000000000000');assert.equal(groups.find(g=>g.chain==='solana').remaining,'60');
 assert.equal(accounted.filter(r=>r.autoExcluded).length,3);assert.equal(records[0].kind,'pending');assert.equal(accounted.find(r=>r.id==='underlying').kind,'ignore');
});
