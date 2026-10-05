// Optional isolated browser verification. Does not inspect existing browser profiles.
// Run: node tests/profile-browser.mjs
// Overrides: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs
//            CHROMIUM_EXECUTABLE=/path/to/chromium  BROWSER_SMOKE_URL=http://127.0.0.1:PORT
//            SMOKE_SCREENSHOT_DIR=/tmp/rebate-final-ui
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,stat,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {resolve,dirname,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {decryptBackup} from '../dist/backup-crypto.mjs';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..'),dist=resolve(project,'dist');
async function loadPlaywright(){
 const require=createRequire(import.meta.url);
 const candidates=[process.env.PLAYWRIGHT_MODULE,'playwright',resolve(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')].filter(Boolean);
 for(const name of candidates)try{return name==='playwright'?require(name):await import(name.startsWith('file:')?name:pathToFileURL(resolve(name)).href)}catch{}
 throw Error('Playwright 未安装。安装后运行，或设置 PLAYWRIGHT_MODULE 指向其 index.mjs。');
}
const {chromium}=await loadPlaywright();let server,browser;
const failures=[],passed=[];
const own='0x'+'1'.repeat(40),trader='0x'+'2'.repeat(40),router='0x'+'3'.repeat(40),tx='0x'+'a'.repeat(64);
const asset='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',walletKey=`rebate-ledger-wallet:${own}:`;
const row={id:`8453:${tx}:fee:1`,chain:'8453',asset,symbol:'USDC',decimals:6,raw:'1000000',hash:tx,from:router,to:own,trader,direction:'in',kind:'commission',time:'2026-10-01T00:00:00.000Z',feeEvent:true,verified:true,attributionVerified:true,receiptMatched:true,protocol:'legacy-router',roles:{router,owner:trader,transactionSender:trader},evidence:'Isolated synthetic fixture'};
const seed=()=>({version:1,decoderVersion:4,records:[{...row}],decisions:{},selected:['8453'],coverage:{8453:{status:'complete',streams:{'token-transfers':{complete:true,highBlock:100}},inspected:[tx]}},updated:'2026-10-01T00:00:00.000Z',lastRecheck:{started:'2026-10-01T00:00:00.000Z',finished:'2026-10-01T00:01:00.000Z',before:1,total:1,entries:[{key:'8453:'+tx,chain:'8453',hash:tx,before:1,after:1,status:'failed',error:'<img src=x onerror="window.__injected=true"> literal test text'}]}});
const envelope=state=>({format:'rebate-history',backupVersion:2,createdAt:'2026-10-01T00:02:00.000Z',wallets:{evm:own,sol:''},state});
const file=(name,data)=>({name,mimeType:'application/json',buffer:Buffer.from(typeof data==='string'?data:JSON.stringify(data))});
async function startServer(){
 if(process.env.BROWSER_SMOKE_URL)return process.env.BROWSER_SMOKE_URL.replace(/\/$/,'');
 const toml=await readFile(resolve(project,'netlify.toml'),'utf8'),csp=toml.match(/Content-Security-Policy\s*=\s*"([^"]+)"/)?.[1];
 server=createServer(async(req,res)=>{
  try{
   const pathname=new URL(req.url,'http://localhost').pathname;
   if(pathname.startsWith('/api/')){res.writeHead(503,{'Content-Type':'application/json'}).end('{"message":"Synthetic browser test: network APIs disabled"}');return}
   const path=resolve(dist,'.'+(pathname==='/'?'/index.html':decodeURIComponent(pathname)));
   if(!path.startsWith(dist+'/')){res.writeHead(403).end();return}
   const body=await readFile(path),type={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.ttf':'font/ttf','.woff2':'font/woff2','.png':'image/png'}[extname(path)]||'application/octet-stream';
   res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store',...(csp?{'Content-Security-Policy':csp}:{})});res.end(body);
  }catch{res.writeHead(404).end()}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return 'http://127.0.0.1:'+server.address().port;
}
async function readDownload(download){const stream=await download.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);const bytes=Buffer.concat(chunks);return bytes[0]===31&&bytes[1]===139?gunzipSync(bytes):bytes}
async function closeDialogs(page){for(const dialog of await page.locator('dialog[open]').all())await dialog.evaluate(el=>el.close())}
async function localSetting(page,key){return page.evaluate(key=>JSON.parse(localStorage.getItem(key)||'null'),key)}
async function currentHistory(page){return page.evaluate(async wallets=>(await import('./profile-storage.mjs')).readProfile(wallets),{evm:own,sol:''})}
async function chooseFile(page,id,name,value){await page.locator(id).setInputFiles(file(name,value))}
async function check(name,run){try{await run();passed.push(name);console.log('PASS '+name)}catch(error){failures.push({name,error:error.stack||error.message});console.error('FAIL '+name+'\n'+(error.stack||error.message))}}
try{
 const base=await startServer(),modulePath=chromium.executablePath();
 const executablePath=process.env.CHROMIUM_EXECUTABLE||await stat(modulePath).then(()=>modulePath,()=>process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined);
 browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{}),args:['--disable-extensions','--disable-background-networking']});
 const context=await browser.newContext({viewport:{width:1280,height:900},acceptDownloads:true,serviceWorkers:'block'});
 // Synthetic data is installed only into this new temporary context. No real keys.
 await context.addInitScript(({seed,own,key})=>{if(!location.protocol.startsWith('http'))return;if(!sessionStorage.getItem('smoke-seeded')){localStorage.setItem('rebate-wallets-v1',JSON.stringify({evm:own,sol:''}));localStorage.setItem(key,JSON.stringify(seed));localStorage.setItem('rebate-preferences-v1',JSON.stringify({enabled:true,threshold:'0.1'}));localStorage.setItem('rebate-credentials-v1',JSON.stringify({blockscout:'example-never-real',helius:'',nodereal:'',etherscan:'',xlayer:null}));sessionStorage.setItem('smoke-seeded','yes')}window.__injected=false},{seed:seed(),own,key:walletKey});
 await context.route('**/*',route=>new URL(route.request().url()).origin===new URL(base).origin?route.continue():route.abort('blockedbyclient'));
 const page=await context.newPage(),pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
 await page.goto(base,{waitUntil:'networkidle'});
 await page.locator('#rowCount').filter({hasText:/个地址/}).waitFor({timeout:15000});

 await check('account shards retain the same EVM history when Solana selection changes',async()=>{
  const result=await page.evaluate(async({own,row})=>{
   const storage=await import('./storage.mjs'),profile=await import('./profile-storage.mjs');
   const sol='So11111111111111111111111111111111111111112',otherSol='11111111111111111111111111111111',signature='A'.repeat(88);
   const combined={version:1,decoderVersion:4,records:[row,{...row,id:'solana:'+signature+':native:0',chain:'solana',asset:'native',symbol:'SOL',decimals:9,hash:signature,from:otherSol,to:sol,trader:'',kind:'pending',feeEvent:false,verified:false,attributionVerified:false,receiptMatched:false,roles:{}}],coverage:{},selected:['8453','solana'],decisions:{},updated:null};
   await storage.writeHistory(profile.profileKey({evm:own,sol}),combined);
   const migrated=await profile.readProfile({evm:own,sol});await profile.writeProfile({evm:own,sol},migrated);
   const without=await profile.readProfile({evm:own,sol:''}),changed=await profile.readProfile({evm:own,sol:otherSol});
   await profile.writeProfile({evm:own,sol:otherSol},changed);
   return{migrated:migrated.records.length,without:without.records.length,changed:changed.records.length,originalSol:(await profile.readProfile({evm:'',sol})).records.length,legacy:(await storage.readRawHistory(profile.profileKey({evm:own,sol}))).records.length};
  },{own,row});
  assert.deepEqual(result,{migrated:2,without:1,changed:1,originalSol:1,legacy:2});
 });
 await check('stored worker export reads the selected account without sending ledger records',async()=>{
  const output=await page.evaluate(async own=>{
   const worker=new Worker('./backup-worker.mjs',{type:'module'});try{return await new Promise((resolve,reject)=>{worker.onerror=e=>reject(Error(e.message));worker.onmessage=async({data})=>{if(data.type==='progress')return;data.ok?resolve(JSON.parse(await data.blob.text())):reject(Error(data.error))};worker.postMessage({type:'encodeStored',wallets:{evm:own,sol:''}})})}finally{worker.terminate()}
  },own);
  assert.equal(output.wallets.evm,own);assert.equal(output.state.records.length,1);assert.equal(output.state.records[0].hash,row.hash);
 });
 await check('clearing credentials invalidates every open tab and cannot resurrect the old key',async()=>{
  const other=await context.newPage();await other.goto(base,{waitUntil:'networkidle'});await other.locator('#rowCount').filter({hasText:/个地址/}).waitFor();
  await page.locator('#setupButton').click();await page.locator('#clearCredentials').click();
  await other.waitForFunction(()=>document.querySelector('#toast').textContent.includes('另一个页面'));await other.locator('#setupButton').click();
  assert.equal(await other.locator('#blockscoutKey').inputValue(),'');assert.equal(await localSetting(other,'rebate-credentials-v1'),null);
  await other.locator('#saveSettings').click();await other.locator('#settings').waitFor({state:'hidden'});
  assert.equal((await localSetting(other,'rebate-credentials-v1'))?.blockscout||'','','Saving in the second tab must not restore its earlier credential');
  await other.close();await closeDialogs(page);
 });
 await check('quota failure still permits export of the complete in-memory ledger',async()=>{
  await page.evaluate(async own=>{const profile=await import('./profile-storage.mjs');const state=await profile.readProfile({evm:own,sol:''});state.decoderVersion=3;await profile.writeProfile({evm:own,sol:''},state);sessionStorage.setItem('quota-audit','yes')},own);
  await context.addInitScript(()=>{if(sessionStorage.getItem('quota-audit')){const original=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(names,mode,...rest){if(this.name==='rebate-ledger'&&mode==='readwrite')throw new DOMException('Synthetic quota exhausted','QuotaExceededError');return original.call(this,names,mode,...rest)}}});
  await page.reload({waitUntil:'networkidle'});await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('历史保存失败'),null,{timeout:10000});
  await page.locator('#backupCenterButton').click();await page.locator('#compressBackup').uncheck();
  const downloading=page.waitForEvent('download');await page.locator('#backupButton').click();const exported=JSON.parse((await readDownload(await downloading)).toString());
  assert.equal(exported.state.records.length,1);assert.equal(exported.state.records[0].raw,row.raw);assert((await page.locator('#backupProgress').innerText()).includes('尚未保存'));
  await page.evaluate(()=>sessionStorage.removeItem('quota-audit'));await page.reload({waitUntil:'networkidle'});await page.locator('#rowCount').filter({hasText:/个地址/}).waitFor();
 });
 await check('bad saved history remains protected when settings are saved',async()=>{
  await page.evaluate(async({own,row})=>{const storage=await import('./storage.mjs'),key='rebate-ledger-account:evm:'+own;await storage.readHistory(key);await storage.writeHistory(key,{version:1,decoderVersion:4,records:[{...row,raw:'BROKEN ORIGINAL'}],coverage:{},selected:['8453'],decisions:{},updated:null})},{own,row});
  await page.reload({waitUntil:'networkidle'});await page.locator('#recoveryNotice').waitFor({state:'visible'});assert(await page.locator('#syncButton').isDisabled());
  await page.locator('#setupButton').click();await page.locator('#blockscoutKey').fill('synthetic');
  for(const id of await page.locator('#chainChoices input:checked').evaluateAll(inputs=>inputs.map(input=>input.dataset.chain)))if(id!=='8453')await page.locator('#chainChoices input[data-chain="'+id+'"]').uncheck();
  await page.locator('#saveSettings').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('历史读取异常'));
  const raw=await page.evaluate(async own=>(await import('./storage.mjs')).readRawHistory('rebate-ledger-account:evm:'+own),own);assert.equal(raw.records[0].raw,'BROKEN ORIGINAL');await closeDialogs(page);
 });
 await check('explicit recovery preserves the original and exposes it in the rescue download',async()=>{
  await page.locator('#backupCenterButton').click();await chooseFile(page,'#importFile','recovery.json',envelope(seed()));await page.locator('#importPreview[open]').waitFor();
  assert((await page.locator('#confirmImport').innerText()).includes('保留原数据'));await page.locator('#confirmImport').click();await page.locator('#importPreview').waitFor({state:'hidden'});
  assert.equal((await currentHistory(page)).records.length,1);assert(!(await page.locator('#recoveryNotice').isVisible()));
  await page.locator('#backupCenterButton').click();await page.locator('#exportRecovery').waitFor({state:'visible'});
  const downloading=page.waitForEvent('download');await page.locator('#exportRecovery').click();const raw=JSON.parse((await readDownload(await downloading)).toString());
  assert(JSON.stringify(raw).includes('BROKEN ORIGINAL'),'Rescue download must include the pre-recovery original, not just restored records');await closeDialogs(page);
 });
 await check('importing a different wallet requires confirmation and preserves the previous account',async()=>{
  const next='0x'+'8'.repeat(40),data=envelope(seed());data.wallets.evm=next;data.state.records[0].to=next;
  await page.locator('#backupCenterButton').click();await chooseFile(page,'#importFile','other-wallet.json',data);await page.locator('#importPreview[open]').waitFor();assert.equal((await localSetting(page,'rebate-wallets-v1')).evm,own);
  await page.locator('#confirmImport').click();await page.locator('#importPreview').waitFor({state:'hidden'});assert.equal((await localSetting(page,'rebate-wallets-v1')).evm,next);
  const old=await page.evaluate(async own=>(await import('./profile-storage.mjs')).readProfile({evm:own,sol:''}),own);assert.equal(old.records.length,1);assert.equal(old.records[0].to,own);
 });
 assert.deepEqual(pageErrors,[]);console.log(JSON.stringify({passed:passed.length,failed:failures.length,failures},null,2));await context.close();if(failures.length)process.exitCode=1;
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve))}
