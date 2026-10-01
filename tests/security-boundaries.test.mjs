import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {seed} from './fixtures.mjs';
import {validateRecord,validateState,validateHistoryBackup,validateSettingsBackup,validateRecheckReport} from '../dist/validation.mjs';
import {encryptBackup,decryptBackup,isEncryptedBackup} from '../dist/backup-crypto.mjs';
import {csvCell,encodeCsv} from '../dist/csv.mjs';
import {readJsonLimited,withRelaySlot,cachedPublicQuery} from '../server/safety.mjs';
import {handleLinea,validateLineaQuery} from '../server/linea-proxy.mjs';
import {handleBlockscout} from '../server/blockscout-proxy.mjs';
import {handlePrices} from '../server/prices-proxy.mjs';
import handler,{config} from '../netlify/functions/api.mjs';
const origin='https://ledger.test';
const request=(path,body)=>new Request(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
const state=()=>({version:1,records:[{...seed}],coverage:{'4663':{status:'complete',inspected:[seed.hash],streams:{transactions:{complete:true,highBlock:100}}}},selected:['4663'],updated:'2026-10-01T00:00:00.000Z'});
const backup=()=>({format:'rebate-history',backupVersion:2,createdAt:'2026-10-01T00:00:00.000Z',wallets:{evm:seed.to,sol:''},state:state()});
test('history report rejects executable numeric payload and discards unexpected fields',()=>{
 const report={started:'2026-10-01T00:00:00.000Z',before:1,total:1,entries:[{key:'not-trusted',chain:seed.chain,hash:seed.hash,before:1,after:0,status:'resolved',error:'',html:'<script>alert(1)</script>'}]};
 assert.equal(validateRecheckReport(report).entries[0].key,seed.chain+':'+seed.hash);assert.equal(validateRecheckReport(report).entries[0].html,undefined);
 for(const key of ['before','after'])assert.throws(()=>validateRecheckReport({...report,entries:[{...report.entries[0],[key]:'<img src=x onerror=alert(1)>'}]}));
 const data=backup();data.state.lastRecheck={...report,before:'<svg onload=alert(1)>'};assert.throws(()=>validateHistoryBackup(data));
});
test('history external provenance requires recheck, preserves progress and separated human decisions',()=>{
 const b=backup();b.state.records[0].reviewed=true;b.state.records[0].receiptMatched=true;b.state.evil='dropped';b.state.decisions={[seed.id]:{kind:'commission',trader:seed.trader,reason:'人工恢复',updatedAt:'2026-10-01T00:00:00.000Z'}};
 const restored=validateHistoryBackup(b,{wallets:b.wallets}).state;
 assert.equal(restored.records[0].importedUnverified,true);assert.equal(restored.records[0].kind,'pending');assert.equal(restored.records[0].reviewed,undefined);assert.equal(restored.records[0].receiptMatched,true);
 assert.equal(restored.decisions[seed.id].kind,'commission');assert.equal(restored.coverage['4663'].streams.transactions.highBlock,100);assert.equal(restored.coverage['4663'].status,'stale');assert.deepEqual(restored.coverage['4663'].inspected,[]);assert.equal(restored.evil,undefined);
 assert.equal(validateState(b.state,{trustEvidence:true}).records[0].verified,true);const legacy=backup();legacy.state.records[0].reviewed=true;assert.equal(validateHistoryBackup(legacy).state.decisions,undefined);assert.equal(validateState(legacy.state).decisions[seed.id].kind,'commission');
 assert.throws(()=>validateHistoryBackup(b,{wallets:{evm:seed.trader,sol:''}}),/钱包/);
});
test('record, coverage, settings and decisions reject malformed values without prototype pollution',()=>{
 for(const r of [{...seed,raw:'1e6'},{...seed,decimals:1000},{...seed,from:'javascript:alert(1)'},{...seed,verified:'true'},{...seed,id:'wrong:identity'}])assert.throws(()=>validateRecord(r));
 assert.throws(()=>validateState({...state(),records:[seed,seed]}),/重复/);
 assert.throws(()=>validateState({...state(),coverage:JSON.parse('{"__proto__":{"streams":{},"inspected":[]}}')}));
 assert.throws(()=>validateState({...state(),decisions:{[seed.id]:{kind:'refund',trader:seed.trader,reason:'wrong direction',updatedAt:'2026-10-01T00:00:00Z'}}}));
 const settings={format:'rebate-settings',version:1,wallets:{evm:seed.to,sol:''},preferences:{enabled:true,threshold:'0.1'},selected:['1'],credentials:{helius:'example',xlayer:null},credentialMode:'session',scanOptions:{56:{startBlock:100}}};
 assert.equal(validateSettingsBackup({...settings,html:'<svg>'}).html,undefined);assert.equal(validateSettingsBackup(settings).credentialMode,'session');
 assert.throws(()=>validateSettingsBackup({...settings,preferences:{threshold:'<img>'}}));assert.throws(()=>validateSettingsBackup({...settings,credentials:{helius:'evil\nheader'}}));
 assert.equal({}.polluted,undefined);
});
test('portable encrypted backup authenticates content and rejects wrong password and expensive metadata',async()=>{
 const encrypted=await encryptBackup({private:'synthetic-api-key',records:[]},'test-password-long');assert(isEncryptedBackup(encrypted));assert.equal(JSON.stringify(encrypted).includes('synthetic-api-key'),false);
 assert.deepEqual(await decryptBackup(encrypted,'test-password-long'),{private:'synthetic-api-key',records:[]});
 await assert.rejects(decryptBackup(encrypted,'wrong-password'),/口令/);
 const changed={...encrypted,data:(encrypted.data[0]==='A'?'B':'A')+encrypted.data.slice(1)};await assert.rejects(decryptBackup(changed,'test-password-long'),/修改/);
 await assert.rejects(decryptBackup({...encrypted,iterations:1000000000},'test-password-long'),/格式/);
 await assert.rejects(encryptBackup({},'short'),/口令/);
});
test('CSV protects formulas hidden behind control characters, whitespace and Unicode formatting',()=>{
 for(const v of ['=1+1','\t=cmd()','\r\n@SUM(1,1)','  +1','\ufeff-1','\u200b=1'])assert.equal(csvCell(v).slice(0,2),'"\'');
 assert.equal(csvCell('plain "name"'),'"plain ""name"""');assert(encodeCsv([['币种','金额'],['USDC',1]]).startsWith('\ufeff'));
});
test('streaming request limit stops reading before consuming the complete malicious body',async()=>{
 let pulled=0,cancelled=false;const stream=new ReadableStream({pull(controller){pulled++;controller.enqueue(new Uint8Array(1024));if(pulled===100)controller.close()},cancel(){cancelled=true}});
 const req=new Request(origin,{method:'POST',body:stream,duplex:'half'});
 await assert.rejects(readJsonLimited(req,2048),e=>e.status===413);assert(cancelled);assert(pulled<10);
 let declaredCancelled=false;const declared=new Response(new ReadableStream({cancel(){declaredCancelled=true}}),{headers:{'content-length':'999999'}});await assert.rejects(readJsonLimited(declared,10),e=>e.status===413);assert(declaredCancelled);
 const bytes=new TextEncoder().encode('{"x":"中文"}');const multibyte=new Response(bytes);await assert.rejects(readJsonLimited(multibyte,bytes.length-1),e=>e.status===413);
});
test('Linea allows finalized header required by full scan but rejects full blocks, arbitrary tags and extra fields',async()=>{
 assert.deepEqual(validateLineaQuery({method:'eth_getBlockByNumber',params:['finalized',false]}),{method:'eth_getBlockByNumber',params:['finalized',false]});
 for(const body of [{method:'eth_getBlockByNumber',params:['latest',false]},{method:'eth_getBlockByNumber',params:['finalized',true]},{method:'eth_getBlockByNumber',params:['finalized',false],url:'https://evil.test'},{method:'eth_getCode',params:['0x'+'1'.repeat(40),'pending']}])assert.throws(()=>validateLineaQuery(body));
 let calls=0;const fetcher=async(url,opts)=>{calls++;assert.equal(JSON.parse(opts.body).params[0],'finalized');return Response.json({result:{number:'0x64'}})};
 const results=await Promise.all([1,2].map(()=>handleLinea(request('/api/linea',{method:'eth_getBlockByNumber',params:['finalized',false]}),fetcher)));
 assert.equal(calls,1);for(const r of results){assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store')}
});
test('credential relay does not cache credential-bearing responses and permits exact transaction evidence endpoints',async()=>{
 let calls=0;const fetcher=async()=>{calls++;return Response.json({items:[]})};
 for(const suffix of ['token-transfers','internal-transactions']){
  const r=await handleBlockscout(request('/api/blockscout',{chain:'8453',path:`transactions/${seed.hash}/${suffix}`,key:'synthetic',params:{}}),fetcher);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
 }
 assert.equal(calls,2);assert.equal((await handleBlockscout(request('/api/blockscout',{chain:'8453',path:`transactions/${seed.hash}`,key:'synthetic',params:{index:{bad:true}}}),fetcher)).status,400);
 assert.equal((await handlePrices(request('/api/prices',{assets:[{chain:'1',asset:'native',url:'https://evil.test'}]}),fetcher)).status,400);
});
test('Netlify deploy has platform rate limiting, explicit circuit breaker and instance concurrency bound',async()=>{
 assert.deepEqual(config.rateLimit.aggregateBy,['ip','domain']);assert(config.rateLimit.windowLimit>0&&config.rateLimit.windowSize<=180);
 const old=process.env.API_RELAY_DISABLED;process.env.API_RELAY_DISABLED='true';try{assert.equal((await handler(request('/api/linea',{}))).status,503)}finally{if(old===undefined)delete process.env.API_RELAY_DISABLED;else process.env.API_RELAY_DISABLED=old}
 let release;const pending=new Promise(resolve=>release=resolve),running=Array.from({length:8},()=>withRelaySlot(()=>pending));assert.equal((await withRelaySlot(()=>assert.fail('over capacity'))).status,429);release(Response.json({ok:true}));await Promise.all(running);
});
test('public cache is bounded and rejected upstream promises are retried',async()=>{
 let calls=0;const fetcher=()=>{};const attempt=()=>{calls++;throw Error('failure')};await assert.rejects(cachedPublicQuery(fetcher,'failed',1000,attempt));await assert.rejects(cachedPublicQuery(fetcher,'failed',1000,attempt));assert.equal(calls,2);let oversized=0;const large=()=>{oversized++;return {data:'a'.repeat(256*1024)}};await cachedPublicQuery(fetcher,'large',1000,large);await cachedPublicQuery(fetcher,'large',1000,large);assert.equal(oversized,2);
});
test('deploy CSP rejects inline scripts and embedding while keeping only declared API destinations',async()=>{
 const text=await readFile(new URL('../netlify.toml',import.meta.url),'utf8');assert(text.includes("script-src 'self';"));assert(text.includes("frame-ancestors 'none'"));assert(text.includes("object-src 'none'"));assert(!text.includes("script-src 'self' 'unsafe-inline'"));
});
