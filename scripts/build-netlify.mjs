import {mkdir,copyFile,rm} from 'node:fs/promises';
await rm(new URL('../public/',import.meta.url),{recursive:true,force:true});
await mkdir(new URL('../public/',import.meta.url));
for(const f of ['index.html','style.css','app.mjs','recheck.mjs','recheck-worker.mjs','api.mjs','ledger.mjs','valuation.mjs','prices.mjs','extended-api.mjs','xlayer-api.mjs','chains.json','routers.json','history.mjs','storage.mjs','theme.js','serif.ttf','mono.ttf','font-licenses.txt','install.mjs','sw.js','manifest.webmanifest','icon-192.png','icon-512.png'])await copyFile(new URL('../dist/'+f,import.meta.url),new URL('../public/'+f,import.meta.url));
