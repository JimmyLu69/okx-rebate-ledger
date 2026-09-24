import { EVM, parseAmount } from './ledger.mjs';
import { request } from './api.mjs';
import { rpc, scanRanges, inspectExtended, transferRow, discovery } from './extended-api.mjs';
const pause = () => new Promise(r => setTimeout(r, 1100));
export async function xquery(credentials, endpoint, params, signal) {
  if (!credentials || ['key', 'secret', 'passphrase'].some(k => !credentials[k])) throw Error('请填写三项 OKX 开发者凭证');
  await pause();
  const response = await request('/api/xlayer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credentials, endpoint, params }) }, signal);
  const page = response.data?.[0];
  // Some empty windows report page 0. Only accept an explicitly empty list
  // with totalPage 0; a missing list is still an incomplete response.
  const list=page?.transactionList??page?.internalTransactionDetails;
  if(page&&(page.totalPage===''||Number(page.totalPage)===0)&&Array.isArray(list)&&list.length===0&&Number(params.page||1)===1&&['0','1'].includes(String(page.page)))return {...page,page:'1',totalPage:'0'};
  if (!page || Number(page.page) !== Number(params.page || 1) || !/^\d+$/.test(String(page.totalPage)) || Number(page.totalPage) >= 10000) throw Error('OKX 历史分页不完整或达到上限，不能标记查完');
  return page;
}
export async function scanXLayer(chain, credentials, onPage, onProgress, signal, start = {}) {
  const block = await rpc('https://rpc.xlayer.tech', 'eth_getBlockByNumber', ['finalized', false], signal);
  const endBlock = Object.values(start).find(p => p.endBlock != null)?.endBlock ?? Number(block.number);
  if (!Number.isSafeInteger(endBlock) || endBlock < 0) throw Error('X Layer 区块高度无效');
  for (const stream of ['internal-transaction-list', 'token-transaction-list']) {
    await scanRanges({ chain, streams: [stream], windowSize: endBlock + 1, endBlock, start: {[stream]:start[stream]?.complete||start[stream]?.fullRange||start[stream]?.minBlock!=null?start[stream]:{}}, reverse: true, onPage:(rows,p)=>onPage(rows,{...p,fullRange:true}), onProgress, signal,
      fetchPage: async (s, from, to, page) => {
        const data = await xquery(credentials, 'address/' + s, { address: EVM, startBlockHeight: from, endBlockHeight: to, page, limit: 50, ...(s === 'token-transaction-list' ? { protocolType: 'token_20' } : {}) }, signal);
        if (!Array.isArray(data.transactionList) || data.transactionList.some(x => Number(x.height) < from || Number(x.height) > to)) throw Error('X Layer 返回了区间外或不完整记录');
        if (Number(data.totalPage) > page && !data.transactionList.length) throw Error('X Layer 中间页为空，历史未完整');
        return { hashes: data.transactionList.map(x => x.txId || x.txid), more: page < Number(data.totalPage) };
      }
    });
  }
  await scanXLayerOutgoing(chain,credentials,endBlock,onPage,onProgress,signal,start['normal-outgoing']);
}

export function xlayerNative(items, chain, tx) {
  const rows = [], root = transferRow(chain, tx, 'native:root', tx.from.hash, tx.to.hash, tx.value);
  if (root) rows.push(root);
  const amounts = new Map();
  for (const item of items) {
    if (item.state !== 'success' || !['call', 'create', 'create2', 'suicide', 'selfdestruct'].includes(String(item.operation).toLowerCase())) continue;
    const from = String(item.from).toLowerCase(), to = String(item.to).toLowerCase();
    if (from === to || from !== EVM && to !== EVM) continue;
    const raw = parseAmount(String(item.amount), chain.decimals);
    if (root && from === root.from && to === root.to && raw === root.raw) {
      if (tx.from.is_contract === false) continue;
      throw Error('合约账户的顶层与内部转账无法消歧，需要完整调用轨迹核对');
    }
    const key = from + ':' + to;
    amounts.set(key, (amounts.get(key) || 0n) + BigInt(raw));
  }
  for (const [key, amount] of amounts) {
    const [from, to] = key.split(':');
    const row = transferRow(chain, tx, 'native:internal:' + key, from, to, amount);
    if (row) rows.push(row);
  }
  return rows;
}
export async function inspectXLayer(chain, hash, credentials, routers, signal) {
  return inspectExtended(chain, hash, credentials, routers, signal, async tx => {
    let page = 1, total = 1, items = [];
    const seen = new Set();
    do {
      const data = await xquery(credentials, 'transaction/internal-transaction-detail', { txId: hash, page, limit: 50 }, signal);
      const part = data.internalTransactionDetails;
      if (!Array.isArray(part)) throw Error('X Layer 内部交易详情缺失');
      total = Number(data.totalPage);
      if (!part.length && page < total) throw Error('X Layer 内部交易中间页为空，不能认定完整');
      const fingerprint = JSON.stringify(part);
      if (part.length && seen.has(fingerprint)) throw Error('X Layer 内部交易分页重复，停止以免重复计账');
      seen.add(fingerprint); items.push(...part); page++;
    } while (page <= total);
    return xlayerNative(items, chain, tx);
  });
}

// Referral native payouts are internal transfers, and token payouts are logs.
// Find ALL ordinary outgoing transactions (refunds) by monotonic account nonce,
// rather than scanning millions of empty blocks or trusting a one-year index.
export async function nonceRanges(endBlock,getNonce,maxWindow=10000,startBlock=0){
 const total=Number(await getNonce(endBlock));
 if(!Number.isSafeInteger(total)||total<0)throw Error('X Layer nonce 无效');
 const ranges=[];
 async function visit(lo,hi,before,after){
  if(before===after)return;
  if(hi-lo<=maxWindow){ranges.push({from:lo+1,to:hi,before,after});return;}
  const mid=Math.floor((lo+hi)/2),n=Number(await getNonce(mid));
  if(!Number.isSafeInteger(n)||n<before||n>after)throw Error('历史 nonce 不一致，无法验证普通转出完整性');
  await visit(lo,mid,before,n);await visit(mid,hi,n,after);
 }
 const baseline=startBlock>0?Number(await getNonce(startBlock-1)):0;await visit(startBlock-1,endBlock,baseline,total);return {total:total-baseline,baseline,ranges};
}
export async function scanXLayerOutgoing(chain,credentials,endBlock,onPage,onProgress,signal,saved={}){
 if(saved?.complete)return;
 onProgress('X Layer · 定位全部手动转出历史');
 const {total,baseline,ranges}=await nonceRanges(endBlock,async height=>{if(signal?.aborted)throw Error('已暂停');return rpc('https://rpc.xlayer.tech','eth_getTransactionCount',[EVM,'0x'+height.toString(16)],signal)},10000,saved?.minBlock||0);
 const nonces=new Set();
 for(const range of ranges){
  let page=1,pages=1;const seen=new Set();
  do{
   onProgress(`X Layer · 普通转出 ${nonces.size}/${total}`);
   const data=await xquery(credentials,'address/normal-transaction-list-multi',{address:EVM,startBlockHeight:range.from,endBlockHeight:range.to,isFromOrTo:'from',page,limit:50},signal);
   if(!Array.isArray(data.transactionList))throw Error('X Layer 普通转出列表缺失');
   const fp=JSON.stringify(data.transactionList);if(data.transactionList.length&&seen.has(fp))throw Error('X Layer 普通转出分页重复');seen.add(fp);
   for(const t of data.transactionList){if(String(t.from).toLowerCase()!==EVM||Number(t.height)<range.from||Number(t.height)>range.to||!Number.isInteger(Number(t.nonce)))throw Error('X Layer 普通转出区间或归属不一致');nonces.add(Number(t.nonce));}
   await onPage(discovery(chain,data.transactionList.map(t=>t.txId)),{stream:'normal-outgoing',complete:false,minBlock:saved?.minBlock||0,endBlock});
   pages=Number(data.totalPage);page++;
  }while(page<=pages);
 }
 if(nonces.size!==total||[...nonces].some(n=>n<baseline||n>=baseline+total))throw Error(`X Layer 普通转出仍缺记录：${nonces.size}/${total}`);
 await onPage([],{stream:'normal-outgoing',complete:true,count:total,endBlock});
}
