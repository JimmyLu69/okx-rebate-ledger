import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
export const files=['index.html','style.css','app.mjs','catalog.mjs','view-model.mjs','persistence.mjs','sync-controller.mjs','backup-worker.mjs','validation.mjs','backup-crypto.mjs','csv.mjs','network.mjs','evidence-cache.mjs','recheck.mjs','recheck-worker.mjs','api.mjs','ledger.mjs','solana-classification.mjs','stablecoins.mjs','allowlist.mjs','asset-allowlist.json','valuation.mjs','prices.mjs','extended-api.mjs','xlayer-api.mjs','chains.json','routers.json','history.mjs','storage.mjs','theme.js','serif.woff2','mono.woff2','font-licenses.txt','install.mjs','sw.js','manifest.webmanifest','icon-192.png','icon-512.png'];
export async function buildAssets(){
  const source=new Map(await Promise.all(files.map(async file=>[file,await readFile(new URL('../dist/'+file,import.meta.url))])));
  const hash=createHash('sha256');for(const[file,bytes]of source)hash.update(file).update(bytes);
  const version=hash.digest('hex').slice(0,16),prefix='/assets/'+version+'/';
  const output=new Map();
  for(const[file,bytes]of source){output.set('/'+file,bytes);if(!['index.html','sw.js','manifest.webmanifest'].includes(file))output.set(prefix+file,bytes)}
  let html=source.get('index.html').toString();
  for(const name of ['style.css','theme.js','app.mjs'])html=html.replaceAll('"'+name+'"','"'+prefix+name+'"');
  output.set('/index.html',Buffer.from(html));
  const shell=['/','/index.html','/manifest.webmanifest','/icon-192.png','/icon-512.png',...files.filter(f=>!['index.html','sw.js','manifest.webmanifest'].includes(f)).map(f=>prefix+f)];
  output.set('/sw.js',Buffer.from(source.get('sw.js').toString().replace('__CACHE_VERSION__',version).replace('__SHELL_FILES__',JSON.stringify(shell))));
  let commit=process.env.COMMIT_REF||'';if(!commit)try{commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()}catch{}
  output.set('/build-info.json',Buffer.from(JSON.stringify({version,commit,builtAt:new Date().toISOString()})));
  return {output,version};
}
