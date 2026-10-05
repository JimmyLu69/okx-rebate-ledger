const CACHE='rebate-shell-__CACHE_VERSION__';
const FILES=__SHELL_FILES__;
const DIGESTS=__ASSET_DIGESTS__;
const MANIFEST='/__asset-manifest';
async function digest(response){
 const bytes=await response.clone().arrayBuffer();
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function installShell(){
 const cache=await caches.open(CACHE),old=new Map();
 for(const name of (await caches.keys()).filter(n=>n.startsWith('rebate-shell-')&&n!==CACHE)){
  const source=await caches.open(name),manifest=await source.match(MANIFEST);
  if(!manifest)continue;
  try{for(const [path,hash]of Object.entries(await manifest.json()))if(typeof hash==='string'&&!old.has(hash))old.set(hash,{source,path})}catch{}
 }
 const loading=new Map();
 const load=path=>{
  const hash=DIGESTS[path];
  if(!loading.has(hash))loading.set(hash,(async()=>{
   const known=old.get(hash),reused=known&&await known.source.match(known.path);
   if(reused&&await digest(reused)===hash)return reused;
   const response=await fetch(path,{cache:'no-cache'});
   if(!response.ok||await digest(response)!==hash)throw Error('Incomplete release asset: '+path);
   return response;
  })());
  return loading.get(hash);
 };
 let cursor=0;
 try{
  const lanes=Array.from({length:6},async()=>{for(;;){const i=cursor++;if(i>=FILES.length)return;const path=FILES[i],response=await load(path);
   // Reset Response.url when copying a previous release. Otherwise relative
   // module/font imports resolve against the old release and break after pruning.
   const headers=new Headers(response.headers);headers.delete("content-encoding");headers.delete("content-length");
   await cache.put(path,new Response(response.clone().body,{status:response.status,statusText:response.statusText,headers}))}});
  const results=await Promise.allSettled(lanes),failure=results.find(r=>r.status==='rejected');
  if(failure)throw failure.reason;
  await cache.put(MANIFEST,new Response(JSON.stringify(DIGESTS),{headers:{'Content-Type':'application/json'}}));
 }catch(error){await caches.delete(CACHE);throw error}
}
self.addEventListener('install',event=>event.waitUntil(installShell()));
// Keep the release graph atomic: changed resources must all arrive before activation.
self.addEventListener('message',event=>{if(event.data?.type==='ACTIVATE_UPDATE')self.skipWaiting()});
async function pruneOldReleases(){
 if((await self.clients.matchAll({type:'window',includeUncontrolled:true})).length>1)return;
 await Promise.all((await caches.keys()).filter(key=>key.startsWith('rebate-shell-')&&key!==CACHE).map(key=>caches.delete(key)));
}
self.addEventListener('activate',event=>event.waitUntil(pruneOldReleases().then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url),assetRelease=url.pathname.match(/^\/assets\/([a-f0-9]{16})\//)?.[1];
 if(event.request.method!=='GET'||url.origin!==self.location.origin||url.search||(!assetRelease&&!FILES.includes(url.pathname)))return;
 event.respondWith((async()=>{
  const wanted=assetRelease?'rebate-shell-'+assetRelease:CACHE;
  const existing=await caches.keys(),cache=existing.includes(wanted)?await caches.open(wanted):null;
  const cached=cache&&await cache.match(event.request);
  if(!assetRelease&&event.request.mode==='navigate')event.waitUntil(pruneOldReleases());
  if(cached)return cached;
  return fetch(event.request);
 })());
});
