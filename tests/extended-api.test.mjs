import {seed} from './fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EVM, mergeRecords, summarize } from '../dist/ledger.mjs';
import { nativeFromCallTree, nativeFromEtherscan, tokenTransfers, reconcileFeeTransfers, scanRanges, etherscan } from '../dist/extended-api.mjs';
const chain = { id: '56', symbol: 'BNB', decimals: 18 };
const trader = '0x' + '2'.repeat(40), contract = '0x' + '3'.repeat(40), token = '0x' + '4'.repeat(40);
const tx = { hash: '0x' + '1'.repeat(64), from: { hash: trader }, to: { hash: contract }, value: '0x10', timestamp: '2026-01-01T00:00:00.000Z' };
const call = (value, rest = {}) => ({ type: 'CALL', from: contract, to: EVM, value, ...rest });
test('BSC call tree excludes reverted descendants and delegatecall value; distinct identical payouts retained', () => {
  const tree = call('0x0', { from: trader, to: contract, calls: [call('0x10'), call('0x10'), call('0xff', { type: 'DELEGATECALL' }), call('0x0', { error: 'revert', calls: [call('0xff')] }), call('0x100', { error: 'revert' })] });
  const rows = nativeFromCallTree(tree, chain, tx);
  assert.equal(rows.length, 2); assert.deepEqual(rows.map(r => r.raw), ['16', '16']);
  assert.notEqual(rows[0].id, rows[1].id);
  assert.equal(rows[0].kind, 'pending');
});
test('Linea root transfer is counted once and failed internal calls excluded', () => {
  const t = { ...tx, from: { hash: EVM }, to: { hash: trader } };
  const rows = nativeFromEtherscan([{ from: EVM, to: trader, value: '16', type: 'call', traceId: '0', isError: '0' }, { from: EVM, to: trader, value: '100', type: 'call', traceId: '0_1', isError: '1' }], chain, t);
  assert.equal(rows.length, 1); assert.equal(rows[0].raw, '16');
  const noTrace=nativeFromEtherscan([{from:contract,to:EVM,value:'16',type:'call',isError:'0'},{from:contract,to:EVM,value:'16',type:'call',isError:'0'}],chain,tx);assert.equal(noTrace.length,1);assert.equal(noTrace[0].raw,'32');assert.equal(noTrace[0].id,nativeFromEtherscan([{from:contract,to:EVM,value:'32',type:'call',isError:'0'}],chain,tx)[0].id);
});
test('ERC20 receipt logs use real indices, exact raw amounts, exclude ERC721 shape', () => {
  const topics = ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + contract.slice(2).padStart(64, '0'), '0x' + EVM.slice(2).padStart(64, '0')];
  const log = { address: token, logIndex: '0x1f', topics, data: '0x' + 'f'.repeat(64) };
  const rows = tokenTransfers([log, { ...log, logIndex: '0x20', topics: [...topics, '0x' + '0'.repeat(64)] }], chain, tx, { [token]: { symbol: 'TEST', decimals: 18 } });
  assert.equal(rows.length, 1); assert.equal(rows[0].raw, BigInt(log.data).toString()); assert.ok(rows[0].id.endsWith(':token:31'));
});
test('manual confirmation before receipt verification cannot double-count the commission', () => {
  const transfer = { ...seed, id: 'underlying-transfer', kind: 'commission', reviewed: true };
  const rows = reconcileFeeTransfers([{ ...transfer, reviewed: false, kind: 'pending' }], [{ ...seed }]);
  const merged = mergeRecords([transfer], rows);
  assert.equal(merged[0].kind, 'commission');
  assert.deepEqual(merged[0].supersededBy, [seed.id]);
  assert.equal(summarize(merged)[0].due, seed.raw);
});
test('mismatched event amount leaves actual transfer pending instead of counting an invented commission', () => {
  const transfer = { ...seed, id: 'transfer', kind: 'pending', raw: '10' };
  const rows = reconcileFeeTransfers([transfer], [{ ...seed }]);
  assert.equal(rows[0].kind, 'pending'); assert.equal(rows[1].kind, 'ignore'); assert.equal(summarize(rows).length, 0);
});
test('range scanner saves pages, resumes exact cursor and never skips range boundary', async () => {
  const requests = [], checkpoints = [], hashes = [];
  await scanRanges({ chain, streams: ['in', 'out'], windowSize: 10, endBlock: 22, start: { in: { next: 10, page: 2, cursor: 'resume', endBlock: 20 }, out: { complete: true } },
    fetchPage: async (...args) => { requests.push(args); return { hashes: [tx.hash], more: false }; },
    onPage: async (rows, p) => { hashes.push(...rows); checkpoints.push(p); }, onProgress() {} });
  assert.deepEqual(requests, [['in', 10, 19, 2, 'resume'], ['in', 20, 20, 1, null]]);
  assert.equal(checkpoints.at(-1).complete, true); assert.equal(checkpoints.at(-1).next, 21);
  assert.equal(mergeRecords([], hashes).length, 1);
});
test('range scanner detects stuck pagination instead of claiming complete', async () => {
  let complete = false;
  await assert.rejects(scanRanges({ chain, streams: ['in'], windowSize: 10, endBlock: 10,
    fetchPage: async () => ({ hashes: [tx.hash], more: true, cursor: 'stuck' }), onPage: async (_, p) => { complete ||= p.complete; }, onProgress() {} }), /分页内容重复/);
  assert.equal(complete, false);
});
test('Etherscan NOTOK must not be interpreted as an empty successful history', async () => {
  const old = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ status: '0', message: 'NOTOK', result: 'Invalid API Key' }));
    await assert.rejects(etherscan('dummy', '59144', 'txlist', {}, undefined), /Etherscan 未完成/);
    globalThis.fetch = async () => new Response(JSON.stringify({ status: '0', message: 'No transactions found', result: [] }));
    assert.deepEqual(await etherscan('dummy', '59144', 'txlist', {}, undefined), []);
  } finally { globalThis.fetch = old; }
});
test('BSC backwards windows cover newest to genesis without gaps', async () => {
  const ranges = [], checkpoints = [];
  await scanRanges({ chain, streams: ['in'], windowSize: 10, endBlock: 22, reverse: true,
    fetchPage: async (_, from, to) => { ranges.push([from, to]); return { hashes: [], more: false }; }, onPage: async (_, p) => checkpoints.push(p), onProgress() {} });
  assert.deepEqual(ranges, [[20, 22], [10, 19], [0, 9]]);
  assert.equal(checkpoints.at(-1).complete, true);
});
test('BSC free transfer index keeps repeated payouts, excludes failed/delegate calls and validates hash',async()=>{
 const {nodeRealNativeRows}=await import('../dist/extended-api.mjs');
 const row={hash:tx.hash,category:'internal',from:contract,to:EVM,value:'0x10',receiptsStatus:1,type:'call'};
 const rows=nodeRealNativeRows([row,row,{...row,value:'0xff',receiptsStatus:0},{...row,type:'delegatecall'}],chain,tx);
 assert.equal(rows.length,1);assert.equal(rows[0].raw,'32');
 assert.throws(()=>nodeRealNativeRows([{...row,hash:'0x'+'9'.repeat(64)}],chain,tx),/其他交易/);
});
