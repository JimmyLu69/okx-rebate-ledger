import './fixtures.mjs';
import test from 'node:test';import assert from 'node:assert/strict';
import {EVM,decodeFeeLogs,autoAccount,summarize,SETTLEMENT_FEE_TOPIC,SETTLEMENT_TRADE_TOPIC} from '../dist/ledger.mjs';
import {reconcileFeeTransfers} from '../dist/extended-api.mjs';
const router='0x25ed72c3f671b626810a6db597dcfd50f215a423',token='0x'+'5'.repeat(40),owner='0x'+'2'.repeat(40),solver='0x'+'3'.repeat(40),hash='0x'+'a'.repeat(64);
const word=n=>BigInt(n).toString(16).padStart(64,'0'),address=a=>'0x'+a.slice(2).padStart(64,'0');
const uid=(who=owner)=>'d'.repeat(64)+who.slice(2)+'12345678';
const dynamic=u=>word(56)+u+'0'.repeat(16);
const fee=(u=uid(),raw=100n)=>({address:router,logIndex:'0x3',topics:[SETTLEMENT_FEE_TOPIC,address(token),address(EVM)],data:'0x'+word(128)+word(50)+word(raw)+word(0)+dynamic(u)});
const trade=(who=owner,u=uid(who))=>({address:router,logIndex:'0x8d',topics:[SETTLEMENT_TRADE_TOPIC,address(who),address(token),address(token)],data:'0x'+word(10000)+word(10000)+word(96)+dynamic(u)});
const chain={id:'56',symbol:'BNB',decimals:18},tx={hash,status:'ok',from:{hash:solver,is_contract:false},to:{hash:router}},meta={[token]:{symbol:'USDT',decimals:18}};
const receipt=raw=>({id:'receipt',chain:'56',asset:token,symbol:'USDT',decimals:18,raw:String(raw),from:router,to:EVM,trader:solver,kind:'pending',direction:'in',hash});
const decode=logs=>decodeFeeLogs(logs,chain,tx,meta);
test('settlement attributes actual commission to order owner, never solver or transfer contract',()=>{
 const fees=decode([fee(),trade()]);assert.equal(fees[0].trader,owner);assert.equal(fees[0].txSender,solver);
 const rows=autoAccount(reconcileFeeTransfers([receipt(100)],fees)),groups=summarize(rows);
 assert.equal(groups.length,1);assert.equal(groups[0].trader,owner);assert.equal(groups[0].due,'100');assert(rows.find(r=>r.id==='receipt').supersededBy);
});
test('settlement batch joins fees by full order UID, not nearest event or transaction sender',()=>{
 const other='0x'+'4'.repeat(40);const fees=decode([fee(uid(),40n),{...fee(uid(other),60n),logIndex:'0x4'},trade(other),trade()]);
 const groups=summarize(autoAccount(reconcileFeeTransfers([receipt(100)],fees)));
 assert.deepEqual(groups.map(g=>[g.trader,g.due]),[[owner,'40'],[other,'60']]);
});
test('missing or mismatched order, untrusted emitter, malformed ABI and receipt mismatch cannot credit anyone',()=>{
 for(const logs of [[fee()],[fee(),trade(solver)],[fee(),trade(solver,uid())]]){
  const rows=autoAccount(reconcileFeeTransfers([receipt(100)],decode(logs)));assert.equal(summarize(rows).length,0);
 }
 assert.equal(decode([{...fee(),address:solver},trade()]).length,0);
 assert.equal(decode([{...fee(),data:fee().data.slice(0,-2)},trade()]).length,0);
 assert.equal(decode([{...fee(),removed:true},trade()]).length,0);
 assert.equal(decodeFeeLogs([fee(),trade()],{...chain,id:'1'},tx,meta).length,0);
 assert.equal(summarize(autoAccount(reconcileFeeTransfers([receipt(99)],decode([fee(),trade()])))).length,0);
});
