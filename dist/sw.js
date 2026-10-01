const CACHE='rebate-shell-__CACHE_VERSION__';
const FILES=__SHELL_FILES__;
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES))));
// Activate only when old clients close or explicitly request the ready version.
self.addEventListener('message',event=>{if(event.data?.type==='ACTIVATE_UPDATE')self.skipWaiting()});
async function pruneOldReleases(){
 // Another tab may still run an older module graph. Its lazy workers need that
 // graph until it refreshes; prune when one remaining window navigates anew.
 if((await self.clients.matchAll({type:'window',includeUncontrolled:true})).length>1)return;
 await Promise.all((await caches.keys()).filter(key=>key.startsWith('rebate-shell-')&&key!==CACHE).map(key=>caches.delete(key)));
}
self.addEventListener('activate',event=>event.waitUntil(pruneOldReleases().then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url),assetRelease=url.pathname.match(/^\/assets\/([a-f0-9]{16})\//)?.[1];
 if(event.request.method!=='GET'||url.origin!==self.location.origin||url.search||(!assetRelease&&!FILES.includes(url.pathname)))return;
 event.respondWith((async()=>{
  const wanted=assetRelease?'rebate-shell-'+assetRelease:CACHE;
  // Do not create arbitrary caches from a caller-supplied version path.
  const existing=await caches.keys(),cache=existing.includes(wanted)?await caches.open(wanted):null;
  // HTML, catalogs, modules and fonts were installed together. Never replace a
  // release's shell with a newer network index, including after a failed update.
  const cached=cache&&await cache.match(event.request);
  if(!assetRelease&&event.request.mode==='navigate')event.waitUntil(pruneOldReleases());
  if(cached)return cached;
  return fetch(event.request);
 })());
});
