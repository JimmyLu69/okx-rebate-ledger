let database;
async function db(){return database ||= new Promise((resolve,reject)=>{const r=indexedDB.open('rebate-ledger',1);r.onupgradeneeded=()=>r.result.createObjectStore('wallets');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
export async function readHistory(key){const d=await db();return new Promise((resolve,reject)=>{const r=d.transaction('wallets').objectStore('wallets').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}
export async function writeHistory(key,value){const d=await db();return new Promise((resolve,reject)=>{const t=d.transaction('wallets','readwrite');t.objectStore('wallets').put(value,key);t.oncomplete=resolve;t.onerror=()=>reject(t.error);t.onabort=()=>reject(t.error||Error('保存中断'))})}
