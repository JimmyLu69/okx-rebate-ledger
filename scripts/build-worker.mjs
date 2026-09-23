import { readFile, writeFile, mkdir } from 'node:fs/promises';
const files = ['index.html', 'style.css', 'app.mjs', 'api.mjs', 'ledger.mjs', 'valuation.mjs', 'extended-api.mjs', 'xlayer-api.mjs', 'chains.json', 'routers.json'];
const assets = {};
for (const file of files) assets['/' + file] = await readFile(new URL('../dist/' + file, import.meta.url), 'utf8');
const core = await readFile(new URL('../server/prices-proxy.mjs', import.meta.url), 'utf8') + '\n' + await readFile(new URL('../server/xlayer-proxy.mjs', import.meta.url), 'utf8') + '\n' + await readFile(new URL('../server/blockscout-proxy.mjs', import.meta.url), 'utf8');
await mkdir(new URL('../dist/server/', import.meta.url), { recursive: true });
await writeFile(new URL('../dist/server/index.js', import.meta.url), core + '\nconst assets = ' + JSON.stringify(assets) + `;
export default { async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/api/prices') return handlePrices(request);
  if (url.pathname === '/api/blockscout') return handleBlockscout(request);
  if (url.pathname === '/api/xlayer') return handleXLayer(request);
  if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed', {status:405});
  const path = url.pathname === '/' ? '/index.html' : url.pathname;
  if (!Object.hasOwn(assets,path)) return new Response('Not found',{status:404});
  const type = path.endsWith('.html') ? 'text/html' : path.endsWith('.css') ? 'text/css' : path.endsWith('.json') ? 'application/json' : 'text/javascript';
  return new Response(request.method === 'HEAD' ? null : assets[path], {headers:{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
}};
`);
