import "./fixtures.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { EVM, SOL } from "../dist/ledger.mjs";
import { runSync, RecordIndex } from "../dist/sync-controller.mjs";
import { clearEvidenceCache } from "../dist/evidence-cache.mjs";
const signature = "A".repeat(88),
  sender = "B".repeat(44),
  now = "2026-10-01T00:00:00.000Z";
const sol = { id: "solana", name: "Solana", symbol: "SOL", decimals: 9 };
const evm = { id: "4663", name: "Synthetic EVM", symbol: "ETH", decimals: 18 };
const oldRow = {
  id: `solana:${signature}:ix:0`,
  chain: "solana",
  asset: "native",
  symbol: "SOL",
  decimals: 9,
  raw: "9999",
  hash: signature,
  from: sender,
  to: SOL,
  trader: sender,
  direction: "in",
  kind: "pending",
  time: now,
  importedUnverified: true,
};
const tx = {
  blockTime: 1,
  meta: {
    err: null,
    preTokenBalances: [],
    postTokenBalances: [],
    innerInstructions: [],
  },
  transaction: {
    message: {
      accountKeys: [{ pubkey: sender, signer: true }, { pubkey: SOL }],
      instructions: [
        {
          program: "system",
          programId: "11111111111111111111111111111111",
          parsed: {
            type: "transfer",
            info: { source: sender, destination: SOL, lamports: "2" },
          },
        },
      ],
    },
  },
};
const makeState = (records) => ({
  version: 1,
  records,
  decisions: {},
  coverage: {},
  selected: ["solana", "4663"],
  updated: null,
});
const baseOptions = (state) => ({
  state,
  ids: ["solana"],
  chains: [sol, evm],
  keys: { helius: "synthetic", blockscout: "synthetic" },
  routers: {},
  wallets: { evm: EVM, sol: SOL },
  signal: new AbortController().signal,
  onProgress() {},
  onChange() {},
  onCheckpoint: async () => {},
  force: true,
});
function solanaResponse(url, options) {
  const u = new URL(String(url), "https://local.test");
  if (u.hostname === "api.helius.xyz" && u.pathname.includes("/addresses/"))
    return Response.json(
      u.searchParams.has("before-signature")
        ? []
        : [{ signature, source: "UNKNOWN", feePayer: sender }],
    );
  if (u.hostname === "mainnet.helius-rpc.com")
    return Response.json({ result: tx });
  throw Error("Unexpected test request " + u.hostname + u.pathname);
}

test("Solana scan replaces the complete transaction before marking it inspected", async () => {
  const priorFetch = globalThis.fetch;
  await clearEvidenceCache();
  globalThis.fetch = async (url, options) => solanaResponse(url, options);
  try {
    const stale = {
      ...oldRow,
      id: `solana:${signature}:ix:9`,
      raw: "5000",
      kind: "commission",
    };
    const state = makeState([oldRow, stale]);
    const result = await runSync(baseOptions(state));
    assert.deepEqual(result, { errors: [], aborted: false });
    assert.equal(state.records.length, 1);
    assert.equal(state.records[0].raw, "2");
    assert.equal(state.records[0].id, oldRow.id);
    assert.equal(state.records[0].importedUnverified, undefined);
    assert.deepEqual(state.coverage.solana.inspected, [signature]);
    assert.equal(state.coverage.solana.status, "complete");
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("a fatal checkpoint cancels all providers and waits for delayed cancellation before returning", async () => {
  const priorFetch = globalThis.fetch;
  await clearEvidenceCache();
  let slowStarted = false,
    slowStopped = false,
    saveCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url) === "/api/blockscout") {
      slowStarted = true;
      return new Promise((resolve, reject) => {
        const cancelled = () =>
          setTimeout(() => {
            slowStopped = true;
            reject(Error("cancelled after cleanup"));
          }, 35);
        if (options.signal.aborted) cancelled();
        else
          options.signal.addEventListener("abort", cancelled, { once: true });
      });
    }
    return solanaResponse(url, options);
  };
  try {
    const state = makeState([]),
      options = baseOptions(state);
    options.ids = ["4663", "solana"];
    options.onCheckpoint = async () => {
      saveCalls++;
      throw Error("synthetic disk full");
    };
    await assert.rejects(runSync(options), /synthetic disk full/);
    assert.equal(slowStarted, true);
    assert.equal(slowStopped, true);
    assert.equal(saveCalls, 1);
    const snapshot = JSON.stringify(state);
    await new Promise((resolve) => setTimeout(resolve, 45));
    assert.equal(JSON.stringify(state), snapshot);
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("an ordinary provider error is isolated and does not cancel another provider", async () => {
  const priorFetch = globalThis.fetch;
  await clearEvidenceCache();
  globalThis.fetch = async (url, options) =>
    String(url) === "/api/blockscout"
      ? new Response("{}", { status: 401 })
      : solanaResponse(url, options);
  try {
    const state = makeState([]),
      options = baseOptions(state);
    options.ids = ["4663", "solana"];
    const result = await runSync(options);
    assert.deepEqual(result.errors, ["4663"]);
    assert.equal(result.aborted, false);
    assert.equal(state.coverage["4663"].status, "error");
    assert.equal(state.coverage.solana.status, "complete");
    assert.equal(state.records[0].raw, "2");
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test("transaction replacement validates the complete result before deleting any old rows", () => {
  const index = new RecordIndex([oldRow]);
  assert.throws(
    () =>
      index.replace("solana", signature, [{ ...oldRow, hash: "C".repeat(88) }]),
    /不匹配/,
  );
  assert.throws(
    () => index.replace("solana", signature, [oldRow, oldRow]),
    /不匹配/,
  );
  assert.equal(index.transaction("solana", signature)[0].raw, "9999");
  index.replace("solana", signature, []);
  assert.deepEqual(index.values(), []);
});
