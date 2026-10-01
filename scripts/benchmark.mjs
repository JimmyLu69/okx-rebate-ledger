// Synthetic, public fixtures only. Run: node --expose-gc scripts/benchmark.mjs
// Reports Node CPU/heap, not a user's browser, DOM, network or API-credit usage.
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import os from "node:os";
import { configureWallets, autoAccount } from "../dist/ledger.mjs";
import { configureAssetAllowlist } from "../dist/allowlist.mjs";
import {
  createViewModel,
  matchesFilters,
  pageItems,
} from "../dist/view-model.mjs";
import { RecordIndex } from "../dist/sync-controller.mjs";
import { pendingCounts, recheckOutcome } from "../dist/recheck.mjs";
const wallet = "0x" + "f".repeat(40),
  asset = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
configureWallets(wallet, "");
configureAssetAllowlist(
  JSON.parse(
    await readFile(
      new URL("../dist/asset-allowlist.json", import.meta.url),
      "utf8",
    ),
  ),
);
const round = (n) => Math.round(n * 100) / 100;
function recordsFor(size, invitees) {
  return Array.from({ length: size }, (_, i) => {
    const bucket = i % 10,
      commission = bucket < 4,
      outgoing = bucket >= 4 && bucket < 7,
      hash = "0x" + (i + 1).toString(16).padStart(64, "0"),
      trader =
        "0x" +
        (1000000 + (Math.floor(i / 10) % invitees))
          .toString(16)
          .padStart(40, "0");
    return {
      id: `8453:${hash}:${commission ? "fee" : "token-transfers"}:0`,
      chain: "8453",
      hash,
      asset,
      symbol: "USDC",
      decimals: 6,
      raw: String(1000000 + i),
      from: outgoing ? wallet : trader,
      to: outgoing ? trader : wallet,
      trader: commission ? trader : "",
      txSender: outgoing ? wallet : trader,
      direction: outgoing ? "out" : "in",
      kind: commission ? "commission" : "pending",
      time: "2026-09-25T00:00:00.000Z",
      stream: "token-transfers",
      evidence: "Synthetic benchmark fixture",
      ...(commission
        ? {
            feeEvent: true,
            protocol: "legacy-router",
            attributionVerified: true,
            receiptMatched: true,
          }
        : {}),
      ...(outgoing ? { paymentAuthorized: true, directTransfer: true } : {}),
    };
  });
}
function median(fn, repeats = 5) {
  fn();
  const times = [];
  for (let i = 0; i < repeats; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return round(times[Math.floor(times.length / 2)]);
}
const results = [];
for (const size of [1000, 10000, 50000]) {
  const records = recordsFor(size, 100),
    decisions = {},
    derive = createViewModel();
  global.gc?.();
  const before = process.memoryUsage();
  const model = derive(records, decisions, 1);
  const allocated = process.memoryUsage();
  global.gc?.();
  const retained = process.memoryUsage();
  const filters = {
    search: "USDC",
    chains: new Set(["8453"]),
    tokens: new Set(),
    types: new Set(),
    direction: new Set(["in"]),
  };
  const index = new RecordIndex(records),
    replacement = records
      .slice(0, 10)
      .map((row) => ({ ...row, raw: String(BigInt(row.raw) + 1n) }));
  const entries = model.pending.map((row) => ({
    key: row.chain + ":" + row.hash,
    chain: row.chain,
    hash: row.hash,
    before: 1,
  }));
  results.push({
    records: size,
    invitees: 100,
    pending: model.pending.length,
    groups: model.groups.length,
    jsonBytes: Buffer.byteLength(JSON.stringify(records)),
    autoAccountMs: median(() => autoAccount(records, decisions)),
    coldViewModelMs: median(() => createViewModel()(records, decisions, 1)),
    cachedModelLookupMs: median(() => derive(records, decisions, 1), 50),
    cachedFilterAndPageMs: median(() =>
      pageItems(
        derive(records, decisions, 1).pending.filter((row) =>
          matchesFilters(row, filters, "review"),
        ),
        1,
      ),
    ),
    replaceTenTransactionsMs: median(() => {
      for (const row of replacement) index.replace(row.chain, row.hash, [row]);
    }),
    indexedRecheckResultsMs: median(() => {
      const counts = pendingCounts(model.pending);
      return entries.map((entry) => recheckOutcome(entry, counts));
    }),
    allocatedHeapGrowthMiB: round(
      (allocated.heapUsed - before.heapUsed) / 2 ** 20,
    ),
    retainedModelHeapMiB: global.gc
      ? round((retained.heapUsed - before.heapUsed) / 2 ** 20)
      : null,
    nodeRssMiB: round(retained.rss / 2 ** 20),
  });
}
const manyInvitees = recordsFor(50000, 5000);
const stress = {
  records: 50000,
  invitees: 5000,
  autoAccountMs: median(() => autoAccount(manyInvitees, {}), 3),
};
console.log(
  JSON.stringify(
    {
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: os.cpus()[0]?.model,
        logicalCpus: os.cpus().length,
        ramGiB: round(os.totalmem() / 2 ** 30),
        explicitGC: !!global.gc,
      },
      method:
        "Five-run medians after warmup; synthetic 40% proven commission, 30% authorized direct refund, 30% pending. No DOM, live wallet, network or IndexedDB writes. RSS is this benchmark process, not browser usage.",
      results,
      stress,
    },
    null,
    2,
  ),
);
