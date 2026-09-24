import {seed} from './fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {normalizeAllowlist,parseAllowlist,configureAssetAllowlist,assetAllowed} from '../dist/allowlist.mjs';
import {autoAccount,summarize,pendingReview,spamRecords} from '../dist/ledger.mjs';
const asset='0x'+'4'.repeat(40),allowed=[{chain:'4663',asset}];
test('default maintained list contains valid unique chain-specific identities',()=>{const rows=JSON.parse(fs.readFileSync(new URL('../dist/asset-allowlist.json',import.meta.url)));assert.equal(normalizeAllowlist(rows).length,rows.length)});
test('strict policy overrides old manual and automatic entries without deleting underlying history',()=>{
 configureAssetAllowlist([]);try{const original={...seed,asset,reviewed:true};const input=[original];const rows=autoAccount(input);assert.equal(rows[0].spam,true);assert.equal(spamRecords(input).length,1);assert.equal(summarize(rows).length,0);assert.equal(pendingReview(input).length,0);assert.equal(original.kind,'commission');assert.equal(spamRecords([{...original,spamDismissed:true}]).length,1);assert.equal(summarize(autoAccount([seed])).length,1);
 configureAssetAllowlist(allowed);assert.equal(summarize(autoAccount(input))[0].due,original.raw);assert.equal(summarize(autoAccount(rows))[0].due,original.raw);
 }finally{configureAssetAllowlist(null)}
});
test('allowlisting an asset is not a commission decision; chain and Solana mint case remain exact',()=>{
 configureAssetAllowlist([...allowed,{chain:'solana',asset:'So11111111111111111111111111111111111111112'}]);try{assert.equal(assetAllowed('1',asset),false);assert.equal(assetAllowed('4663',asset.toUpperCase().replace('0X','0x')),true);assert.equal(assetAllowed('solana','so11111111111111111111111111111111111111112'),false);assert.equal(pendingReview([{...seed,asset,kind:'pending',verified:false}]).length,1);assert.equal(summarize(autoAccount([{...seed,asset,kind:'pending',verified:false}])).length,0)}finally{configureAssetAllowlist(null)}
});
test('list imports reject invalid entries before replacing current policy, and accept empty lists',()=>{assert.deepEqual(parseAllowlist(''),[]);assert.deepEqual(parseAllowlist('4663 '+asset+'\n4663 '+asset),allowed);assert.throws(()=>parseAllowlist('4663 bad-address'));configureAssetAllowlist(allowed);try{assert.throws(()=>configureAssetAllowlist([{chain:'4663',asset:'bad'}]));assert.equal(assetAllowed('4663',asset),true)}finally{configureAssetAllowlist(null)}});
