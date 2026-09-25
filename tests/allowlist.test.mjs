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

test('default upgrades preserve additions and removals, including legacy settings and subsequent reloads',async()=>{
 const {upgradeAllowlist}=await import('../dist/allowlist.mjs');
 const defaults=JSON.parse(fs.readFileSync(new URL('../dist/asset-allowlist.json',import.meta.url)));
 const old=normalizeAllowlist(defaults.filter(r=>!r.introduced));
 const saved=[...old.slice(1),...allowed];
 const migrated=upgradeAllowlist(saved,defaults);
 assert.equal(migrated.assets.length,saved.length+6);
 assert(!migrated.assets.some(r=>r.chain===old[0].chain&&r.asset===old[0].asset));
 assert(migrated.assets.some(r=>r.asset===asset));
 assert.deepEqual(upgradeAllowlist(migrated,defaults),migrated);
 const removed={...migrated,assets:migrated.assets.filter(r=>r.asset!==defaults.at(-1).asset)};
 assert.deepEqual(upgradeAllowlist(removed,defaults),removed);
 assert.equal(upgradeAllowlist(null,defaults).assets.length,28);
});
test('new exact identities recover prior false positives without accepting ticker impostors',()=>{
 const defaults=JSON.parse(fs.readFileSync(new URL('../dist/asset-allowlist.json',import.meta.url)));
 configureAssetAllowlist(defaults);
 try{for(const r of defaults.filter(r=>r.introduced===2)){
  assert.equal(assetAllowed(r.chain,r.asset),true);
  const record={...seed,chain:r.chain,asset:r.asset,symbol:r.label};
  assert.equal(spamRecords([record]).length,0);
  assert.equal(spamRecords([{...record,asset:r.chain==='solana'?'A'.repeat(44):asset}]).length,1);
 }}finally{configureAssetAllowlist(null)}
});

test('revoked fake USDbC is removed from saved policy and cannot be restored by old imports or manual marks',async()=>{
 const {upgradeAllowlist}=await import('../dist/allowlist.mjs');const defaults=JSON.parse(fs.readFileSync(new URL('../dist/asset-allowlist.json',import.meta.url)));
 const fake={chain:'8453',asset:'0x006a8a2b11b44a402428492fd5b9b5a483090614'};
 const policy=upgradeAllowlist({assets:[fake,...allowed],knownDefaults:defaults.filter(r=>r.introduced!==3)},defaults);
 assert(!policy.assets.some(r=>r.asset===fake.asset));assert(policy.assets.some(r=>r.asset==='0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca'));
 configureAssetAllowlist([fake]);try{assert.equal(assetAllowed(fake.chain,fake.asset),false);assert.equal(spamRecords([{...seed,...fake,reviewed:true}]).length,1)}finally{configureAssetAllowlist(null)}
});
