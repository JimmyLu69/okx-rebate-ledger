import test from 'node:test';
import assert from 'node:assert/strict';
import {createSaver} from '../dist/persistence.mjs';
import {serializeBackup,readBackupStream} from '../dist/backup-codec.mjs';
import {encryptBackupBytes,decryptBackup} from '../dist/backup-crypto.mjs';
import {handlePrices} from '../server/prices-proxy.mjs';
test('failed checkpoints retain the latest unsaved data and permit an emergency export',async()=>{
  let fail=true,attempts=0;const writes=[];
  const saver=createSaver(async(key,value)=>{attempts++;if(fail)throw Error('Quota exhausted');writes.push(value)},10000);
  let state={records:[1]};saver.queue('wallet',()=>state);
  await assert.rejects(saver.flush(),/Quota/);assert.equal(saver.pending,1);
  state={records:[1,2]};const result=await saver.flushForExport();assert.equal(result.saved,false);assert.match(result.error.message,/Quota/);assert.equal(attempts,1);
  assert.deepEqual(JSON.parse(await(await serializeBackup(state)).text()),state);
  fail=false;await saver.flush();assert.deepEqual(writes,[state]);assert.equal(saver.pending,0);assert.equal(saver.error,null);
});
test('chunked backup is equivalent JSON and reports bounded progress',async()=>{
  const value={format:'rebate-history',state:{records:Array.from({length:10000},(_,i)=>({id:String(i),raw:'123',symbol:'中文',extra:undefined})),lastRecheck:{entries:[]},coverage:{}},omitted:undefined};
  const progress=[];const blob=await serializeBackup(value,{onProgress:p=>progress.push(p)});
  assert.deepEqual(JSON.parse(await blob.text()),JSON.parse(JSON.stringify(value)));assert(progress.length>2);assert.equal(progress.at(-1).bytes,blob.size);
  await assert.rejects(serializeBackup(value,{maxBytes:1024}),/超过/);
});
test('backup serialization and streamed decompression can be cancelled',async()=>{
  const controller=new AbortController();
  await assert.rejects(serializeBackup({records:Array.from({length:10000},()=>({raw:'1'.repeat(100)}))},{signal:controller.signal,onProgress(){controller.abort()}}),e=>e.name==='AbortError');
  let cancelled=false;const readerController=new AbortController();
  const source=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(2048))},cancel(){cancelled=true}});
  await assert.rejects(readBackupStream(source,{maxBytes:1024}),/超过/);assert(cancelled);
});
test('serialized-byte encryption preserves the portable envelope and clears plaintext',async()=>{
  const bytes=new TextEncoder().encode('{"synthetic":"portable"}');
  const envelope=await encryptBackupBytes(bytes,'long-test-password');assert(bytes.every(x=>x===0));
  assert.deepEqual(await decryptBackup(envelope,'long-test-password'),{synthetic:'portable'});
});
test('price upstream responses stop at their byte budget, including an oversized declared body',async()=>{
  const request=new Request('https://ledger.test/api/prices',{method:'POST',headers:{Origin:'https://ledger.test','Content-Type':'application/json'},body:JSON.stringify({assets:[{chain:'1',asset:'native'}]})});
  let delivered=0,cancelled=0;
  const fetcher=async()=>new Response(new ReadableStream({pull(controller){delivered+=64*1024;controller.enqueue(new Uint8Array(64*1024))},cancel(){cancelled++}}),{headers:{'Content-Length':String(8*1024*1024)}});
  const response=await handlePrices(request,fetcher),result=await response.json();
  assert.equal(response.status,200);assert.deepEqual(result.prices,{});assert(result.errors.length);assert(cancelled>=1);assert(delivered<8*1024*1024);
});
