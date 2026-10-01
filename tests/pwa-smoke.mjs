// Optional isolated integration test for the actual versioned asset builder.
// No existing browser profile, real wallet, API credentials, or remote API is used.
// Run: node tests/pwa-smoke.mjs
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {resolve,dirname,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {buildAssets} from '../scripts/assets.mjs';
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
let playwright;const require=createRequire(import.meta.url);
for(const name of [process.env.PLAYWRIGHT_MODULE,'playwright',resolve(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs')].filter(Boolean))try{playwright=name==='playwright'?require(name):await import(name.startsWith('file:')?name:pathToFileURL(resolve(name)).href);break}catch{}
if(!playwright)throw Error('Install Playwright or set PLAYWRIGHT_MODULE to its index.mjs');
const first=await buildAssets(),nextVersion=first.version==='bbbbbbbbbbbbbbbb'?'cccccccccccccccc':'bbbbbbbbbbbbbbbb';
function nextSnapshot(){
 const output=new Map();
 for(const[path,bytes]of first.output){
  const key=path.replaceAll(first.version,nextVersion);
  output.set(key,['/index.html','/sw.js','/build-info.json'].includes(path)?Buffer.from(bytes.toString().replaceAll(first.version,nextVersion)):bytes);
 }
 return {output,version:nextVersion};
}
const next=nextSnapshot();let current=first,failPath=null,apiCalls=0;
const toml=await readFile(resolve(project,'netlify.toml'),'utf8'),csp=toml.match(/Content-Security-Policy\s*=\s*"([^"]+)"/)?.[1];
const server=createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost'),pathname=url.pathname;
 if(pathname.startsWith('/api/')){apiCalls++;res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end('{"synthetic":true}');return}
 if(pathname===failPath){res.writeHead(503,{'Cache-Control':'no-store'}).end('Synthetic missing deploy asset');return}
 const bytes=current.output.get(pathname==='/'?'/index.html':pathname);if(!bytes){res.writeHead(404,{'Cache-Control':'no-store'}).end('Missing');return}
 const type={'.html':'text/html','.mjs':'text/javascript','.js':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.woff2':'font/woff2','.ttf':'font/ttf','.png':'image/png'}[extname(pathname)]||(pathname==='/'?'text/html':'text/plain');
 res.writeHead(200,{'Content-Type':type,'Cache-Control':pathname.startsWith('/assets/')?'public,max-age=31536000,immutable':'no-cache','Service-Worker-Allowed':'/',...(csp?{'Content-Security-Policy':csp}:{})});res.end(bytes);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;let browser;
try{
 // Run all ordinary UI/security scenarios against versioned URLs as Netlify serves them.
 const result=await promisify(execFile)(process.execPath,[resolve(project,'tests/browser-smoke.mjs')],{env:{...process.env,BROWSER_SMOKE_URL:base},timeout:180000,maxBuffer:2*1024*1024});console.log(result.stdout.trim());
 const bundled=playwright.chromium.executablePath(),executablePath=process.env.CHROMIUM_EXECUTABLE||await stat(bundled).then(()=>bundled,()=>process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined);
 browser=await playwright.chromium.launch({headless:true,...(executablePath?{executablePath}:{}),args:['--disable-extensions','--disable-background-networking']});
 const context=await browser.newContext({serviceWorkers:'allow',viewport:{width:390,height:844}});
 await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort('blockedbyclient'));
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 const appVersion=()=>page.locator('script[type="module"]').getAttribute('src');
 await page.goto(base,{waitUntil:'networkidle'});await page.waitForFunction(()=>navigator.serviceWorker.controller&&document.querySelector('#rowCount')?.textContent.includes('个地址'),null,{timeout:20000});
 assert((await appVersion()).includes(first.version));
 await page.evaluate(()=>document.fonts.ready);assert(await page.evaluate(()=>[...document.fonts].filter(f=>f.family.startsWith('Ledger')).every(f=>f.status==='loaded')));
 console.log('PASS versioned assets install at root scope and load WOFF2 fonts');
 await context.setOffline(true);await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.querySelector('#rowCount')?.textContent.includes('个地址'));assert((await appVersion()).includes(first.version));assert(await page.locator('#offlineNote').isVisible());
 console.log('PASS offline reload keeps a complete version including catalog JSON');
 await context.setOffline(false);
 await page.evaluate(async()=>{await fetch('/api/pwa-test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'synthetic-only'})});await fetch('/api/pwa-test')});
 assert.equal(apiCalls,2);
 const cachedURLs=await page.evaluate(async()=>{const result=[];for(const name of await caches.keys())for(const request of await(await caches.open(name)).keys())result.push(request.url);return result});assert(cachedURLs.every(url=>!new URL(url).pathname.startsWith('/api/')&&!new URL(url).search));
 console.log('PASS service worker does not store API requests or responses');
 const update=()=>page.evaluate(async()=>{const reg=await navigator.serviceWorker.getRegistration('/');const changed=new Promise(resolve=>reg.addEventListener('updatefound',()=>{const worker=reg.installing;const check=()=>{if(['installed','redundant'].includes(worker.state))resolve(worker.state)};worker.addEventListener('statechange',check);check()},{once:true}));await reg.update();return await changed});
 current=next;failPath=`/assets/${next.version}/ledger.mjs`;
 assert.equal(await update(),'redundant');assert.equal(await page.evaluate(async()=>!!(await navigator.serviceWorker.getRegistration('/')).waiting),false);
 await page.reload({waitUntil:'networkidle'});assert((await appVersion()).includes(first.version),'Failed release must not replace cached HTML with new HTML');
 await context.setOffline(true);await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.querySelector('#rowCount')?.textContent.includes('个地址'));assert((await appVersion()).includes(first.version));
 console.log('PASS incomplete deployment fails atomically and old release still works offline');
 await context.setOffline(false);failPath=null;
 const other=await context.newPage();await other.goto(base,{waitUntil:'networkidle'});await other.waitForFunction(()=>navigator.serviceWorker.controller&&document.querySelector('#rowCount')?.textContent.includes('个地址'));
 // Opening a second tab may already discover and install the new worker.
 const alreadyWaiting=await page.evaluate(async()=>!!(await navigator.serviceWorker.getRegistration('/')).waiting);
 if(!alreadyWaiting)assert.equal(await update(),'installed');await page.locator('#updateApp').waitFor({state:'visible',timeout:15000});assert((await appVersion()).includes(first.version),'Waiting worker must not silently mix releases');
 await page.locator('#updateApp').click();await page.waitForFunction(version=>document.querySelector('script[type="module"]')?.src.includes(version),next.version,{timeout:20000});await page.waitForFunction(()=>document.querySelector('#rowCount')?.textContent.includes('个地址'));
 const retained=await page.evaluate(()=>caches.keys());assert(retained.includes('rebate-shell-'+first.version)&&retained.includes('rebate-shell-'+next.version));
 await context.setOffline(true);
 assert((await other.locator('script[type="module"]').getAttribute('src')).includes(first.version));
 const oldWorker=await other.evaluate(async version=>{const worker=new Worker('/assets/'+version+'/backup-worker.mjs',{type:'module'});try{return await new Promise((resolve,reject)=>{worker.onmessage=event=>resolve(event.data.ok);worker.onerror=event=>reject(Error(event.message));worker.postMessage({type:'encode',value:{synthetic:true},password:'',compress:false})})}finally{worker.terminate()}},first.version);
 assert.equal(oldWorker,true,'Other tab must be able to load its old worker graph after an update');
 await other.close();await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.querySelector('#rowCount')?.textContent.includes('个地址'));assert((await appVersion()).includes(next.version));
 await page.waitForFunction(async version=>(await caches.keys()).length===1&&(await caches.keys())[0]==='rebate-shell-'+version,next.version);
 assert.deepEqual(errors,[]);console.log('PASS explicit activation keeps old-tab workers usable, then prunes old release after tabs close');
 await context.close();console.log('PWA smoke: 5/5 passed; versioned UI smoke: 11/11 passed');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve))}
