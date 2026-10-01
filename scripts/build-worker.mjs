import { mkdir, writeFile } from "node:fs/promises";
import { buildAssets } from "./assets.mjs";
const { output } = await buildAssets();
const assets = Object.fromEntries(
  [...output].map(([path, bytes]) => [path, bytes.toString("base64")]),
);
await mkdir(new URL("../dist/server/", import.meta.url), { recursive: true });
await writeFile(
  new URL("../dist/server/index.js", import.meta.url),
  `
import {handleLinea} from '../../server/linea-proxy.mjs';
import {handleBlockscout} from '../../server/blockscout-proxy.mjs';
import {handleXLayer} from '../../server/xlayer-proxy.mjs';
import {handlePrices} from '../../server/prices-proxy.mjs';
const assets=${JSON.stringify(assets)};
export default {async fetch(request){
  const url=new URL(request.url),handlers={'/api/linea':handleLinea,'/api/blockscout':handleBlockscout,'/api/xlayer':handleXLayer,'/api/prices':handlePrices};
  if(handlers[url.pathname])return handlers[url.pathname](request);
  if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
  const path=url.pathname==='/'?'/index.html':url.pathname;
  if(!Object.hasOwn(assets,path))return new Response('Not found',{status:404});
  const type=path.endsWith('.ttf')?'font/ttf':path.endsWith('.woff2')?'font/woff2':path.endsWith('.png')?'image/png':path.endsWith('.html')?'text/html':path.endsWith('.css')?'text/css':path.endsWith('.json')||path.endsWith('.webmanifest')?'application/json':path.endsWith('.txt')?'text/plain':'text/javascript';
  return new Response(request.method==='HEAD'?null:Uint8Array.from(atob(assets[path]),c=>c.charCodeAt(0)),{headers:{'Content-Type':type,'Cache-Control':path.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
}};
`,
);
