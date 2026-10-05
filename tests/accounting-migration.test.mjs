import "./fixtures.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { seed } from "./fixtures.mjs";
import {
  EVM,
  SOL,
  autoAccount,
  pendingReview,
  summarize,
  replaceTransactionRecords,
} from "../dist/ledger.mjs";
import { historyBackup, restoreHistory } from "../dist/history.mjs";
import { validateState } from "../dist/validation.mjs";
import { inspectEVM } from "../dist/api.mjs";
import { planRecheck } from "../dist/recheck.mjs";
import { configureEvidenceCache } from "../dist/evidence-cache.mjs";
const wallets = { evm: EVM, sol: SOL },
  chain = {
    id: seed.chain,
    name: "Synthetic chain",
    symbol: "ETH",
    decimals: 18,
  };
const now = "2026-10-01T00:00:00.000Z";
const machineFee = {
  ...seed,
  raw: "100",
  feeEvent: true,
  receiptMatched: true,
  attributionVerified: true,
  protocol: "legacy-router",
};
const transfer = {
  ...seed,
  id: `${seed.chain}:${seed.hash}:internal-transactions:7`,
  raw: "100",
  kind: "ignore",
  trader: "",
  supersededBy: [seed.id],
  stream: "internal-transactions",
};
const state = (records) => ({
  version: 1,
  records,
  coverage: {
    [seed.chain]: {
      streams: { "internal-transactions": { complete: true, highBlock: 100 } },
      inspected: [seed.hash],
      status: "complete",
    },
  },
  selected: [seed.chain],
  updated: now,
});

test("local history retains valid proof; external history resets untrusted cursors and exposes all unverified rows", () => {
  const saved = state([transfer, machineFee]);
  const local = validateState(saved, { wallets, trustEvidence: true });
  assert.equal(summarize(autoAccount(local.records))[0].due, "100");
  const imported = restoreHistory(historyBackup(saved, wallets), wallets);
  assert.equal(summarize(autoAccount(imported.records)).length, 0);
  assert.deepEqual(
    pendingReview(imported.records)
      .map((r) => r.id)
      .sort(),
    [transfer.id, machineFee.id].sort(),
  );
  assert.deepEqual(imported.coverage[seed.chain].streams, {});
  assert.deepEqual(imported.coverage[seed.chain].inspected, []);
  // Untrusted machine fields remain available in the original history for audit.
  assert.deepEqual(imported.records[0].supersededBy, [seed.id]);
  assert.equal(pendingReview(imported.records)[0].supersededBy, undefined);
});

test("external self-swap, dust proof and old reviewed flags cannot silently hide imported records", () => {
  const signature = "A".repeat(88),
    who = "B".repeat(44);
  const sol = {
    id: `solana:${signature}:ix:0`,
    chain: "solana",
    asset: "native",
    symbol: "SOL",
    decimals: 9,
    raw: "1",
    hash: signature,
    from: who,
    to: SOL,
    trader: who,
    direction: "in",
    kind: "ignore",
    time: now,
    solanaSelfSwap: true,
    autoExcluded: true,
    reviewed: true,
  };
  const restored = restoreHistory([sol], wallets);
  assert.deepEqual(restored.decisions, {});
  assert.equal(pendingReview(restored.records).length, 1);
  assert.equal(autoAccount(restored.records)[0].spam, undefined);
  const base = {
    ...transfer,
    id: `8453:${seed.hash}:token:7`,
    chain: "8453",
    asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    symbol: "USDC",
    decimals: 6,
    raw: "124",
    kind: "pending",
    directTokenTransfer: true,
  };
  assert.equal(
    pendingReview(restoreHistory([base], wallets).records).length,
    1,
  );
});

test("separate manual decisions survive backup and machine replacement; vanished IDs do not create ghost funds", () => {
  const manual = {
    ...state([transfer, machineFee]),
    decisions: {
      [machineFee.id]: {
        kind: "commission",
        trader: seed.trader,
        reason: "核对订单归属",
        updatedAt: now,
      },
    },
  };
  const imported = restoreHistory(historyBackup(manual, wallets), wallets);
  assert.deepEqual(imported.decisions, manual.decisions);
  const replaced = replaceTransactionRecords(
    imported.records,
    [{ ...transfer, kind: "pending", supersededBy: undefined }],
    { chain: seed.chain, hash: seed.hash },
  );
  assert.equal(
    replaced.some((r) => r.id === machineFee.id),
    false,
  );
  assert.equal(summarize(autoAccount(replaced, imported.decisions)).length, 0);
  // The independent decision remains for audit even if its former derived row is gone.
  assert.equal(imported.decisions[machineFee.id].reason, "核对订单归属");
  const rawDecision = {
    [transfer.id]: {
      kind: "commission",
      trader: seed.trader,
      reason: "人工确认真实来款",
      updatedAt: now,
    },
  };
  assert.equal(summarize(autoAccount(replaced, rawDecision))[0].due, "100");
});

test("Blockscout recheck reconstructs imported transfers from real pages before restoring trust", async () => {
  const fetcher = globalThis.fetch,
    calls = [];
  const tx = {
    hash: seed.hash,
    status: "ok",
    from: { hash: seed.trader, is_contract: false },
    to: { hash: seed.from },
    value: "0",
    timestamp: now,
  };
  const word = (n) => BigInt(n).toString(16).padStart(64, "0");
  const log = {
    address: seed.from,
    index: 20,
    topics: [
      "0xcd5eae9d9d0b96532bd1b7dbf6628ce436b2af735829087a03c548439f8bf850",
    ],
    data:
      "0x" +
      "e".repeat(40).padStart(64, "0") +
      word(100) +
      EVM.slice(2).padStart(64, "0") +
      word(0),
  };
  const real = {
    status: "ok",
    index: 7,
    transaction_hash: seed.hash,
    from: { hash: seed.from },
    to: { hash: EVM },
    value: "100",
    timestamp: now,
  };
  configureEvidenceCache({ active: false });
  globalThis.fetch = async (_, options) => {
    const request = JSON.parse(options.body),
      path = request.path;
    calls.push(path);
    const value = path.endsWith("/logs")
      ? { items: [log], next_page_params: null }
      : path.endsWith("/token-transfers")
        ? { items: [], next_page_params: null }
        : path.endsWith("/internal-transactions")
          ? { items: [real], next_page_params: null }
          : tx;
    return new Response(JSON.stringify(value));
  };
  try {
    const forged = {
      ...transfer,
      id: `${seed.chain}:${seed.hash}:internal-transactions:999`,
      kind: "pending",
      supersededBy: undefined,
      raw: "999999999",
      importedUnverified: true,
    };
    const result = await inspectEVM(
      chain,
      seed.hash,
      "synthetic-test-key",
      { [chain.id]: [seed.from] },
      [forged],
    );
    const records = replaceTransactionRecords(
      [forged, machineFee],
      [...result.replace, ...result.fees],
      { chain: chain.id, hash: seed.hash },
    );
    assert.equal(
      records.some((r) => r.id === forged.id),
      false,
    );
    assert.equal(
      records.some((r) => r.importedUnverified),
      false,
    );
    assert.equal(summarize(autoAccount(records))[0].due, "100");
    assert(calls.some((p) => p.endsWith("/token-transfers")));
    assert(calls.some((p) => p.endsWith("/internal-transactions")));
    // A fee-only legacy record must still fetch the underlying transaction evidence.
    calls.length = 0;
    const { jobs } = planRecheck(
      [{ ...machineFee, kind: "pending" }],
      [machineFee],
      () => chain,
      { blockscout: "synthetic" },
    );
    assert.equal(jobs[0].rows.length, 0);
    const legacy = await inspectEVM(
      chain,
      seed.hash,
      "synthetic-test-key",
      { [chain.id]: [seed.from] },
      jobs[0].rows,
    );
    assert.equal(
      summarize(autoAccount([...legacy.replace, ...legacy.fees]))[0].due,
      "100",
    );
    assert(calls.some((p) => p.endsWith("/internal-transactions")));
  } finally {
    globalThis.fetch = fetcher;
    configureEvidenceCache({ active: false });
  }
});

test("strict local schema preserves every EVM commission and direct-refund proof field", () => {
  const payment = {
    ...transfer,
    id: `${seed.chain}:${seed.hash}:internal-transactions:8`,
    kind: "pending",
    supersededBy: undefined,
    direction: "out",
    from: EVM,
    to: seed.trader,
    txSender: EVM,
    raw: "40",
    paymentAuthorized: true,
    directTransfer: true,
  };
  const original = state([machineFee, payment]);
  const loaded = validateState(original, { wallets, trustEvidence: true });
  assert.deepEqual(
    summarize(autoAccount(loaded.records)),
    summarize(autoAccount(original.records)),
  );
  assert.equal(summarize(autoAccount(loaded.records))[0].paid, "40");
  assert.equal(loaded.records[0].protocol, "legacy-router");
  assert.equal(loaded.records[0].attributionVerified, true);
  assert.equal(loaded.records[0].receiptMatched, true);
  assert.equal(loaded.records[1].paymentAuthorized, true);
  assert.equal(loaded.records[1].directTransfer, true);
  assert.equal(loaded.records[1].txSender, EVM);
});

test("unverified imported raw amounts cannot be authenticated or hidden by imported manual decisions", () => {
  const forged = {
    ...transfer,
    raw: "999999999999999999999",
    kind: "pending",
    supersededBy: undefined,
  };
  for (const kind of ["commission", "ignore", "pending"]) {
    const saved = {
      ...state([forged]),
      decisions: {
        [forged.id]: {
          kind,
          trader: seed.trader,
          reason: "untrusted file assertion",
          updatedAt: now,
          keep: true,
        },
      },
    };
    const imported = restoreHistory(historyBackup(saved, wallets), wallets);
    const accounted = autoAccount(imported.records, imported.decisions);
    assert.equal(summarize(accounted).length, 0);
    assert.equal(accounted[0].kind, "pending");
    assert.equal(accounted[0].reviewed, undefined);
    assert.equal(pendingReview(imported.records, imported.decisions).length, 1);
    assert.equal(imported.decisions[forged.id].kind, kind);
    const verified = [{ ...forged, raw: "100" }];
    assert.equal(autoAccount(verified, imported.decisions)[0].kind, kind);
  }
  const payment = {
    ...forged,
    direction: "out",
    from: EVM,
    to: seed.trader,
    trader: seed.trader,
  };
  const saved = {
    ...state([payment]),
    decisions: {
      [payment.id]: {
        kind: "refund",
        trader: seed.trader,
        reason: "untrusted refund",
        updatedAt: now,
      },
    },
  };
  const imported = restoreHistory(historyBackup(saved, wallets), wallets);
  assert.equal(
    autoAccount(imported.records, imported.decisions)[0].kind,
    "pending",
  );
  assert.equal(
    summarize(autoAccount(imported.records, imported.decisions)).length,
    0,
  );
});
