import {seed} from './fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { handleXLayer, signRequest, validateQuery } from '../server/xlayer-proxy.mjs';
import { xlayerNative } from '../dist/xlayer-api.mjs';
import { EVM } from '../dist/ledger.mjs';
import worker from '../dist/server/index.js';
const endpoint = 'address/normal-transaction-list-multi';
const params = { address: EVM, startBlockHeight: 0, endBlockHeight: 9999, page: 1, limit: 50 };
const credentials = { key: 'test-key', secret: 'test-secret', passphrase: 'test-passphrase' };
const req = (body, origin = 'https://ledger.test') => new Request('https://ledger.test/api/xlayer', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
test('OKX signature includes exact query and matches independent HMAC implementation', async () => {
  const path = validateQuery({ endpoint, params }), timestamp = '2026-09-23T09:00:00.000Z';
  assert.equal(await signRequest(credentials.secret, timestamp, path), createHmac('sha256', credentials.secret).update(timestamp + 'GET' + path).digest('base64'));
});
test('proxy restricts endpoints, wallet, query range, and cross-origin access', async () => {
  assert.throws(() => validateQuery({ endpoint: '../dex/swap', params }));
  assert.throws(() => validateQuery({ endpoint, params: { ...params, address: 'invalid' } }));
  assert.throws(() => validateQuery({ endpoint, params: { ...params, endBlockHeight: 10001 } }));
  assert.throws(() => validateQuery({ endpoint, params: { ...params, destination: 'evil' } }));
  let fetched = false;
  const response = await handleXLayer(req({ endpoint, params, credentials }, 'https://other.test'), async () => { fetched = true; });
  assert.equal(response.status, 403); assert.equal(fetched, false);
});
test('proxy sends only read-only signed GET to OKX and never returns credential headers', async () => {
  let seen;
  const response = await handleXLayer(req({ endpoint, params, credentials }), async (url, options) => {
    seen = { url, options }; return new Response(JSON.stringify({ code: '0', data: [{ page: '1', totalPage: '0', transactionList: [] }] }));
  });
  assert.equal(response.status, 200); assert.equal(seen.options.method, 'GET');
  assert.equal(new URL(seen.url).origin, 'https://web3.okx.com');
  assert.equal(seen.options.redirect, 'manual'); assert.equal(seen.options.headers['OK-ACCESS-KEY'], credentials.key);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.text(); for (const secret of Object.values(credentials)) assert.equal(body.includes(secret), false);
});
test('payment-required and provider credential errors stop without forwarding challenge or secrets', async () => {
  for (const code of [402, 401]) {
    let count = 0;
    const response = await handleXLayer(req({ endpoint, params, credentials }), async () => { count++; return new Response(credentials.secret, { status: code, headers: { 'Payment-Required': credentials.key } }); });
    assert.equal(response.status, code); assert.equal(count, 1); assert.equal(response.headers.get('Payment-Required'), null);
    assert.equal((await response.text()).includes(credentials.secret), false);
  }
});
test('X Layer aggregates identical successful internal transfers exactly and excludes failures', () => {
  const from = '0x' + '3'.repeat(40), other = '0x' + '4'.repeat(40), hash = '0x' + '1'.repeat(64);
  const tx = { hash, from: { hash: other, is_contract: false }, to: { hash: from }, value: '0', timestamp: '' };
  const row = { state: 'success', operation: 'call', from, to: EVM, amount: '0.000000000000000001' };
  const result = xlayerNative([row, row, { ...row, state: 'fail', amount: '10' }, { ...row, operation: 'delegatecall', amount: '20' }], { id: '196', symbol: 'OKB', decimals: 18 }, tx);
  assert.equal(result.length, 1); assert.equal(result[0].raw, '2'); assert.equal(result[0].kind, 'pending');
});
test('worker serves actual app modules and rejects unknown routes', async () => {
  const app = await worker.fetch(new Request('https://ledger.test/'));
  assert.equal(app.status, 200); assert.ok((await app.text()).includes('xlayerSecret'));
  const mod = await worker.fetch(new Request('https://ledger.test/xlayer-api.mjs'));
  assert.match(mod.headers.get('Content-Type'), /javascript/);
  assert.equal((await worker.fetch(new Request('https://ledger.test/server/xlayer-proxy.mjs'))).status, 404);
});
test('X Layer accepts explicit empty page zero but rejects missing list and nonempty page mismatch',async()=>{
 const {xquery}=await import('../dist/xlayer-api.mjs');const original=globalThis.fetch;
 try{
  globalThis.fetch=async()=>new Response(JSON.stringify({data:[{page:'0',totalPage:'0',transactionList:[]}]}));
  assert.equal((await xquery(credentials,endpoint,params)).totalPage,'0');
  globalThis.fetch=async()=>new Response(JSON.stringify({data:[{page:'0',totalPage:'0'}]}));
  await assert.rejects(xquery(credentials,endpoint,params),/分页/);
  globalThis.fetch=async()=>new Response(JSON.stringify({data:[{page:'0',totalPage:'1',transactionList:[{txId:'x'}]}]}));
  await assert.rejects(xquery(credentials,endpoint,params),/分页/);
 }finally{globalThis.fetch=original}
});
test('nonce-guided X Layer history finds every outgoing block without a one-year cutoff',async()=>{
 const {nonceRanges}=await import('../dist/xlayer-api.mjs');
 const blocks=[2,2,20001,99000];let calls=0;
 const result=await nonceRanges(100000,n=>{calls++;return blocks.filter(b=>b<=n).length},10000);
 assert.equal(result.total,4);assert.ok(calls<40);
 for(const b of blocks)assert.equal(result.ranges.filter(r=>b>=r.from&&b<=r.to).length,1);
 assert.ok(result.ranges.every(r=>r.to-r.from<10000));
 assert.deepEqual((await nonceRanges(100000,()=>0)).ranges,[]);
});
