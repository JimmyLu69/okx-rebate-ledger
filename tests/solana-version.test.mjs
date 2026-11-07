import test from 'node:test';
import assert from 'node:assert/strict';
import {scanSolana, inspectSolana} from '../dist/api.mjs';
import {configureWallets} from '../dist/ledger.mjs';

const wallet = 'So11111111111111111111111111111111111111112';
const sender = 'A'.repeat(44);
const transaction = version => ({version,blockTime:1,meta:{err:null},transaction:{message:{...(version === 1 ? {transactionConfig:{computeUnitLimit:30000}} : {}),accountKeys:[{pubkey:sender,signer:true},{pubkey:wallet,signer:false}],instructions:[{program:'system',programId:'11111111111111111111111111111111',parsed:{type:'transfer',info:{source:sender,destination:wallet,lamports:10}}}]}}});

test('Solana scan handles legacy, v0 and v1 transactions and advances only after complete page', async () => {
  configureWallets('',wallet);
  const previous=globalThis.fetch, signatures=['legacy','v0','v1'], versions=['legacy',0,1], checkpoints=[];
  let pages=0;
  globalThis.fetch=async (url, options={}) => {
    if(String(url).includes('/addresses/')) return Response.json(pages++ === 0 ? signatures.map(signature=>({signature})) : []);
    const query=JSON.parse(options.body);
    assert.equal(query.method,'getTransaction');
    assert.equal(query.params[1].maxSupportedTransactionVersion,1);
    return Response.json({result:transaction(versions[signatures.indexOf(query.params[0])])});
  };
  try {
    await scanSolana('test',async (rows,checkpoint)=>checkpoints.push({rows,checkpoint}),()=>{});
    assert.deepEqual(checkpoints[0].rows.map(r=>r.hash),signatures);
    assert.equal(checkpoints[0].checkpoint.cursor,'v1');
    assert.equal(checkpoints[1].checkpoint.complete,true);
  } finally {globalThis.fetch=previous}
});

test('Solana recheck accepts and parses a v1 transaction', async () => {
  configureWallets('',wallet);
  const previous=globalThis.fetch;
  globalThis.fetch=async (_url, options) => {
    const query=JSON.parse(options.body);
    assert.equal(query.params[1].maxSupportedTransactionVersion,1);
    return Response.json({result:transaction(1)});
  };
  try {const rows=await inspectSolana('v1-recheck','test');assert.equal(rows.length,1);assert.equal(rows[0].raw,'10');assert.equal(rows[0].from,sender)}
  finally {globalThis.fetch=previous}
});

test('Solana scan does not checkpoint an incomplete page when transaction fetch fails', async () => {
  configureWallets('',wallet);
  const previous=globalThis.fetch, checkpoints=[];
  globalThis.fetch=async (url) => String(url).includes('/addresses/')
    ? Response.json([{signature:'failure'}])
    : Response.json({jsonrpc:'2.0',error:{code:-32015,message:'unsupported version'}});
  try {await assert.rejects(scanSolana('test',async (...args)=>checkpoints.push(args),()=>{}));assert.equal(checkpoints.length,0)}
  finally {globalThis.fetch=previous}
});
