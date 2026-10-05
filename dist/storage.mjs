// Rows are immutable snapshots. Comparing object identities avoids serializing the
// entire wallet on every checkpoint; the IDB transaction commits rows and cursors together.
let database, writeTail = Promise.resolve();
const snapshots = new Map(), revisions = new Map(), protections = new Map(), pending = new Map();
const frozen = new WeakSet();
const INSPECTED_PAGE_SIZE = 256;
const samePage = (a,b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item,index) => item === b[index]);
function immutable(value) {
  if (!value || typeof value !== 'object' || frozen.has(value)) return value;
  for (const item of Object.values(value)) immutable(item);
  Object.freeze(value); frozen.add(value); return value;
}
function protectedError(key) {
  const error = Error('此钱包历史尚未安全读取，已禁止覆盖。请先导出原始数据并恢复历史');
  error.code = 'HISTORY_PROTECTED'; error.cause = protections.get(key); return error;
}
export function protectHistory(key, error = Error('历史读取失败')) { protections.set(key, error); }
export function historyProtection(key) { return protections.has(key) ? protectedError(key) : null; }
async function db() {
  return (database ||= new Promise((resolve, reject) => {
    const request = indexedDB.open('rebate-ledger', 4);
    request.onupgradeneeded = () => {
      const d = request.result;
      if (!d.objectStoreNames.contains('wallets')) d.createObjectStore('wallets');
      if (!d.objectStoreNames.contains('recoveries')) d.createObjectStore('recoveries',{keyPath:'id'}).createIndex('wallet','wallet');
      for (const [name, keyPath] of [['records',['wallet','id']], ['parts',['wallet','kind','id']]]) {
        if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, {keyPath}).createIndex('wallet','wallet');
      }
    };
    request.onsuccess = () => {
      const d = request.result;
      d.onversionchange = () => { d.close(); database = null; };
      resolve(d);
    };
    request.onerror = () => { database = null; reject(request.error); };
    request.onblocked = () => { database = null; reject(Error('请关闭其他旧版账本页面后重试')); };
  }));
}
function partition(value, baseline) {
  const {records, coverage = {}, lastRecheck, decisions, ...rest} = value;
  const rowMap = new Map(records.map(row => [row.id, immutable(row)])), parts = new Map(), meta = {...rest, coverage:{}};
  const add = (kind, id, item) => parts.set(kind+'\0'+id, {kind,id,value:immutable(item)});
  for (const [chain, cov] of Object.entries(coverage)) {
    const {inspected = [], inspectionErrors, ...small} = cov;
    meta.coverage[chain] = small;
    // Keep the existing pages stable: appending a hash rewrites only the last
    // partial page. One row per hash amplifies IDB key/index storage enormously.
    for (let offset=0;offset<inspected.length;offset+=INSPECTED_PAGE_SIZE) {
      const id=chain+':'+offset/INSPECTED_PAGE_SIZE, previous=baseline?.parts.get('inspectedPage\0'+id)?.value;
      const length=Math.min(INSPECTED_PAGE_SIZE,inspected.length-offset);
      let unchanged=Array.isArray(previous)&&previous.length===length;
      for(let index=0;unchanged&&index<length;index++)unchanged=previous[index]===inspected[offset+index];
      add('inspectedPage',id,unchanged?previous:inspected.slice(offset,offset+length));
    }
    for (const [hash,error] of Object.entries(inspectionErrors || {})) add('inspectionError',chain+':'+hash,error);
  }
  if (lastRecheck) {
    const {entries = [], ...small} = lastRecheck; meta.lastRecheck = small;
    entries.forEach((entry,index) => add('report',String(index),entry));
  } else if (lastRecheck !== undefined) meta.lastRecheck = lastRecheck;
  if (decisions !== undefined) {
    meta.hasDecisions = true;
    for (const [id,decision] of Object.entries(decisions)) add('decision',id,decision);
  }
  return {rows:rowMap,parts,meta:structuredClone(meta)};
}
function assemble(meta, rows, parts) {
  const {storageVersion,storageRevision,hasDecisions,...result} = meta;
  result.records = rows.map(row => row.value);
  if (storageVersion < 3) return result;
  for (const cov of Object.values(result.coverage || {})) { cov.inspected = []; cov.inspectionErrors = {}; }
  if (result.lastRecheck) result.lastRecheck.entries = [];
  if (hasDecisions) result.decisions = {};
  const inspectedPages = new Map();
  for (const part of parts) {
    if (part.kind === 'decision') (result.decisions ||= {})[part.id] = part.value;
    else if (part.kind === 'report' && result.lastRecheck) result.lastRecheck.entries[Number(part.id)] = part.value;
    else {
      const separator = part.id.indexOf(':'), chain = part.id.slice(0,separator), hash = part.id.slice(separator+1), cov = result.coverage?.[chain];
      if (cov && part.kind === 'inspected') cov.inspected.push(hash);
      if (cov && part.kind === 'inspectedPage') {
        if(!inspectedPages.has(chain))inspectedPages.set(chain,[]);
        inspectedPages.get(chain).push({index:Number(hash),hashes:part.value});
      }
      if (cov && part.kind === 'inspectionError') cov.inspectionErrors[hash] = part.value;
    }
  }
  for(const [chain,pages]of inspectedPages){
    const cov=result.coverage[chain];
    pages.sort((a,b)=>a.index-b.index);
    for(const page of pages)cov.inspected.push(...page.hashes);
    // Mixed layouts may be present in a recovery archive. Avoid duplicate work.
    cov.inspected=[...new Set(cov.inspected)];
  }
  return result;
}
async function load(key) {
  const d = await db();
  return new Promise((resolve,reject) => {
    const tx=d.transaction(['wallets','records','parts']), request=tx.objectStore('wallets').get(key);
    let value=null, revision=0, legacy=false, storedRows=[],storedParts=[],meta;
    request.onsuccess=()=>{
      meta=request.result;if(!meta)return;
      revision=meta.storageRevision||0;
      if (![2,3].includes(meta.storageVersion)) { legacy=true;value=meta;return; }
      const rows=tx.objectStore('records').index('wallet').getAll(key);
      rows.onsuccess=()=>{storedRows=rows.result};
      if(meta.storageVersion===3){const parts=tx.objectStore('parts').index('wallet').getAll(key);parts.onsuccess=()=>{storedParts=parts.result};}
    };
    tx.oncomplete=()=>resolve({value:meta&&!legacy?assemble(meta,storedRows,storedParts):value,revision,legacy,segmented:meta?.storageVersion===3,storedParts});
    tx.onerror=tx.onabort=()=>reject(tx.error||Error('历史读取失败'));
  });
}
export async function readRawHistory(key) { return (await load(key)).value; }
export async function readHistory(key,{validate}={}) {
  try {
    const loaded=await load(key), value=loaded.value;
    // Validation must finish before this wallet becomes a writable baseline.
    const result=value&&validate?validate(value):value;
    revisions.set(key,loaded.revision);
    if(value){const baseline=partition(value);snapshots.set(key,{rows:loaded.legacy?new Map():baseline.rows,parts:loaded.segmented?new Map(loaded.storedParts.map(part=>[part.kind+'\0'+part.id,{kind:part.kind,id:part.id,value:immutable(part.value)}])):new Map()});}
    else snapshots.set(key,{rows:new Map(),parts:new Map()});
    return result;
  } catch(error) { protectHistory(key,error); throw error; }
}
export async function recoverHistory(key,{validate}={}) {
  if(typeof validate!=='function')throw Error('恢复历史必须提供完整校验');
  const result=await readHistory(key,{validate});protections.delete(key);return result;
}
export function releaseHistory(key) {
  if(pending.has(key))return false;
  snapshots.delete(key);revisions.delete(key);return true;
}
export function writeHistory(key,value,options) { return writeHistories([[key,value]],options); }
export function writeHistories(entries,{recover=false}={}) {
  if(!Array.isArray(entries)||new Set(entries.map(([key])=>key)).size!==entries.length)return Promise.reject(Error('重复或无效的钱包写入'));
  let prepared;
  try {prepared=entries.map(([key,value])=>{if(!recover&&protections.has(key))throw protectedError(key);return{key,snapshot:partition(value,snapshots.get(key))}});}catch(error){return Promise.reject(error)}
  for(const {key}of prepared)pending.set(key,(pending.get(key)||0)+1);
  const task=writeTail.catch(()=>{}).then(async()=>{
    for(const {key}of prepared){if(!recover&&protections.has(key))throw protectedError(key);if(!recover&&!snapshots.has(key))await readHistory(key);}
    const d=await db();
    const recoveryIds={}, committedRevisions=new Map();
    await new Promise((resolve,reject)=>{
      const tx=d.transaction(['wallets','records','parts','recoveries'],'readwrite'),wallets=tx.objectStore('wallets'),rows=tx.objectStore('records'),parts=tx.objectStore('parts');
      let failure;
      for(const {key,snapshot}of prepared){
        const prior=snapshots.get(key),expected=revisions.get(key)||0,check=wallets.get(key);
        check.onsuccess=()=>{try{
          if(!recover&&(check.result?.storageRevision||0)!==expected)throw Error('另一个页面已更新此钱包；请导出当前记录后刷新，避免覆盖较新的历史');
          const revision=(check.result?.storageRevision||0)+1;committedRevisions.set(key,revision);
          const commit=(baseline)=>{
            for(const [id,row]of snapshot.rows)if(baseline.rows.get(id)!==row)rows.put({wallet:key,id,value:row});
            for(const id of baseline.rows.keys())if(!snapshot.rows.has(id))rows.delete([key,id]);
            for(const [partKey,part]of snapshot.parts){
              const previous=baseline.parts.get(partKey)?.value;
              if(previous===part.value)continue;
              // Concurrently queued checkpoints may have been prepared before
              // their predecessor committed; compare only their bounded pages.
              if(part.kind==='inspectedPage'&&samePage(previous,part.value)){part.value=previous;continue;}
              parts.put({wallet:key,...part});
            }
            for(const [partKey,part]of baseline.parts)if(!snapshot.parts.has(partKey))parts.delete([key,part.kind,part.id]);
            wallets.put({...snapshot.meta,storageVersion:3,storageRevision:revision},key);
          };
          if(!recover){commit(prior);return;}
          const previousMeta=check.result, oldRows=rows.index('wallet').getAll(key), oldParts=parts.index('wallet').getAll(key);let completed=0;
          const archive=()=>{if(++completed!==2)return;try{
            if(previousMeta){const id=crypto.randomUUID();recoveryIds[key]=id;tx.objectStore('recoveries').put({id,wallet:key,createdAt:new Date().toISOString(),meta:previousMeta,records:oldRows.result,parts:oldParts.result});}
            for(const row of oldRows.result)rows.delete([key,row.id]);
            for(const part of oldParts.result)parts.delete([key,part.kind,part.id]);
            commit({rows:new Map(),parts:new Map()});
          }catch(error){failure=error;tx.abort()}};
          oldRows.onsuccess=oldParts.onsuccess=archive;
        }catch(error){failure=error;tx.abort()}};
      }
      tx.oncomplete=()=>{for(const{key,snapshot}of prepared){snapshots.set(key,snapshot);revisions.set(key,committedRevisions.get(key));if(recover)protections.delete(key)}resolve()};
      tx.onerror=tx.onabort=()=>reject(failure||tx.error||Error('保存中断'));
    });
    return {recoveryIds};
  });
  writeTail=task;
  task.finally(()=>{for(const{key}of prepared){const count=pending.get(key)-1;if(count)pending.set(key,count);else pending.delete(key)}}).catch(()=>{});
  return task;
}
export async function storageDiagnostics() {
  const estimate=await globalThis.navigator?.storage?.estimate?.();
  return {usage:estimate?.usage??null,quota:estimate?.quota??null,pendingWalletWrites:pending.size,retainedWallets:snapshots.size,protectedWallets:protections.size};
}

export async function listHistoryRecoveries(key) {
  const d=await db();return new Promise((resolve,reject)=>{const request=d.transaction('recoveries').objectStore('recoveries').index('wallet').getAll(key);request.onsuccess=()=>resolve(request.result.map(r=>({id:r.id,createdAt:r.createdAt,recordCount:r.meta?.records?.length??r.records.length})));request.onerror=()=>reject(request.error)});
}
export async function readRecoveryHistory(id) {
  const d=await db();return new Promise((resolve,reject)=>{const request=d.transaction('recoveries').objectStore('recoveries').get(id);request.onsuccess=()=>{const saved=request.result;resolve(!saved?null:[2,3].includes(saved.meta.storageVersion)?assemble(saved.meta,saved.records,saved.parts):saved.meta)};request.onerror=()=>reject(request.error)});
}
