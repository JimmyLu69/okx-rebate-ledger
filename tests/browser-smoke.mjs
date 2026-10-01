// Optional isolated browser verification. Does not inspect existing browser profiles.
// Run: node tests/browser-smoke.mjs
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
async function currentHistory(page){return page.evaluate(async key=>(await import('./storage.mjs')).readHistory(key),walletKey)}
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
 await check('saved report renders attacker markup as plain text',async()=>{
  await page.locator('#recheckResults').click();await page.locator('#recheckReport[open]').waitFor();
  assert((await page.locator('#recheckRows').innerText()).includes('<img src=x'));
  assert.equal(await page.locator('#recheckRows img').count(),0);assert.equal(await page.evaluate(()=>window.__injected),false);await closeDialogs(page);
 });
 await check('malicious report import rejects numeric HTML and leaves ledger unchanged',async()=>{
  const before=await page.locator('#rowCount').innerText(),bad=envelope(seed());bad.state.lastRecheck.entries[0].before='<img src=x onerror="window.__injected=true">';
  await page.locator('#backupCenterButton').click();await chooseFile(page,'#importFile','malicious-report.json',bad);
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('格式不正确'),null,{timeout:15000});
  assert.equal(await page.locator('#importPreview').evaluate(e=>e.open),false);assert.equal(await page.evaluate(()=>window.__injected),false);assert.equal(await page.locator('#rowCount').innerText(),before);await closeDialogs(page);
 });
 await check('cancel settings discards network and threshold edits',async()=>{
  await page.locator('#setupButton').click();const checkbox=page.locator('#chainChoices input[data-chain="8453"]');assert(await checkbox.isChecked());await checkbox.uncheck();await page.locator('#toleranceValue').fill('7');await page.getByRole('button',{name:'关闭设置',exact:true}).click();
  await page.locator('#setupButton').click();assert(await checkbox.isChecked());assert.equal(await page.locator('#toleranceValue').inputValue(),'0.1');await closeDialogs(page);
 });
 await check('invalid credentials and storage failure cannot partially apply settings',async()=>{
  const baseline=await localSetting(page,'rebate-preferences-v1');await page.locator('#setupButton').click();await page.locator('#toleranceValue').fill('0.25');
  await page.locator('details').filter({has:page.locator('#xlayerKey')}).locator('summary').click();await page.locator('#xlayerKey').fill('incomplete-synthetic');await page.locator('#saveSettings').click();
  await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('X Layer'));
  assert.deepEqual(await localSetting(page,'rebate-preferences-v1'),baseline);await page.locator('#xlayerKey').fill('');
  await page.evaluate(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(this===localStorage&&key==='rebate-preferences-v1'){Storage.prototype.setItem=original;throw new DOMException('Synthetic quota failure','QuotaExceededError')}return original.call(this,key,value)}});
  await page.locator('#saveSettings').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('未应用'));
  assert.deepEqual(await localSetting(page,'rebate-preferences-v1'),baseline);await closeDialogs(page);await page.locator('#setupButton').click();assert.equal(await page.locator('#toleranceValue').inputValue(),'0.1');await closeDialogs(page);
 });
 await check('IndexedDB failure rolls back settings and leaves the active wallet unchanged',async()=>{
  const baseline=await localSetting(page,'rebate-preferences-v1'),walletBefore=await localSetting(page,'rebate-wallets-v1');
  await page.locator('#setupButton').click();await page.locator('#toleranceValue').fill('0.75');await page.locator('#evmWallet').fill('0x'+'8'.repeat(40));
  await page.evaluate(()=>{window.__idbFailed=false;const original=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(names,mode,...rest){if(mode==='readwrite'&&this.name==='rebate-ledger'){IDBDatabase.prototype.transaction=original;window.__idbFailed=true;throw new DOMException('Synthetic IDB quota failure','QuotaExceededError')}return original.call(this,names,mode,...rest)}});
  await page.locator('#saveSettings').click();await page.waitForFunction(()=>window.__idbFailed&&document.querySelector('#toast').textContent.includes('未应用'));
  assert.deepEqual(await localSetting(page,'rebate-preferences-v1'),baseline);assert.deepEqual(await localSetting(page,'rebate-wallets-v1'),walletBefore);await closeDialogs(page);await page.locator('#setupButton').click();assert.equal(await page.locator('#evmWallet').inputValue(),own);assert.equal(await page.locator('#toleranceValue').inputValue(),'0.1');await closeDialogs(page);
 });
 await check('encrypted settings export/import round trip and session credentials',async()=>{
  await page.locator('#setupButton').click();await page.locator('#credentialMode').selectOption('session');await page.locator('#blockscoutKey').fill('synthetic-session-secret');await page.locator('#toleranceValue').fill('0.25');await page.locator('#saveSettings').click();await page.locator('#settings').waitFor({state:'hidden'});
  assert.equal(await localSetting(page,'rebate-credentials-v1'),null);assert.equal(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('rebate-credentials-v1')).blockscout),'synthetic-session-secret');
  await page.locator('#backupCenterButton').click();await page.locator('#includeCredentials').check();await page.locator('#backupPassword').fill('browser-smoke-password');
  const downloaded=page.waitForEvent('download');await page.locator('#exportSettings').click();const bytes=await readDownload(await downloaded),encrypted=JSON.parse(bytes.toString());
  assert.equal(encrypted.format,'rebate-encrypted');assert(!bytes.toString().includes('synthetic-session-secret'));
  const decoded=await decryptBackup(encrypted,'browser-smoke-password');assert.equal(decoded.preferences.threshold,'0.25');assert.equal(decoded.credentialMode,'session');assert.equal(decoded.credentials.blockscout,'synthetic-session-secret');
  await page.locator('#backupPassword').fill('wrong-password');await chooseFile(page,'#importSettings','settings.rebate',encrypted);await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('口令'));
  await page.locator('#backupPassword').fill('browser-smoke-password');await chooseFile(page,'#importSettings','settings.rebate',encrypted);await page.locator('#settings[open]').waitFor({timeout:15000});assert.equal(await page.locator('#toleranceValue').inputValue(),'0.25');assert.equal(await page.locator('#blockscoutKey').inputValue(),'synthetic-session-secret');await closeDialogs(page);
 });
 await check('external import cannot overwrite a known local transaction amount',async()=>{
  const incoming=envelope(seed());incoming.state.records[0].raw='999999999';incoming.state.decisions={[row.id]:{kind:'commission',trader:'0x'+'9'.repeat(40),reason:'Imported decision must not overwrite a known local row',updatedAt:'2026-10-01T00:03:00.000Z'}};incoming.state.lastRecheck.entries[0].error='Imported literal text';
  await page.locator('#backupCenterButton').click();await page.locator('#backupPassword').fill('');await chooseFile(page,'#importFile','altered-history.json',incoming);await page.locator('#importPreview[open]').waitFor({timeout:15000});await page.locator('#confirmImport').click();await page.locator('#importPreview').waitFor({state:'hidden'});
  const stored=await currentHistory(page);assert.equal(stored.records.find(r=>r.id===row.id).raw,row.raw);assert.equal(stored.records.find(r=>r.id===row.id).importedUnverified,undefined);assert.equal(stored.decisions[row.id],undefined,'Incoming decision must not overwrite a known local transaction');await closeDialogs(page);
 });
 await check('new imported manual decisions cannot bypass transaction amount verification',async()=>{
  const hash='0x'+'b'.repeat(64),id=`8453:${hash}:fee:999`,incoming=envelope(seed());
  incoming.state.records=[{...row,id,hash,raw:'999999999999999999999999'}];incoming.state.decisions={[id]:{kind:'commission',trader,reason:'Untrusted imported judgment',updatedAt:'2026-10-01T00:03:00.000Z'}};
  await page.locator('#backupCenterButton').click();await chooseFile(page,'#importFile','unverified-judgment.json',incoming);await page.locator('#importPreview[open]').waitFor();await page.locator('#confirmImport').click();await page.locator('#importPreview').waitFor({state:'hidden'});
  const kind=await page.evaluate(async({key,id})=>{const saved=await(await import('./storage.mjs')).readHistory(key);return(await import('./ledger.mjs')).autoAccount(saved.records,saved.decisions).find(r=>r.id===id).kind},{key:walletKey,id});
  assert.equal(kind,'pending','Restored human labels cannot establish that an imported transfer or amount exists');assert.equal(await page.locator('#rowCount').innerText(),'1 个地址');await closeDialogs(page);
 });
 await check('manual decisions and undo remain atomic when IndexedDB refuses a write',async()=>{
  const failWrite=()=>page.evaluate(()=>{document.querySelector('#toast').textContent='';window.__decisionWriteFailed=false;const original=IDBDatabase.prototype.transaction;IDBDatabase.prototype.transaction=function(names,mode,...rest){if(mode==='readwrite'&&this.name==='rebate-ledger'){IDBDatabase.prototype.transaction=original;window.__decisionWriteFailed=true;throw new DOMException('Synthetic decision quota failure','QuotaExceededError')}return original.call(this,names,mode,...rest)}});
  const failed=()=>page.waitForFunction(()=>window.__decisionWriteFailed&&document.querySelector('#toast').textContent.length>0);
  await page.locator('#ledgerTab').click();await page.locator('#tableArea [data-group]').first().click();await page.locator('#detailBody .decisionform summary').first().click();
  await page.locator('#detailBody select[name="kind"]').selectOption('ignore');await page.locator('#detailBody input[name="reason"]').fill('Synthetic other-use decision');await failWrite();await page.locator('#detailBody button[type="submit"]').click();await failed();
  await closeDialogs(page);await page.locator('#ledgerTab').click();assert.equal(await page.locator('#rowCount').innerText(),'1 个地址');assert.equal((await currentHistory(page)).decisions[row.id],undefined);
  await page.locator('#tableArea [data-group]').first().click();await page.locator('#detailBody .decisionform summary').first().click();await page.locator('#detailBody select[name="kind"]').selectOption('ignore');await page.locator('#detailBody input[name="reason"]').fill('Synthetic other-use decision');await page.locator('#detailBody button[type="submit"]').click();await page.waitForFunction(()=>document.querySelector('#detailBody strong').textContent.includes('其他'));
  await page.locator('#detailBody .decisionform summary').first().click();await failWrite();await page.locator('#detailBody [data-undo]').click();await failed();await closeDialogs(page);await page.locator('#ledgerTab').click();assert.equal(await page.locator('#rowCount').innerText(),'0 个地址');assert.equal((await currentHistory(page)).decisions[row.id].kind,'ignore');
  await page.locator('#reviewTab').click();await page.locator('#reviewView').selectOption('ignored');await page.locator('#tableArea [data-record]').first().click();await page.locator('#detailBody .decisionform summary').first().click();await page.locator('#detailBody [data-undo]').click();await page.waitForFunction(()=>document.querySelector('#detailBody strong').textContent.includes('返佣收入'));await closeDialogs(page);await page.locator('#ledgerTab').click();assert.equal(await page.locator('#rowCount').innerText(),'1 个地址');
 });
 await check('file imports and tabs are keyboard reachable',async()=>{
  await page.locator('#backupCenterButton').click();const input=page.locator('#importFile');let reached=false;
  for(let i=0;i<30;i++){await page.keyboard.press('Tab');reached=await input.evaluate(el=>document.activeElement===el||document.activeElement===el.closest('label'));if(reached)break}
  assert(reached,'Import history must be reachable with Tab, not display:none without keyboard label');await closeDialogs(page);
  await page.locator('#ledgerTab').focus();await page.keyboard.press('ArrowRight');assert.equal(await page.locator('#reviewTab').getAttribute('aria-selected'),'true');await page.keyboard.press('ArrowLeft');assert.equal(await page.locator('#ledgerTab').getAttribute('aria-selected'),'true');
 });
 await check('desktop amount headers align with the right edge of their numbers',async()=>{
  await page.setViewportSize({width:1280,height:900});await page.locator('#ledgerTab').click();
  const edges=await page.evaluate(()=>{
   const headers=document.querySelectorAll('#tableArea thead th'),row=[...document.querySelectorAll('#tableArea tbody tr')].find(row=>row.querySelector('.quantity'));
   const textRight=element=>{const range=document.createRange();range.selectNodeContents(element);return range.getBoundingClientRect().right};
   return [1,2,3].map(index=>({label:headers[index].textContent,header:textRight(headers[index]),amount:textRight(row.children[index].querySelector('.quantity'))}));
  });
  for(const edge of edges)assert(Math.abs(edge.header-edge.amount)<=1,`${edge.label}: header right ${edge.header} differs from number right ${edge.amount}`);
 });
 await check('390px layouts have no horizontal overflow in main and settings',async()=>{
  await page.setViewportSize({width:390,height:844});await page.locator('#ledgerTab').click();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Main document overflows 390px');
  await page.locator('#setupButton').click();assert(await page.locator('#settings').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Settings content overflows 390px');await closeDialogs(page);
  await page.locator('#backupCenterButton').click();assert(await page.locator('#backupCenter').evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Backup content overflows 390px');await closeDialogs(page);
 });
 assert.deepEqual(pageErrors,[],'Unexpected browser JS errors');
 if(process.env.SMOKE_SCREENSHOT_DIR){
  const directory=resolve(process.env.SMOKE_SCREENSHOT_DIR);await mkdir(directory,{recursive:true});await closeDialogs(page);await page.locator('#ledgerTab').click();
  await page.locator('#toast').evaluate(el=>el.style.display='none');
  for(const [size,viewport]of Object.entries({desktop:{width:1280,height:900},mobile:{width:390,height:844}})){
   await page.setViewportSize(viewport);
   for(const theme of ['light','dark']){
    await page.locator('#themeSelect').selectOption(theme);await page.waitForFunction(theme=>document.documentElement.dataset.theme===theme,theme);await page.evaluate(async()=>{await document.fonts.ready;window.scrollTo(0,0);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))});
    const path=resolve(directory,`${size}-${theme}.png`);await page.screenshot({path,fullPage:true});console.log(`SCREENSHOT ${path}`);
   }
  }
 }
 await check('all 125 confirmed group records are reachable through detail pagination',async()=>{
  const many=seed();many.records=Array.from({length:125},(_,index)=>{const hash='0x'+(index+1).toString(16).padStart(64,'0');return{...row,hash,id:`8453:${hash}:fee:1`}});many.coverage['8453'].inspected=many.records.map(row=>row.hash);many.lastRecheck=null;
  await page.evaluate(async({key,state})=>{const storage=await import('./storage.mjs');await storage.readHistory(key);await storage.writeHistory(key,state)},{key:walletKey,state:many});
  await page.reload({waitUntil:'networkidle'});await page.locator('#rowCount').filter({hasText:'1 个地址'}).waitFor({timeout:15000});await page.locator('#tableArea [data-group]').first().click();
  const ids=()=>page.locator('#detailBody [data-decision]').evaluateAll(forms=>forms.map(form=>form.dataset.decision));
  assert.equal(await page.locator('#detailBody > article.record').count(),50);assert.equal(await page.locator('#detailPageNum').innerText(),'1 / 3 · 125 条');assert(await page.locator('#detailPrev').isDisabled());const first=await ids();
  await page.locator('#detailNext').click();assert.equal(await page.locator('#detailBody > article.record').count(),50);assert.equal(await page.locator('#detailPageNum').innerText(),'2 / 3 · 125 条');const second=await ids();
  await page.locator('#detailNext').click();assert.equal(await page.locator('#detailBody > article.record').count(),25);assert.equal(await page.locator('#detailPageNum').innerText(),'3 / 3 · 125 条');assert(await page.locator('#detailNext').isDisabled());const third=await ids();
  assert.deepEqual(new Set([...first,...second,...third]),new Set(many.records.map(row=>row.id)),'Every confirmed record must appear on exactly one page');
  await page.locator('#detailPrev').click();assert.equal(await page.locator('#detailPageNum').innerText(),'2 / 3 · 125 条');assert.deepEqual(await ids(),second);await closeDialogs(page);
 });
 assert.deepEqual(pageErrors,[],'Unexpected browser JS errors');
 console.log(JSON.stringify({passed:passed.length,failed:failures.length,failures},null,2));
 await context.close();if(failures.length)process.exitCode=1;
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve))}
