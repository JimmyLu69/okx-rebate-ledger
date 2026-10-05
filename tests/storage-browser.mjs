// Optional real IndexedDB regression; no existing browser profile or real account data.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const modulePath=process.env.PLAYWRIGHT_MODULE||resolve(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const {chromium}=await import(pathToFileURL(modulePath).href);
const server=createServer(async(req,res)=>{try{if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html'}).end('<title>Isolated storage test</title>');return}const name=new URL(req.url,'http://localhost').pathname.slice(1);if(!/^[a-z-]+\.mjs$/.test(name))throw Error();res.writeHead(200,{'Content-Type':'text/javascript'}).end(await readFile(resolve(project,'dist',name)))}catch{res.writeHead(404).end()}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try{
 const bundled=chromium.executablePath(),executablePath=process.env.CHROMIUM_EXECUTABLE||await stat(bundled).then(()=>bundled,()=>'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
 browser=await chromium.launch({headless:true,executablePath});const context=await browser.newContext();const page=await context.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
 const results=await page.evaluate(async()=>{
  const outcomes=[];const expect=(ok,message)=>{if(!ok)throw Error(message)};
  const state=(records=[])=>({version:1,records,coverage:{1:{streams:{transactions:{complete:true,highBlock:10}},inspected:['h0'],inspectionErrors:{}}},decisions:{},lastRecheck:{started:'2026-10-05T00:00:00.000Z',entries:[{key:'a',status:'queued'}]}});
  // Seed the actual previous DB layout to verify migration, not a mocked API.
  await new Promise((resolve,reject)=>{const request=indexedDB.open('rebate-ledger',2);request.onupgradeneeded=()=>{const d=request.result;d.createObjectStore('wallets');d.createObjectStore('records',{keyPath:['wallet','id']}).createIndex('wallet','wallet')};request.onsuccess=()=>{const d=request.result,tx=d.transaction(['wallets','records'],'readwrite'),old=state([{id:'legacy',raw:'1'}]);const{records,...meta}=old;tx.objectStore('wallets').put({...meta,storageVersion:2,storageRevision:1},'legacy');tx.objectStore('records').put({wallet:'legacy',id:'legacy',value:records[0]});tx.oncomplete=()=>{d.close();resolve()};tx.onerror=()=>reject(tx.error)};request.onerror=()=>reject(request.error)});
  const storage=await import('/storage.mjs');const legacy=await storage.readHistory('legacy');await storage.writeHistory('legacy',legacy);storage.releaseHistory('legacy');const migrated=await storage.readHistory('legacy');expect(migrated.coverage[1].inspected[0]==='h0'&&migrated.lastRecheck.entries.length===1,'v2 metadata lost during parts migration');outcomes.push('v2 migration preserves inspected hashes and report entries');
  const database=await new Promise((resolve,reject)=>{const request=indexedDB.open('rebate-ledger',4);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
  const directWrite=(callback)=>new Promise((resolve,reject)=>{const tx=database.transaction(['wallets','records','parts'],'readwrite');callback(tx);tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error)});
  const storedParts=wallet=>new Promise((resolve,reject)=>{const request=database.transaction('parts').objectStore('parts').index('wallet').getAll(wallet);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
  // Seed the prior v3 layout directly: its parts must be deleted, not merely
  // hidden by a normalized in-memory baseline during the first chunked save.
  const oldHashes=Array.from({length:600},(_,i)=>'0x'+i.toString(16).padStart(64,'0'));
  const seedSingles=wallet=>directWrite(tx=>{
   const metadata=state();delete metadata.records;metadata.coverage[1].inspected=[];metadata.lastRecheck.entries=[];
   tx.objectStore('wallets').put({...metadata,storageVersion:3,storageRevision:1},wallet);
   for(const hash of oldHashes)tx.objectStore('parts').put({wallet,kind:'inspected',id:'1:'+hash,value:true});
  });
  await seedSingles('single-parts');const single=await storage.readHistory('single-parts');expect(single.coverage[1].inspected.length===600,'single-hash parts no longer readable');await storage.writeHistory('single-parts',single);
  const compacted=await storedParts('single-parts');expect(compacted.filter(p=>p.kind==='inspectedPage').length===3&&!compacted.some(p=>p.kind==='inspected'),'single-hash migration must remove obsolete rows');storage.releaseHistory('single-parts');expect((await storage.readHistory('single-parts')).coverage[1].inspected.join()===oldHashes.join(),'chunk read must preserve page order');outcomes.push('legacy single-hash parts migrate into ordered pages without stale rows');
  const large=state(Array.from({length:5000},(_,i)=>({id:'row-'+i,raw:'1',roles:{owner:'synthetic'}})));await storage.writeHistory('large',large);
  const originalPut=IDBObjectStore.prototype.put;let rowWrites=0,partWrites=0;
  IDBObjectStore.prototype.put=function(...args){if(this.name==='records')rowWrites++;if(this.name==='parts')partWrites++;return originalPut.apply(this,args)};
  const next={...large,records:[...large.records],coverage:{1:{...large.coverage[1],inspected:['h0','h1']}},lastRecheck:{...large.lastRecheck,entries:[{key:'a',status:'resolved'}]}};next.records[42]={...next.records[42],raw:'2'};await storage.writeHistory('large',next);IDBObjectStore.prototype.put=originalPut;
  expect(rowWrites===1&&partWrites===2,'expected one changed record + one inspected hash + one report write');expect(Object.isFrozen(next.records[42])&&Object.isFrozen(next.records[42].roles),'record identity must be immutable');outcomes.push('5,000-row checkpoint writes exactly one changed row and two metadata parts');
  const hashes=Array.from({length:50000},(_,i)=>'0x'+i.toString(16).padStart(64,'0')),paged=state();paged.coverage[1].inspected=hashes;await storage.writeHistory('pages',paged);
  expect((await storedParts('pages')).filter(p=>p.kind==='inspectedPage').length===196,'50k hashes should occupy 196 indexed rows');
  partWrites=0;const originalStringify=JSON.stringify;let serializations=0;
  IDBObjectStore.prototype.put=function(...args){if(this.name==='parts')partWrites++;return originalPut.apply(this,args)};JSON.stringify=function(...args){serializations++;return originalStringify.apply(this,args)};
  try{
   const a={...paged,coverage:{1:{...paged.coverage[1],inspected:[...hashes,'next-1']}}},b={...paged,coverage:{1:{...paged.coverage[1],inspected:[...hashes,'next-1','next-2']}}};
   await Promise.all([storage.writeHistory('pages',a),storage.writeHistory('pages',b)]);
  }finally{IDBObjectStore.prototype.put=originalPut;JSON.stringify=originalStringify}
  expect(partWrites===2&&serializations===0,'each queued append should write just the tail page without JSON snapshots');
  const roundtrip=await storage.readRawHistory('pages');expect(roundtrip.coverage[1].inspected.length===50002&&roundtrip.coverage[1].inspected[2560]===hashes[2560]&&roundtrip.coverage[1].inspected[50001]==='next-2','queued appends lost values or sorted page indexes lexically');
  const boundary=state();boundary.coverage[1].inspected=hashes.slice(0,256);await storage.writeHistory('boundary',boundary);partWrites=0;
  IDBObjectStore.prototype.put=function(...args){if(this.name==='parts')partWrites++;return originalPut.apply(this,args)};
  try{await storage.writeHistory('boundary',{...boundary,coverage:{1:{...boundary.coverage[1],inspected:hashes.slice(0,257)}}})}finally{IDBObjectStore.prototype.put=originalPut}
  expect(partWrites===1&&(await storedParts('boundary')).filter(p=>p.kind==='inspectedPage').length===2,'full-page append must create only its new page');outcomes.push('50,000 hashes use 196 pages and each append writes only the tail without JSON serialization');
  await seedSingles('legacy-recovery');const restored=state();restored.coverage[1].inspected=['restored-hash'];const legacyRecovery=await storage.writeHistory('legacy-recovery',restored,{recover:true});const legacyArchive=await storage.readRecoveryHistory(legacyRecovery.recoveryIds['legacy-recovery']);expect(legacyArchive.coverage[1].inspected.join()===oldHashes.join()&&(await storage.readRawHistory('legacy-recovery')).coverage[1].inspected[0]==='restored-hash','legacy recovery archive must retain single-hash parts');outcomes.push('atomic recovery preserves archives using the old single-hash layout');
  await storage.writeHistories([['evm',state([{id:'a',raw:'old'}])],['sol',state([{id:'b',raw:'old'}])]]);
  IDBObjectStore.prototype.put=function(value,...args){if(this.name==='wallets'&&args[0]==='sol')throw new DOMException('Synthetic quota','QuotaExceededError');return originalPut.call(this,value,...args)};
  let failed=false;try{await storage.writeHistories([['evm',state([{id:'a',raw:'new'}])],['sol',state([{id:'b',raw:'new'}])]])}catch{failed=true}finally{IDBObjectStore.prototype.put=originalPut}
  expect(failed&&(await storage.readRawHistory('evm')).records[0].raw==='old'&&(await storage.readRawHistory('sol')).records[0].raw==='old','cross-wallet transaction must roll back both');outcomes.push('multi-wallet quota failure atomically rolls back every wallet');
  try{await storage.readHistory('evm',{validate(){throw Error('Malformed historical value')}})}catch{}
  expect(storage.historyProtection('evm')?.code==='HISTORY_PROTECTED','read failure must protect');failed=false;try{await storage.writeHistory('evm',state())}catch(e){failed=e.code==='HISTORY_PROTECTED'}expect(failed&&(await storage.readRawHistory('evm')).records.length===1,'protected data overwritten');outcomes.push('read validation failure blocks empty-account overwrite');
  const replacement=state([{id:'fixed',raw:'restored'}]),recovery=await storage.writeHistory('evm',replacement,{recover:true});const archive=await storage.readRecoveryHistory(recovery.recoveryIds.evm);
  expect(archive.records[0].raw==='old'&&(await storage.readRawHistory('evm')).records[0].raw==='restored','recovery must preserve exact original');expect(!storage.historyProtection('evm'),'successful recovery clears protection');expect((await storage.listHistoryRecoveries('evm')).length===1,'recovery listing missing');outcomes.push('explicit recovery atomically archives the original before replacement');
  storage.protectHistory('evm');IDBObjectStore.prototype.put=function(value,...args){if(this.name==='wallets')throw new DOMException('Synthetic quota','QuotaExceededError');return originalPut.call(this,value,...args)};
  failed=false;try{await storage.writeHistory('evm',state(),{recover:true})}catch{failed=true}finally{IDBObjectStore.prototype.put=originalPut}
  expect(failed&&storage.historyProtection('evm')&&(await storage.readRawHistory('evm')).records[0].raw==='restored'&&(await storage.listHistoryRecoveries('evm')).length===1,'failed recovery altered archive, original, or lock');outcomes.push('failed recovery keeps original data, prior archive, and protection');
  const before=(await storage.storageDiagnostics()).retainedWallets;expect(storage.releaseHistory('large'),'release failed');expect((await storage.storageDiagnostics()).retainedWallets===before-1,'old wallet snapshot retained');outcomes.push('released wallet snapshots no longer consume the in-memory baseline');
  database.close();return outcomes;
 });
 assert.equal(results.length,10);for(const message of results)console.log('PASS '+message);
 const backupResults=await page.evaluate(async()=>{
  const expect=(ok,message)=>{if(!ok)throw Error(message)};
  const run=(message,{cancel=false}={})=>new Promise((resolve,reject)=>{const worker=new Worker('/backup-worker.mjs',{type:'module'}),progress=[];const timeout=setTimeout(()=>{worker.terminate();reject(Error('Backup worker timed out'))},10000);worker.onerror=e=>{clearTimeout(timeout);worker.terminate();reject(Error(e.message))};worker.onmessage=({data})=>{if(data.type==='progress'){progress.push(data);if(cancel)worker.postMessage({type:'cancel'});return}clearTimeout(timeout);worker.terminate();resolve({...data,progress})};worker.postMessage(message)});
  const value={format:'rebate-settings',version:1,wallets:{evm:'0x'+'1'.repeat(40),sol:''},preferences:{enabled:true,threshold:'0.1'},selected:['8453']};
  const plain=await run({type:'encode',value,compress:true});expect(plain.ok&&plain.progress.some(p=>p.phase==='serialize')&&plain.progress.some(p=>p.phase==='compress'),'Export must report progress');
  const imported=await run({type:'decode',kind:'auto',file:plain.blob,wallets:{evm:'0x'+'2'.repeat(40),sol:''}});expect(imported.ok&&imported.kind==='settings'&&imported.wallets.evm===value.wallets.evm,'Auto-detection must identify the file wallet before UI confirmation');
  const encrypted=await run({type:'encode',value,password:'long-browser-password'});expect(encrypted.ok,'Encrypted encode failed');
  const missing=await run({type:'decode',kind:'auto',file:encrypted.blob});expect(missing.code==='PASSWORD_REQUIRED','Encrypted backup must request a password');
  const decoded=await run({type:'decode',kind:'auto',file:encrypted.blob,password:'long-browser-password'});expect(decoded.ok&&decoded.value.preferences.threshold==='0.1','Encrypted settings round trip failed');
  const cancelled=await run({type:'encode',value:{records:Array.from({length:50000},(_,i)=>({id:i,raw:'x'.repeat(100)}))}},{cancel:true});expect(!cancelled.ok&&cancelled.code==='CANCELLED','Worker cancellation must finish the active operation');
  return ['backup worker auto-detects compressed settings and reports its source wallet','encrypted backup requests a password and restores the same settings','active backup serialization can be cancelled after progress'];
 });
 for(const message of backupResults)console.log('PASS '+message);await context.close();
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
