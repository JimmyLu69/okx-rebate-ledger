import {seed} from './fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {EVM,FEE_TOPICS,decodeFeeLogs,autoAccount,spamRecords,pendingReview,REPORTED_SPAM_ASSETS} from '../dist/ledger.mjs';
import {inspectEVM} from '../dist/api.mjs';
const address=n=>'0x'+n.repeat(40),word=x=>x.replace(/^0x/,'').padStart(64,'0');
const asset=address('4'),router=address('3'),chain={id:'4663',symbol:'ETH',decimals:18};
for(const [name,raw,topic,payer]of [['output',25264,FEE_TOPICS[1],router],['input',75000,FEE_TOPICS[0],seed.trader]]){
 test(`${name} token commission survives pagination, other referrers and repeated inspection`,async()=>{
  const fee=(recipient,amount,index)=>({index,address:{hash:router},topics:[topic],data:'0x'+word(asset)+word(amount.toString(16))+word(recipient)+word('b71b0')});
  const logs=[fee(address('5'),325000,4),fee(EVM,raw,22)];
  const rows=[{...seed,id:'transfer',asset,symbol:'USDG',decimals:6,raw:String(raw),from:payer,trader:'',kind:'pending',stream:'token-transfers'}];
  const tx={hash:seed.hash,status:'ok',from:{hash:seed.trader,is_contract:false},to:{hash:router}};
  const old=globalThis.fetch;let pages=0;
  globalThis.fetch=async(url,opts)=>{const req=JSON.parse(opts.body);let data;if(req.path.endsWith('/logs')){pages++;data=req.params.index?{items:[logs[1]],next_page_params:null}:{items:[logs[0]],next_page_params:{index:4}}}else data=tx;return new Response(JSON.stringify(data));};
  try{const r=await inspectEVM(chain,seed.hash,'test',{4663:[router]},rows);assert.equal(pages,2);assert.equal(r.fees.length,1);assert.equal(r.fees[0].raw,String(raw));assert.equal(r.fees[0].trader,seed.trader);assert.equal(r.fees[0].receiptMatched,true);assert.equal(r.replace[0].kind,'ignore');assert.equal(pendingReview([...r.replace,...r.fees]).length,0);const again=await inspectEVM(chain,seed.hash,'test',{4663:[router]},[...r.replace,...r.fees]);assert.equal(again.fees[0].receiptMatched,true);
   const uppercase=logs.map(l=>({...l,data:l.data.toUpperCase()}));assert.equal(decodeFeeLogs(uppercase,chain,tx,{[asset]:{symbol:'USDG',decimals:6}},[router])[0].raw,String(raw));
  }finally{globalThis.fetch=old}
 });
}
test('reported phishing matches chain and full contract or case-sensitive mint; never ticker',()=>{
 for(const key of REPORTED_SPAM_ASSETS){const [chain,asset]=key.split(':');const row={...seed,id:key,chain,asset,kind:'pending',direction:'out',symbol:'Anything',raw:'5000'};assert.equal(spamRecords([row]).length,1);assert.equal(pendingReview([row]).length,0);assert.equal(spamRecords([{...row,chain:'999'}]).length,0);assert.equal(spamRecords([{...row,asset:asset==='native'?address('7'):asset+'x'}]).length,0);assert.equal(pendingReview([{...row,spamDismissed:true}]).length,1);assert.equal(spamRecords([{...row,reviewed:true,kind:'refund'}]).length,0);}
});
test('inspection error is exposed rather than claiming no evidence exists',()=>{assert.match(autoAccount([{...seed,kind:'pending',feeEvent:false,inspectionError:'API unavailable'}])[0].reviewReason,/API unavailable/)});
