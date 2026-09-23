import { EVM, FEE_TOPICS, canonical, decodeFeeLogs } from './ledger.mjs';
import { request } from './api.mjs';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const hex = n => '0x' + Number(n).toString(16);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const lower = s => String(s || '').toLowerCase();
const hashOK = s => /^0x[0-9a-f]{64}$/.test(lower(s));
const integer = v => { const n = Number(v); if (!Number.isSafeInteger(n) || n < 0) throw Error('数据源区块高度无效'); return n; };

export async function rpc(url, method, params, signal) {
  const r = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, signal);
  if (!Object.hasOwn(r, 'result') || r.result == null) throw Error('节点未返回完整交易数据，请稍后重试');
  return r.result;
}
export async function etherscan(key, chain, action, params, signal) {
  if (!key) throw Error('请填写 Etherscan API Key');
  const u = new URL('https://api.etherscan.io/v2/api');
  for (const [k, v] of Object.entries({ chainid: chain, module: 'account', action, ...params, apikey: key })) u.searchParams.set(k, String(v));
  await sleep(600);
  const d = await request(u, {}, signal);
  if (d.status === '1' && Array.isArray(d.result)) return d.result;
  if (d.status === '0' && /no transactions found/i.test(d.message || '') && Array.isArray(d.result) && !d.result.length) return [];
  throw Error('Etherscan 未完成查询：请检查免费额度、Key 权限或稍后继续；此响应不计为零记录');
}
export function discovery(chain, hashes) {
  return [...new Set(hashes.map(lower))].map(hash => {
    if (!hashOK(hash)) throw Error('历史响应缺少有效交易哈希');
    return { id: `${chain.id}:${hash}:discovery`, chain: chain.id, hash, asset: 'native', symbol: chain.symbol, decimals: chain.decimals, raw: '0', from: '', to: '', trader: '', kind: 'ignore', direction: 'in', stream: 'discovery', time: '', evidence: '历史交易索引；金额以成功回执及内部转账核验结果为准' };
  });
}

// Fix the upper bound for the entire scan; checkpoint only after records are saved.
export async function scanRanges({ chain, streams, windowSize, endBlock, start = {}, reverse = false, fetchPage, onPage, onProgress, signal }) {
  for (const stream of streams) {
    const saved = start[stream];
    if (saved?.complete) continue;
    const target = saved?.endBlock ?? endBlock;
    let next = saved?.next ?? (reverse ? Math.floor(target / windowSize) * windowSize : 0), page = saved?.page ?? 1, cursor = saved?.cursor ?? null;
    let fingerprints = new Set();
    while (next >= 0 && next <= target) {
      if (signal?.aborted) throw Error('已暂停');
      const to = Math.min(next + windowSize - 1, target);
      onProgress(`${chain.name} · ${stream} · 区块 ${next.toLocaleString()}–${to.toLocaleString()} / ${target.toLocaleString()}`);
      const result = await fetchPage(stream, next, to, page, cursor);
      if (!Array.isArray(result.hashes)) throw Error('历史响应不完整');
      const fingerprint = JSON.stringify([result.hashes, result.cursor]);
      if (result.more && fingerprints.has(fingerprint)) throw Error('分页内容重复，已暂停以免漏记；历史尚未完整');
      fingerprints.add(fingerprint);
      const rows = discovery(chain, result.hashes);
      if (result.more) { page++; cursor = result.cursor || null; }
      else { next = reverse ? next - windowSize : to + 1; page = 1; cursor = null; fingerprints = new Set(); }
      await onPage(rows, { stream, next, page, cursor, endBlock: target, complete: next < 0 || next > target });
    }
  }
}
export async function scanLinea(chain, key, onPage, onProgress, signal, start = {}) {
  const block = await rpc('https://rpc.linea.build', 'eth_getBlockByNumber', ['finalized', false], signal);
  const endBlock = Object.values(start).find(s => s.endBlock != null)?.endBlock ?? integer(block.number);
  await scanRanges({ chain, streams: ['txlist', 'txlistinternal', 'tokentx'], windowSize: 1000000, endBlock, start, onPage, onProgress, signal,
    fetchPage: async (stream, from, to, page) => {
      if (page > 10) throw Error('该区间超过一万笔记录，不能保证接口完整性；需要缩小扫描区间');
      const items = await etherscan(key, chain.id, stream, { address: EVM, startblock: from, endblock: to, sort: 'asc', page, offset: 1000 }, signal);
      return { hashes: items.map(x => x.hash), more: items.length === 1000 };
    }
  });
}
export async function scanBSC(chain, key, onPage, onProgress, signal, start = {}) {
  if (!/^[\w-]+$/.test(key || '')) throw Error('请填写有效的 NodeReal API Key');
  const url = `https://bsc-mainnet.nodereal.io/v1/${encodeURIComponent(key)}`;
  const block = await rpc(url, 'eth_getBlockByNumber', ['finalized', false], signal);
  await scanRanges({ chain, streams: ['转入', '转出'], windowSize: 100000, reverse: true, endBlock: Object.values(start).find(s => s.endBlock != null)?.endBlock ?? integer(block.number), start, onPage, onProgress, signal,
    fetchPage: async (stream, from, to, page, cursor) => {
      await sleep(2000);
      const query = { category: ['external', 'internal', '20'], fromBlock: hex(from), toBlock: hex(to), order: 'asc', maxCount: '0x3e8', [stream === '转入' ? 'toAddress' : 'fromAddress']: EVM };
      if (cursor) query.pageKey = cursor;
      const d = await rpc(url, 'nr_getAssetTransfers', [query], signal);
      if (!Array.isArray(d.transfers)) throw Error('NodeReal 转账历史响应不完整');
      const next = d.pageKey || d.PageKey || null;
      return { hashes: d.transfers.map(x => x.hash), more: !!next, cursor: next };
    }
  });
}
export function transferRow(chain, tx, suffix, from, to, raw, asset = 'native', meta = chain) {
  from = lower(from); to = lower(to); raw = BigInt(raw || '0').toString();
  if (from === to || from !== EVM && to !== EVM || raw === '0') return null;
  return { id: `${chain.id}:${tx.hash}:${suffix}`, chain: chain.id, asset, symbol: meta.symbol || asset, decimals: Number(meta.decimals), raw, hash: tx.hash,
    from, to, trader: from === EVM ? to : lower(tx.from?.hash || tx.from), direction: from === EVM ? 'out' : 'in', kind: 'pending', time: tx.timestamp || '',
    evidence: from === EVM ? '成功交易转出；请确认是否为手动返还' : '成功交易转入；需核对返佣与被邀请人归属' };
}
export function nativeFromCallTree(tree, chain, tx) {
  const rows = [];
  const walk = (call, path, failed) => {
    if (!call || typeof call !== 'object') throw Error('内部调用树响应不完整');
    const reverted = failed || !!call.error;
    if (!reverted && ['CALL', 'CREATE', 'CREATE2', 'SELFDESTRUCT'].includes(String(call.type).toUpperCase())) {
      const row = transferRow(chain, tx, `native:${path}`, call.from, call.to, call.value);
      if (row) rows.push(row);
    }
    for (const [i, child] of (call.calls || []).entries()) walk(child, `${path}.${i}`, reverted);
  };
  walk(tree, '0', false); return rows;
}
export function nativeFromEtherscan(items, chain, tx) {
  const rows=[], root=transferRow(chain,tx,'native:root',tx.from?.hash||tx.from,tx.to?.hash||tx.to,tx.value);
  if(root)rows.push(root);
  // txhash endpoint omits traceId. Aggregate its complete response by endpoints;
  // repeated equal transfers remain counted, with stable IDs across retries.
  const sums=new Map();
  for(const x of items){
    if(x.isError!=='0'||x.errCode||!['call','create','create2','suicide'].includes(lower(x.type)))continue;
    const row=transferRow(chain,tx,'',x.from,x.to||x.contractAddress,x.value);if(!row)continue;
    if(root&&row.from===root.from&&row.to===root.to&&row.raw===root.raw&&(String(x.traceId)==='0'||tx.from?.is_contract===false))continue;
    const k=row.from+':'+row.to;
    if(!sums.has(k))sums.set(k,{...row,id:`${chain.id}:${tx.hash}:native:internal:${k}`,raw:'0'});
    const r=sums.get(k);r.raw=(BigInt(r.raw)+BigInt(row.raw)).toString();
  }
  return [...rows,...sums.values()];
}
export function tokenTransfers(logs, chain, tx, metadata) {
  return logs.flatMap(log => {
    if (lower(log.topics?.[0]) !== TRANSFER || log.topics.length !== 3 || !/^0x[0-9a-fA-F]{64}$/.test(log.data || '') || log.removed) return [];
    const from = '0x' + log.topics[1].slice(-40), to = '0x' + log.topics[2].slice(-40), asset = lower(log.address);
    if (lower(from) !== EVM && lower(to) !== EVM) return [];
    const meta = metadata[asset];
    if (!meta || !Number.isInteger(Number(meta.decimals))) throw Error('代币缺少精度，不能计账');
    if (log.logIndex == null) throw Error('回执缺少日志索引，不能安全去重');
    const row = transferRow(chain, tx, `token:${integer(log.logIndex)}`, from, to, log.data, asset, meta);
    return row ? [row] : [];
  });
}
function decodeSymbol(result, asset) {
  try {
    const data = result.replace(/^0x/, '');
    const bytes = data.length === 64 ? data : data.slice(128, 128 + Number(BigInt('0x' + data.slice(64,128))) * 2);
    return new TextDecoder().decode(Uint8Array.from(bytes.match(/../g) || [], x => parseInt(x, 16))).replace(/\0/g, '').slice(0, 64) || asset;
  } catch { return asset; }
}
export function reconcileFeeTransfers(rows, fees) {
  const replace = rows.map(r => ({ ...r }));
  for (const asset of new Set(fees.map(f => f.asset))) {
    const rs = replace.filter(r => r.direction === 'in' && r.asset === asset), fs = fees.filter(f => f.asset === asset);
    if (rs.reduce((n, r) => n + BigInt(r.raw), 0n) === fs.reduce((n, f) => n + BigInt(f.raw), 0n)) {
      for(const f of fs)f.receiptMatched=true;
      for (const r of rs) { r.kind = 'ignore'; r.supersededBy = fs.map(f => f.id); r.evidence = '已由同笔返佣事件计入，转账不重复计账'; }
    } else {
      for (const f of fs) { f.kind = 'ignore'; f.evidence = '返佣事件与实际转入不一致；请核对实际转账记录'; }
    }
  }
  return [...replace, ...fees];
}

export function nodeRealNativeRows(items,chain,tx){
 const sums=new Map();
 for(const item of items){
  if(lower(item.hash)!==lower(tx.hash))throw Error('NodeReal 返回了其他交易，核验已停止');
  if(!['external','internal'].includes(item.category))continue;
  if(item.category==='internal'&&item.type&&!['call','create','create2','suicide','selfdestruct'].includes(lower(item.type)))continue;
  if(!['1','0x1'].includes(String(item.receiptsStatus)))continue;
  if(item.contractAddress&&lower(item.contractAddress)!=='0x0000000000000000000000000000000000000000')continue;
  const row=transferRow(chain,tx,'',item.from,item.to,item.value);if(!row)continue;
  const k=item.category+':'+row.from+':'+row.to;
  if(!sums.has(k))sums.set(k,{...row,id:`${chain.id}:${tx.hash}:native:nr:${k}`,raw:'0'});
  const r=sums.get(k);r.raw=(BigInt(r.raw)+BigInt(row.raw)).toString();
 }
 return [...sums.values()];
}
export async function nativeFromNodeReal(url,chain,tx,signal){
 const items=[];
 for(const direction of ['toAddress','fromAddress']){
  let cursor=null;const seen=new Set();
  do{
   await sleep(1200);
   const q={category:['external','internal'],transactionHash:tx.hash,fromBlock:tx.blockNumber,toBlock:tx.blockNumber,[direction]:EVM,maxCount:'0x3e8',order:'asc'};
   if(cursor)q.pageKey=cursor;
   const result=await rpc(url,'nr_getAssetTransfers',[q],signal);
   if(!Array.isArray(result.transfers))throw Error('NodeReal 内部转账列表缺失');
   // Exclude self-transfers before concatenating incoming/outgoing queries.
   items.push(...result.transfers.filter(r=>lower(r.from)!==lower(r.to)&&lower(r[direction==='toAddress'?'to':'from'])===EVM));
   cursor=result.pageKey||result.PageKey||null;
   if(cursor&&seen.has(cursor))throw Error('NodeReal 内部转账分页未前进');
   if(cursor)seen.add(cursor);
  }while(cursor);
 }
 return nodeRealNativeRows(items,chain,tx);
}

export async function inspectExtended(chain, hash, key, routers, signal, nativeLoader) {
  const isBSC = chain.id === '56', url = isBSC ? `https://bsc-mainnet.nodereal.io/v1/${encodeURIComponent(key)}` : chain.id === '196' ? 'https://rpc.xlayer.tech' : 'https://rpc.linea.build';
  const tx = await rpc(url, 'eth_getTransactionByHash', [hash], signal);
  const receipt = await rpc(url, 'eth_getTransactionReceipt', [hash], signal);
  if (lower(tx.hash) !== lower(hash) || lower(receipt.transactionHash) !== lower(hash) || tx.blockHash !== receipt.blockHash) throw Error('交易与回执不一致，请重新同步');
  if (receipt.status !== '0x1') return [];
  const block = await rpc(url, 'eth_getBlockByHash', [receipt.blockHash, false], signal);
  tx.timestamp = new Date(integer(block.timestamp) * 1000).toISOString();
  const sender = lower(tx.from); tx.from = { hash: sender, is_contract: true }; tx.to = { hash: lower(tx.to) }; tx.status = 'ok';
  const code = await rpc(url, 'eth_getCode', [sender, receipt.blockNumber], signal);
  tx.from.is_contract = code !== '0x';
  let rows;
  if (isBSC) {
    rows = await nativeFromNodeReal(url, chain, tx, signal);
  } else if (chain.id === '196') {
    if (!nativeLoader) throw Error('X Layer 内部交易数据源未配置');
    rows = await nativeLoader(tx);
  } else {
    const items = await etherscan(key, chain.id, 'txlistinternal', { txhash: hash }, signal);
    rows = nativeFromEtherscan(items, chain, tx);
  }
  const assets = new Set();
  for (const l of receipt.logs || []) {
    if (lower(l.topics?.[0]) === TRANSFER && l.topics.length === 3 && l.topics.slice(1).some(t => lower('0x' + t.slice(-40)) === EVM)) assets.add(lower(l.address));
    if (FEE_TOPICS.includes(lower(l.topics?.[0])) && [194,258].includes(l.data?.length) && lower('0x' + l.data.slice(154,194)) === EVM) {
      const asset = lower('0x' + l.data.slice(26,66));
      if (asset !== '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') assets.add(asset);
    }
  }
  const metadata = {};
  for (const asset of assets) {
    const d = await rpc(url, 'eth_call', [{ to: asset, data: '0x313ce567' }, receipt.blockNumber], signal);
    const decimals = integer(d); if (decimals > 36) throw Error('代币精度超出支持范围，需要人工核对');
    let symbol = asset;
    try { symbol = decodeSymbol(await rpc(url, 'eth_call', [{ to: asset, data: '0x95d89b41' }, receipt.blockNumber], signal), asset); } catch (e) { if (signal?.aborted) throw e; }
    metadata[asset] = { decimals, symbol };
  }
  rows.push(...tokenTransfers(receipt.logs || [], chain, tx, metadata));
  const fees = decodeFeeLogs(receipt.logs || [], chain, tx, metadata, routers[chain.id] || []);
  return reconcileFeeTransfers(rows, fees);
}
