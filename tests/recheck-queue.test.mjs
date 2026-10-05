import test from "node:test";
import assert from "node:assert/strict";
import { runRecheckQueue, recheckFingerprint } from "../dist/recheck.mjs";
import { Worker } from "node:worker_threads";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test("bounded concurrency overlaps latency and isolates failures", async () => {
  let active = 0,
    peak = 0;
  const results = [];
  await runRecheckQueue(
    Array.from({ length: 9 }, (_, i) => i),
    async (i) => {
      active++;
      peak = Math.max(peak, active);
      await sleep(5);
      active--;
      if (i === 2) throw Error("provider failed");
      return i * 2;
    },
    (r) => results.push(r),
    { concurrency: 3 },
  );
  assert.equal(peak, 3);
  assert.equal(results.length, 9);
  assert.equal(results.find((r) => r.job === 2).error, "provider failed");
  assert.equal(results.find((r) => r.job === 8).value, 16);
});
test("pause stops dequeuing while completed work is retained", async () => {
  const controller = new AbortController(),
    results = [];
  let calls = 0;
  await runRecheckQueue(
    [1, 2, 3, 4, 5],
    async (i) => {
      calls++;
      await sleep(2);
      return i;
    },
    (r) => {
      results.push(r);
      controller.abort();
    },
    { signal: controller.signal, concurrency: 2 },
  );
  assert.equal(calls, 2);
  assert.equal(results.length, 2);
});
test("checkpoint changes only when source transfer identity or amount changes", () => {
  const row = { id: "one", asset: "native", raw: "12", direction: "in" };
  assert.equal(
    recheckFingerprint([row]),
    recheckFingerprint([
      { ...row, kind: "ignore", trader: "known" },
      { ...row, id: "fee", feeEvent: true },
    ]),
  );
  assert.notEqual(
    recheckFingerprint([row]),
    recheckFingerprint([{ ...row, raw: "13" }]),
  );
  assert.notEqual(
    recheckFingerprint([row]),
    recheckFingerprint([row, { ...row, id: "second" }]),
  );
});
test("actual worker returns receipt rows and done, without depending on DOM", async () => {
  const url = new URL("../dist/recheck-worker.mjs", import.meta.url).href;
  const w = new Worker(
    `const {parentPort}=require('node:worker_threads');global.self={postMessage:m=>parentPort.postMessage(m)};global.fetch=async()=>new Response(JSON.stringify({hash:'0x'+'a'.repeat(64),status:'ok',from:{hash:'0x'+'1'.repeat(40)},to:{hash:'0x'+'2'.repeat(40)}}));import(${JSON.stringify(url)}).then(()=>{parentPort.on('message',data=>self.onmessage({data}));parentPort.postMessage({type:'ready'})});`,
    { eval: true },
  );
  try {
    await new Promise((resolve, reject) => {
      w.once("error", reject);
      w.once("message", resolve);
    });
    const messages = [];
    const done = new Promise((resolve, reject) => {
      w.on("error", reject);
      w.on("message", (m) => {
        messages.push(m);
        if (m.type === "done") resolve();
        if (m.type === "fatal") reject(Error(m.error));
      });
    });
    w.postMessage({
      type: "start",
      wallets: { evm: "0x" + "1".repeat(40), sol: "" },
      keys: { blockscout: "synthetic" },
      routers: {},
      jobs: [
        {
          key: "one",
          fingerprint: "test",
          chain: { id: "4663" },
          hash: "0x" + "a".repeat(64),
          rows: [
            {
              id: "row",
              direction: "out",
              from: "0x" + "1".repeat(40),
              to: "0x" + "2".repeat(40),
            },
          ],
        },
      ],
    });
    await done;
    assert.equal(messages[0].type, "result");
    assert.equal(messages[0].rows[0].txSender, "0x" + "1".repeat(40));
    assert.equal(messages.at(-1).aborted, false);
  } finally {
    await w.terminate();
  }
});
test("streaming worker waits for end and accepts a later batch without premature completion", async () => {
  const url = new URL("../dist/recheck-worker.mjs", import.meta.url).href;
  const worker = new Worker(
    `const {parentPort}=require('node:worker_threads');global.self={postMessage:m=>parentPort.postMessage(m)};global.fetch=async()=>new Response(JSON.stringify({hash:'0x'+'a'.repeat(64),status:'ok',from:{hash:'0x'+'1'.repeat(40)},to:{hash:'0x'+'2'.repeat(40)}}));import(${JSON.stringify(url)}).then(()=>{parentPort.on('message',data=>self.onmessage({data}));parentPort.postMessage({type:'ready'})});`,
    { eval: true },
  );
  try {
    await new Promise((resolve, reject) => {
      worker.once("error", reject);
      worker.once("message", resolve);
    });
    const messages = [];
    let nextBatch;
    const needed = new Promise((resolve) => {
      nextBatch = resolve;
    });
    const done = new Promise((resolve, reject) => {
      worker.on("error", reject);
      worker.on("message", (message) => {
        messages.push(message);
        if (message.type === "need-jobs") nextBatch();
        if (message.type === "done") resolve();
      });
    });
    worker.postMessage({
      type: "start",
      streaming: true,
      jobs: [],
      wallets: { evm: "0x" + "1".repeat(40), sol: "" },
      keys: { blockscout: "synthetic" },
      routers: {},
    });
    await needed;
    assert(!messages.some((m) => m.type === "done"));
    worker.postMessage({
      type: "append",
      jobs: [
        {
          key: "later",
          fingerprint: "test",
          chain: { id: "4663" },
          hash: "0x" + "a".repeat(64),
          rows: [
            {
              id: "row",
              direction: "out",
              from: "0x" + "1".repeat(40),
              to: "0x" + "2".repeat(40),
            },
          ],
        },
      ],
    });
    worker.postMessage({ type: "end" });
    await done;
    assert.equal(messages.filter((m) => m.type === "result").length, 1);
    assert.equal(messages.filter((m) => m.type === "done").length, 1);
    assert(messages.at(-1).diagnostics.blockscout);
  } finally {
    await worker.terminate();
  }
});

test("streaming worker requests bounded replacement work while a tail request is active", async () => {
  const url=new URL('../dist/recheck-worker.mjs',import.meta.url).href;
  const worker=new Worker(`const {parentPort}=require('node:worker_threads');global.self={postMessage:m=>parentPort.postMessage(m)};global.fetch=async()=>{await new Promise(r=>setTimeout(r,70));return Response.json({hash:'0x'+'a'.repeat(64),status:'ok',from:{hash:'0x'+'1'.repeat(40)},to:{hash:'0x'+'2'.repeat(40)}})};import(${JSON.stringify(url)}).then(()=>{parentPort.on('message',data=>self.onmessage({data}));parentPort.postMessage({type:'ready'})});`,{eval:true});
  try {
    await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject)});
    const messages=[];
    const needed=new Promise((resolve,reject)=>{worker.on('error',reject);worker.on('message',m=>{messages.push(m);if(m.type==='need-jobs')resolve(m)})});
    worker.postMessage({type:'start',streaming:true,wallets:{evm:'0x'+'1'.repeat(40),sol:''},keys:{blockscout:'synthetic'},routers:{},jobs:[{key:'tail',chain:{id:'4663'},hash:'0x'+'a'.repeat(64),rows:[{id:'row',direction:'out',from:'0x'+'1'.repeat(40),to:'0x'+'2'.repeat(40)}]}]});
    const refill=await needed;
    assert.equal(refill.active,1);assert.equal(refill.credit,30);
    assert(!messages.some(m=>m.type==='result'));
  } finally {await worker.terminate()}
});
