import test from "node:test";
import assert from "node:assert/strict";
import {
  abortableDelay,
  mapLimit,
  retryAfterMs,
  networkDiagnostics,
} from "../dist/network.mjs";
import {
  evidenceKey,
  configureEvidenceCache,
  clearEvidenceCache,
  cachedEvidence,
  evidenceDiagnostics,
  putEvidence,
} from "../dist/evidence-cache.mjs";
import { request } from "../dist/api.mjs";
import { pendingCounts, recheckOutcome } from "../dist/recheck.mjs";
const hash = "0x" + "a".repeat(64);
test("retry delays cancel immediately and Retry-After supports dates and seconds", async () => {
  const controller = new AbortController();
  const p = abortableDelay(30000, controller.signal);
  controller.abort();
  await assert.rejects(p);
  assert.equal(retryAfterMs("2"), 2000);
  assert.equal(retryAfterMs("Thu, 01 Jan 1970 00:00:10 GMT", 0), 10000);
});
test("mapLimit keeps output order and caps in-flight work", async () => {
  let active = 0,
    peak = 0;
  const result = await mapLimit([4, 3, 2, 1], 2, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await abortableDelay(n);
    active--;
    return n * 2;
  });
  assert.deepEqual(result, [8, 6, 4, 2]);
  assert.equal(peak, 2);
});
test("public evidence keys strip credentials and never cache changing history queries", () => {
  const options = {
    body: JSON.stringify({
      chain: "8453",
      path: "transactions/" + hash,
      key: "DO-NOT-STORE",
      params: {},
    }),
  };
  const key = evidenceKey("/api/blockscout", options);
  assert(!key.includes("DO-NOT-STORE"));
  assert(key.includes(hash));
  assert.equal(
    evidenceKey("/api/blockscout", {
      body: JSON.stringify({
        chain: "8453",
        path: "addresses/owner/token-transfers",
        key: "secret",
      }),
    }),
    null,
  );
  assert.equal(
    evidenceKey("https://bsc-mainnet.nodereal.io/v1/secret", {
      body: JSON.stringify({
        method: "eth_getBlockByNumber",
        params: ["latest", false],
      }),
    }),
    null,
  );
  assert(
    !evidenceKey("https://bsc-mainnet.nodereal.io/v1/secret", {
      body: JSON.stringify({
        method: "eth_getTransactionByHash",
        params: [hash],
      }),
    }).includes("secret"),
  );
});
test("bounded cache reuses public response, isolates mutations and supports forced refresh", async () => {
  configureEvidenceCache({ active: true });
  await clearEvidenceCache();
  let calls = 0;
  const load = async () => ({ result: { hash, value: ++calls } });
  const first = await cachedEvidence("test", load);
  first.result.value = 999;
  assert.equal((await cachedEvidence("test", load)).result.value, 1);
  assert.equal(calls, 1);
  configureEvidenceCache({ force: true });
  assert.equal((await cachedEvidence("test", load)).result.value, 2);
  configureEvidenceCache({ force: false });
  for (let i = 0; i < 1003; i++)
    await putEvidence("bounded:" + i, { result: i });
  assert(evidenceDiagnostics().memoryEntries <= 1000);
  await clearEvidenceCache();
  configureEvidenceCache({ active: false });
});
test("failed and null results never become cached proof", async () => {
  configureEvidenceCache({ active: true });
  await clearEvidenceCache();
  let calls = 0;
  const load = async () => {
    calls++;
    return { result: null };
  };
  await cachedEvidence("null", load);
  await cachedEvidence("null", load);
  assert.equal(calls, 2);
  await assert.rejects(() =>
    cachedEvidence("bad", async () => {
      throw Error("offline");
    }),
  );
  await cachedEvidence("bad", async () => ({ result: { valid: true } }));
  configureEvidenceCache({ active: false });
});
test("request total deadline bounds stalled fetch and diagnostics contain only provider totals", async () => {
  const old = globalThis.fetch;
  globalThis.fetch = async (url, options) =>
    new Promise((resolve, reject) =>
      options.signal.addEventListener("abort", () => reject(Error("aborted")), {
        once: true,
      }),
    );
  try {
    await assert.rejects(
      () =>
        request("https://public.example/rpc", {}, undefined, {
          attempts: 4,
          timeoutMs: 1000,
          deadlineMs: 25,
          cache: false,
        }),
      /总时限/,
    );
    assert(networkDiagnostics()["public.example"].requests > 0);
    assert(!JSON.stringify(networkDiagnostics()).includes("rpc"));
  } finally {
    globalThis.fetch = old;
  }
});
test("precounted recheck outcomes equal full scans at large scale", () => {
  const rows = Array.from({ length: 10000 }, (_, i) => ({
    chain: "8453",
    hash: String(i % 1000),
  }));
  const counts = pendingCounts(rows);
  for (const hash of ["0", "99", "missing"]) {
    const entry = { chain: "8453", hash, before: 10 };
    assert.deepEqual(
      recheckOutcome(entry, counts),
      recheckOutcome(entry, rows),
    );
  }
});

test("BSC count search proves the empty prefix in logarithmic requests without skipping the first transfer", async () => {
  const { firstActivityBlock } = await import("../dist/extended-api.mjs");
  const activity = [76543210, 76543210, 79000000];
  let calls = 0;
  const result = await firstActivityBlock(0, 80000000, async (from, to) => {
    calls++;
    return (
      "0x" + activity.filter((n) => n >= from && n <= to).length.toString(16)
    );
  });
  assert.deepEqual(result, { block: 76543210, count: 3 });
  assert(calls <= 31);
  assert.deepEqual(await firstActivityBlock(0, 100, async () => "0x0"), {
    block: null,
    count: 0,
  });
  await assert.rejects(
    () => firstActivityBlock(0, 100, async () => null),
    /格式/,
  );
  await assert.rejects(
    () =>
      firstActivityBlock(0, 100, async () => {
        throw Error("unsupported");
      }),
    /unsupported/,
  );
  const c = new AbortController();
  c.abort();
  await assert.rejects(
    () => firstActivityBlock(0, 100, async () => "0x1", c.signal),
    /暂停/,
  );
});

test("BSC automatically skips proven empty history, but unsupported counting falls back to all windows", async () => {
  const { scanBSC } = await import("../dist/extended-api.mjs");
  const original = globalThis.fetch;
  const chain = { id: "56", name: "BSC", symbol: "BNB", decimals: 18 };
  try {
    let requests = [],
      checkpoints = [];
    globalThis.fetch = async (url, options) => {
      const q = JSON.parse(options.body);
      requests.push(q);
      return Response.json(
        q.method === "eth_getBlockByNumber"
          ? { result: { number: "0x30d40" } }
          : { result: "0x0" },
      );
    };
    await scanBSC(
      chain,
      "synthetic",
      async (rows, p) => checkpoints.push(p),
      () => {},
    );
    assert.equal(
      requests.filter((q) => q.method === "nr_getAssetTransfersCount").length,
      2,
    );
    assert.equal(
      requests.filter((q) => q.method === "nr_getAssetTransfers").length,
      0,
    );
    assert.equal(checkpoints.filter((p) => p.complete).length, 2);
    requests = [];
    checkpoints = [];
    globalThis.fetch = async (url, options) => {
      const q = JSON.parse(options.body);
      requests.push(q);
      return Response.json(
        q.method === "eth_getBlockByNumber"
          ? { result: { number: "0x30d40" } }
          : q.method === "nr_getAssetTransfersCount"
            ? { error: { code: -32601, message: "unsupported" } }
            : { result: { transfers: [] } },
      );
    };
    await scanBSC(
      chain,
      "synthetic",
      async (rows, p) => checkpoints.push(p),
      () => {},
    );
    assert.equal(
      requests.filter((q) => q.method === "nr_getAssetTransfersCount").length,
      1,
    );
    const pages = requests.filter((q) => q.method === "nr_getAssetTransfers");
    assert.equal(pages.length, 6);
    assert(pages.some((q) => q.params[0].fromBlock === "0x0"));
    assert.equal(checkpoints.filter((p) => p.complete).length, 2);
    globalThis.fetch = async (url, options) =>
      Response.json(
        JSON.parse(options.body).method === "eth_getBlockByNumber"
          ? { result: { number: "0x30d40" } }
          : { result: "0x0" },
      );
    await assert.rejects(
      () =>
        scanBSC(
          chain,
          "synthetic",
          async () => {
            throw Error("storage-full");
          },
          () => {},
        ),
      /storage-full/,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("cached Blockscout receipts do not reserve a network rate-limit slot", async () => {
  const {bs}=await import('../dist/api.mjs');
  configureEvidenceCache({active:true});
  const options={body:JSON.stringify({chain:'8453',path:'transactions/'+hash,key:'synthetic',params:{}})};
  await putEvidence(evidenceKey('/api/blockscout',options),{hash,status:'ok'});
  const old=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;throw Error('No network expected')};
  try {
    const start=performance.now();
    await bs('8453','transactions/'+hash,'synthetic');
    await bs('8453','transactions/'+hash,'synthetic');
    assert.equal(calls,0);assert(performance.now()-start<100);
  } finally {globalThis.fetch=old;configureEvidenceCache({active:false})}
});

test("storage cache misses settle and a stalled IDB lookup respects cancellation", async () => {
  const previous=globalThis.indexedDB;let stall=false;
  globalThis.indexedDB={open(){
    const open={};queueMicrotask(()=>{open.result={close(){},transaction(){return {objectStore(){return {get(){const r={};if(!stall)queueMicrotask(()=>{r.result=undefined;r.onsuccess()});return r}}}}}};open.onsuccess()});return open;
  }};
  try {
    const cache=await import('../dist/evidence-cache.mjs?isolated-storage-regression');
    cache.configureEvidenceCache({active:true});
    assert.equal(await cache.getEvidence('missing'),null);
    stall=true;const controller=new AbortController();
    const result=cache.getEvidence('stalled',{signal:controller.signal});
    controller.abort(Error('synthetic stop'));
    await assert.rejects(result,/synthetic stop/);
  } finally {globalThis.indexedDB=previous}
});
