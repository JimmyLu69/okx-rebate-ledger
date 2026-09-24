import {seed} from './fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {autoAccount,summarize,spamRecords,pendingReview,mergeRecords} from '../dist/ledger.mjs';
const token='0x'+'4'.repeat(40),other='0x'+'5'.repeat(40);
const fee={...seed,asset:token,symbol:'USD',decimals:6,raw:'7905239'};
const payment={...fee,id:'paid',kind:'pending',direction:'out',from:seed.to,to:seed.trader,txSender:seed.to,raw:'7900000'};
test('refund requires exact chain contract and trader, and verified initiating wallet',()=>{
 const rows=autoAccount([fee,payment,{...payment,id:'fake',asset:other},{...payment,id:'otherchain',chain:'8453'},{...payment,id:'thirdparty',txSender:other},{...payment,id:'unknown',txSender:undefined}]);
 assert.equal(rows.find(r=>r.id==='paid').kind,'refund');
 for(const id of ['fake','otherchain','thirdparty','unknown'])assert.equal(rows.find(r=>r.id===id).kind,'pending');
 assert.equal(summarize(rows)[0].remaining,'5239');
});
test('lookalike plus unrelated contract is quarantined without using token names; recoverable and idempotent',()=>{
 const poison={...payment,id:'poison',symbol:'Different name',asset:other,to:'0x2222'+'8'.repeat(32)+'2222',txSender:other};
 const input=[fee,payment,poison];
 assert.equal(spamRecords(input).length,1);assert.equal(pendingReview(input).length,0);
 assert.equal(summarize(autoAccount(input))[0].paid,'7900000');
 assert.deepEqual(summarize(autoAccount(autoAccount(input))),summarize(autoAccount(input)));
 const restored={...poison,spamDismissed:true};
 assert.equal(spamRecords([fee,restored]).length,0);assert.equal(pendingReview([fee,restored]).length,1);
 assert.equal(mergeRecords([restored],[poison])[0].spamDismissed,true);
 assert.equal(poison.spam,undefined);
});
test('unknown or same-name assets alone are not junk, provider flags are quarantined',()=>{
 const unknown={...payment,id:'unknown',asset:other};
 assert.equal(spamRecords([fee,unknown]).length,0);
 assert.equal(spamRecords([fee,{...unknown,sourceSpam:true}]).length,1);
 assert.equal(spamRecords([fee,{...unknown,reviewed:true,kind:'refund'}]).length,0);
});
