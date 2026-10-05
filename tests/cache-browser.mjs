// Isolated real-IndexedDB regression checks; never use an existing browser profile.
// Run: node tests/cache-browser.mjs (optional PLAYWRIGHT_MODULE / CHROMIUM_EXECUTABLE).
import assert from 'node:assert/strict';import {createServer} from 'node:http';import {readFile,stat} from 'node:fs/promises';import {createRequire} from 'node:module';import {homedir} from 'node:os';import {resolve,dirname} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(import.meta.url);let playwright;
for(const name of [process.env.PLAYWRIGHT_MODULE,'playwright',resolve(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')].filter(Boolean))try{playwright=name==='playwright'?require(name):await import(pathToFileURL(resolve(name)).href);break}catch{}
if(!playwright)throw Error('Install Playwright or set PLAYWRIGHT_MODULE');
const server=createServer(async(req,res)=>{try{const name=new URL(req.url,'http://localhost').pathname;if(name==='/')return res.end('<!doctype html><title>Synthetic cache tests</title>');if(name.includes('..'))throw Error();res.setHeader('Content-Type','text/javascript');res.end(await readFile(resolve(root,'dist','.'+name)))}catch{res.writeHead(404).end()}});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
let browser;
try{
 const bundled=playwright.chromium.executablePath(),executablePath=process.env.CHROMIUM_EXECUTABLE||await stat(bundled).then(()=>bundled,()=>process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined);
 browser=await playwright.chromium.launch({headless:true,...(executablePath?{executablePath}:{})});const context=await browser.newContext(),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base);
 const empty=await page.evaluate(async()=>{const m=await import('/evidence-cache.mjs');m.configureEvidenceCache({active:true});await m.clearEvidenceCache();return Promise.race([m.getEvidence('missing'),new Promise(r=>setTimeout(()=>r('hung'),300))])});assert.equal(empty,null);
 const warm=await page.evaluate(async()=>{const m=await import('/evidence-cache.mjs'),api=await import('/api.mjs'),hash='0x'+'a'.repeat(64),key=m.evidenceKey('/api/blockscout',{body:JSON.stringify({chain:'8453',path:'transactions/'+hash,params:{}})});await m.putEvidence(key,{hash,status:'ok'});const old=fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('No network expected')};try{const at=performance.now();await api.bs('8453','transactions/'+hash,'synthetic');await api.bs('8453','transactions/'+hash,'synthetic');return{calls,ms:performance.now()-at,key}}finally{globalThis.fetch=old}});assert.equal(warm.calls,0);assert(warm.ms<100);
 await page.reload();const persisted=await page.evaluate(async key=>(await import('/evidence-cache.mjs')).getEvidence(key),warm.key);assert.equal(persisted.hash,'0x'+'a'.repeat(64));
 const cancelled=await page.evaluate(async()=>{const m=await import('/evidence-cache.mjs'),old=IDBObjectStore.prototype.get;IDBObjectStore.prototype.get=function(...args){if(this.name==='responses')return {};return old.apply(this,args)};const signal=AbortSignal.timeout(20);try{await m.getEvidence('never-finishes',{signal});return false}catch{return signal.aborted}finally{IDBObjectStore.prototype.get=old}});assert(cancelled);
 const other=await context.newPage();await other.goto(base);
 const reserve=page=>page.evaluate(async()=>{const m=await import('/network.mjs');await m.waitForProvider('blockscout',new AbortController().signal);return Date.now()});const times=await Promise.all([reserve(page),reserve(other)]);assert(Math.abs(times[0]-times[1])>=220,'Provider budget must be shared across pages');
 const evm='0x'+'1'.repeat(40),sol='So11111111111111111111111111111111111111112';
 const lock=async(target,wallets)=>target.evaluate(async wallets=>{try{globalThis.__releaseWalletTask=await(await import('/task-coordinator.mjs')).acquireWalletTask(wallets,new AbortController().signal);return 'held'}catch(error){return error.message}},wallets);
 const release=target=>target.evaluate(()=>{globalThis.__releaseWalletTask?.();globalThis.__releaseWalletTask=null});
 const settle=target=>target.evaluate(()=>new Promise(resolve=>setTimeout(resolve,0)));
 assert.equal(await lock(page,{sol}),'held');
 assert.match(await lock(other,{evm,sol}),/另一个页面/,'Overlapping wallet must reject the second task');
 assert.equal(await lock(other,{evm}),'held','Failed combined acquisition must release its earlier EVM lock');
 await release(other);await release(page);await settle(page);
 assert.equal(await lock(page,{evm}),'held');
 assert.match(await lock(other,{evm}),/另一个页面/,'The same wallet cannot run in two tabs');
 await release(page);await settle(page);assert.equal(await lock(other,{evm}),'held');await release(other);await settle(other);
 const aborted=await page.evaluate(async wallets=>{const signal=AbortSignal.abort(new DOMException('Synthetic cancellation','AbortError'));try{await(await import('/task-coordinator.mjs')).acquireWalletTask(wallets,signal);return false}catch(error){return error.name==='AbortError'}},{evm});assert(aborted);
 assert.equal(await lock(other,{evm}),'held','Cancelled acquisition must leave no lock');await other.close();
 await page.waitForFunction(async name=>!(await navigator.locks.query()).held.some(lock=>lock.name===name),'rebate-task:evm:'+evm);
 assert.equal(await lock(page,{evm}),'held','Closing the owning tab must release its lock');await release(page);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({browser:browser.version(),emptyCache:empty,persisted:true,cancelled,warmCacheMs:warm.ms,crossPageSpacingMs:Math.abs(times[0]-times[1]),walletLockCases:6}));await context.close();
}finally{await browser?.close();await new Promise(r=>server.close(r))}
