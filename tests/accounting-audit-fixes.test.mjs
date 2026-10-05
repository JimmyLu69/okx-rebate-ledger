import test from "node:test";
import assert from "node:assert/strict";
import {
  autoAccount,
  summarize,
  reconcileFeeReceipts,
  migrateManualDecisions,
  configureWallets,
} from "../dist/ledger.mjs";
import { validateState } from "../dist/validation.mjs";
import { createViewModel, matchesFilters } from "../dist/view-model.mjs";
import {
  valueGroups,
  filterMinimum,
  addressTotals,
} from "../dist/valuation.mjs";
import { lookupPrices } from "../dist/prices.mjs";
import { configureAssetAllowlist } from "../dist/allowlist.mjs";
const own = "0x" + "1".repeat(40),
  trader = "0x" + "2".repeat(40),
  router = "0x" + "3".repeat(40),
  other = "0x" + "4".repeat(40),
  hash = "0x" + "a".repeat(64),
  secondHash = "0x" + "b".repeat(64),
  now = "2026-10-01T00:00:00.000Z";
configureWallets(own, "");
configureAssetAllowlist(null);
const raw = {
  id: `4663:${hash}:internal-transactions:1`,
  chain: "4663",
  hash,
  asset: "native",
  symbol: "ETH",
  decimals: 18,
  raw: "100",
  direction: "in",
  from: router,
  to: own,
  trader: "",
  kind: "pending",
  time: now,
};
const fee = {
  ...raw,
  id: `4663:${hash}:fee:2`,
  trader,
  kind: "commission",
  feeEvent: true,
  protocol: "legacy-router",
  attributionVerified: true,
  receiptMatched: true,
};
const decision = (kind, traderAddress = trader) => ({
  kind,
  trader: traderAddress,
  reason: "明确核对凭证",
  updatedAt: now,
});
const state = (records, decisions = {}) => ({
  version: 1,
  records,
  decisions,
  coverage: {
    4663: {
      streams: {
        transactions: {
          complete: true,
          highBlock: 1000,
          cursor: { block_number: 999 },
        },
      },
      inspected: [hash],
      status: "complete",
    },
  },
  selected: ["4663"],
  updated: now,
});
function reconciled(receipts = [raw], fees = [fee]) {
  const r = reconcileFeeReceipts(receipts, fees);
  return [...r.replace, ...r.fees];
}

test("legacy decisions migrate once; undo removes accounting now and after another local load", () => {
  const legacy = {
    ...raw,
    kind: "commission",
    trader,
    reviewed: true,
    evidence: "旧人工",
  };
  const loaded = validateState(state([legacy]), { trustEvidence: true });
  assert.equal(loaded.records[0].reviewed, undefined);
  assert.equal(
    summarize(autoAccount(loaded.records, loaded.decisions))[0].due,
    "100",
  );
  loaded.decisions = {};
  assert.deepEqual(
    summarize(autoAccount(loaded.records, loaded.decisions)),
    [],
  );
  const next = validateState(loaded, { trustEvidence: true });
  assert.deepEqual(next.decisions, {});
  assert.deepEqual(
    migrateManualDecisions(next.records, next.decisions).decisions,
    {},
  );
});
test("new fee receipt recognition preserves raw manual ignore and corrected invitee", () => {
  const rows = reconciled();
  const ignored = autoAccount(rows, { [raw.id]: decision("ignore", "") });
  assert.equal(summarize(ignored).length, 0);
  assert.equal(ignored.find((r) => r.id === raw.id).supersededBy, undefined);
  const corrected = autoAccount(rows, {
    [raw.id]: decision("commission", other),
  });
  const group = summarize(corrected)[0];
  assert.equal(group.due, "100");
  assert.equal(group.trader, other);
  assert.equal(corrected.find((r) => r.feeEvent).manualSuppressed, true);
  const again = autoAccount(reconciled(), {
    [raw.id]: decision("commission", other),
  });
  assert.equal(summarize(again)[0].trader, other);
});
test("partially reviewed batch restores all linked receipts and never invents allocation", () => {
  const raw2 = {
    ...raw,
    id: `4663:${hash}:internal-transactions:3`,
    raw: "40",
  };
  const rows = reconciled([{ ...raw, raw: "60" }, raw2]);
  const projected = autoAccount(rows, { [raw.id]: decision("ignore", "") });
  assert.equal(summarize(projected).length, 0);
  assert.equal(projected.find((r) => r.id === raw2.id).kind, "pending");
  assert.equal(projected.find((r) => r.id === raw2.id).supersededBy, undefined);
});
test("unmatched derived fee cannot be manually booked; verified fee can be attributed once", () => {
  const unbacked = {
    ...fee,
    raw: "999999",
    receiptMatched: false,
    attributionVerified: false,
    kind: "ignore",
  };
  const result = autoAccount([raw, unbacked], {
    [fee.id]: decision("commission"),
  });
  assert.equal(summarize(result).length, 0);
  assert.match(result.find((r) => r.feeEvent).manualBlocked, /真实到账/);
  const verified = autoAccount(reconciled(), {
    [fee.id]: decision("commission", other),
  });
  assert.equal(summarize(verified)[0].due, "100");
  assert.equal(summarize(verified)[0].trader, other);
});
test("orphan imported choices are discarded and direction is rechecked even for local choices", () => {
  const incoming = validateState(
    state([], { [raw.id]: decision("commission") }),
    { trustEvidence: false },
  );
  assert.deepEqual(incoming.decisions, {});
  const outgoing = { ...raw, direction: "out", from: own, to: trader };
  assert.equal(
    summarize(autoAccount([outgoing], { [raw.id]: decision("commission") }))
      .length,
    0,
  );
  assert.equal(
    summarize(autoAccount([raw], { [raw.id]: decision("refund") })).length,
    0,
  );
});
test("external progress cannot suppress history discovery but local progress remains usable", () => {
  const saved = state([raw], { [raw.id]: decision("commission") });
  const external = validateState(saved, { trustEvidence: false });
  assert.deepEqual(external.coverage["4663"].streams, {});
  assert.deepEqual(external.coverage["4663"].inspected, []);
  assert.equal(
    summarize(autoAccount(external.records, external.decisions)).length,
    0,
  );
  assert.equal(summarize(autoAccount([raw], external.decisions))[0].due, "100");
  assert.equal(
    validateState(saved).coverage["4663"].streams.transactions.highBlock,
    1000,
  );
});
test("missing canonical evidence or precision blocks both machine and manual amount booking", () => {
  for (const flag of [
    { canonicalMissing: true },
    { metadataError: "decimals unavailable" },
    { importedUnverified: true },
  ]) {
    const row = { ...fee, ...flag };
    const classified = autoAccount([row], { [fee.id]: decision("commission") });
    assert.equal(classified[0].kind, "pending");
    assert.equal(summarize(classified).length, 0);
  }
});
test("precision conflicts isolate the whole asset, keep unrelated balances and recover after correction", () => {
  const row2 = {
    ...fee,
    hash: secondHash,
    id: `4663:${secondHash}:fee:3`,
    decimals: 6,
  };
  const clean = {
    ...fee,
    asset: "0x" + "5".repeat(40),
    id: `4663:${hash}:fee:8`,
  };
  const model = createViewModel();
  const first = model([fee, row2, clean], {}, 0);
  assert.equal(first.groups.length, 1);
  assert.equal(first.groups[0].asset, clean.asset);
  assert.equal(first.conflicts.length, 1);
  assert.equal(first.pending.filter((r) => r.precisionConflict).length, 2);
  const next = model([fee, { ...row2, decimals: 18 }, clean], {}, 0);
  assert.equal(next.conflicts.length, 0);
  assert.equal(next.groups.length, 2);
});
test("minimum USD filter compares exact multi-chain totals at the boundary", () => {
  const base = {
    chain: "8453",
    asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    trader,
    decimals: 6,
    due: "700000",
    paid: "0",
    remaining: "700000",
    excess: "0",
    status: "unpaid",
  };
  const eth = {
    ...base,
    chain: "1",
    asset: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    due: "100000",
    remaining: "100000",
  };
  const valued = valueGroups([base, eth], {});
  assert.equal(addressTotals(valued).get("evm:" + trader).due, 0.8);
  assert.equal(filterMinimum(valued, "0.8").length, 2);
  assert.equal(filterMinimum(valued, "0.8000000000000000001").length, 0);
});
test("Arc native USDC and exact Robinhood USDG have offline fixed-price policy; unsupported assets report a reason", async () => {
  const assets = [
    { chain: "5042", asset: "native" },
    { chain: "4663", asset: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" },
  ];
  const result = await lookupPrices(assets, () => {
    throw Error("must not fetch");
  });
  assert.equal(Object.keys(result.prices).length, 2);
  assert.ok(
    Object.values(result.prices).every((p) => p.fixed && p.usd === "1"),
  );
  const unsupported = await lookupPrices(
    [{ chain: "4663", asset: "0x" + "6".repeat(40) }],
    () => {
      throw Error("no provider");
    },
  );
  assert.match(unsupported.errors[0], /报价源/);
  assert.deepEqual(unsupported.prices, {});
});
test("aggregate address search includes constituent transaction hashes", () => {
  const groups = summarize([fee]);
  assert.equal(matchesFilters(groups[0], { search: hash }, "ledger"), true);
  assert.equal(
    matchesFilters(groups[0], { search: secondHash }, "ledger"),
    false,
  );
});
test("transaction caches reuse unaffected classification and summary while cross-transaction refunds follow new evidence", () => {
  const out = {
    ...raw,
    hash: secondHash,
    id: `4663:${secondHash}:internal-transactions:1`,
    raw: "40",
    from: own,
    to: trader,
    direction: "out",
    paymentAuthorized: true,
    directTransfer: true,
    txSender: own,
  };
  const model = createViewModel();
  let view = model([out], {}, 0);
  assert.equal(view.pending.length, 1);
  view = model([out, fee], {}, 0);
  assert.equal(view.reclassifiedTransactions, 1);
  assert.equal(view.groups[0].paid, "40");
  view = model([out, { ...fee, raw: "110" }], {}, 0);
  assert.equal(view.reclassifiedTransactions, 1);
  assert.equal(view.summarizedTransactions, 1);
  assert.equal(view.groups[0].due, "110");
  assert.equal(view.groups[0].paid, "40");
  view = model([out], {}, 0);
  assert.equal(view.reclassifiedTransactions, 0);
  assert.equal(view.pending[0].id, out.id);
  assert.equal(view.groups.length, 0);
});

test("classification and incremental projection leave frozen raw records and manual decisions untouched", () => {
  const rows = reconciled();
  for (const row of rows) {
    if (row.supersededBy) Object.freeze(row.supersededBy);
    if (row.matchedReceiptIds) Object.freeze(row.matchedReceiptIds);
    Object.freeze(row);
  }
  Object.freeze(rows);
  const decisions = Object.freeze({
    [raw.id]: Object.freeze(decision("commission", other)),
  });
  const model = createViewModel();
  assert.equal(model(rows, decisions, 0).groups[0].trader, other);
  assert.equal(model([...rows], decisions, 0).reclassifiedTransactions, 0);
  assert.equal(rows[0].kind, "ignore");
  assert.deepEqual(rows[0].supersededBy, [fee.id]);
});
test("ordinary local histories above 100k records remain readable", () => {
  const rows = Array.from({ length: 100001 }, (_, i) => ({
    ...raw,
    id: `4663:${hash}:internal-transactions:${i}`,
  }));
  const restored = validateState(
    { ...state(rows), coverage: {} },
    { trustEvidence: true },
  );
  assert.equal(restored.records.length, 100001);
});

test("incremental view agrees with complete recomputation through additions, corrections, manual decisions and removals", () => {
  const model = createViewModel();
  let records = [],
    decisions = {};
  const comparable = (groups) =>
    groups
      .map((g) => ({
        ...g,
        ids: [...g.ids].sort(),
        hashes: [...g.hashes].sort(),
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  for (let i = 0; i < 24; i++) {
    const tx = "0x" + (i + 16).toString(16).padStart(64, "0");
    const income = {
      ...fee,
      hash: tx,
      id: `4663:${tx}:fee:1`,
      raw: String(100 + i),
      trader: i % 2 ? trader : other,
    };
    const payment = {
      ...raw,
      hash: tx,
      id: `4663:${tx}:transactions:2`,
      raw: "20",
      direction: "out",
      from: own,
      to: income.trader,
      paymentAuthorized: true,
      directTransfer: true,
      txSender: own,
    };
    records = [...records, income, payment];
    if (i % 3 === 0 && records.length > 2) records = records.slice(2);
    if (i % 4 === 0)
      decisions = { ...decisions, [income.id]: decision("ignore", "") };
    if (i % 5 === 0 && records.length)
      records = [{ ...records[0], raw: "333" }, ...records.slice(1)];
    const actual = model(records, decisions, 0),
      full = autoAccount(records, decisions);
    assert.deepEqual(comparable(actual.groups), comparable(summarize(full)));
    assert.deepEqual(
      [...actual.classified].sort((a, b) => a.id.localeCompare(b.id)),
      [...full].sort((a, b) => a.id.localeCompare(b.id)),
    );
    assert.deepEqual(
      actual.pending.map((r) => r.id).sort(),
      full
        .filter(
          (r) =>
            r.kind === "pending" && !r.spam && !r.supersededBy && r.raw !== "0",
        )
        .map((r) => r.id)
        .sort(),
    );
  }
});

test("incremental precision counts recover only after the last conflicting transaction is removed", () => {
  const model = createViewModel();
  const second = {
    ...fee,
    hash: secondHash,
    id: `4663:${secondHash}:fee:1`,
    decimals: 6,
  };
  const thirdHash = "0x" + "c".repeat(64);
  const third = {
    ...second,
    hash: thirdHash,
    id: `4663:${thirdHash}:fee:1`,
  };
  for (const rows of [
    [fee, second, third],
    [fee, third],
    [fee],
    [fee, second],
    [second],
    [],
  ]) {
    const view = model(rows, {}, 0);
    const conflicts = [];
    const groups = summarize(autoAccount(rows), conflicts);
    assert.deepEqual(view.groups, groups);
    assert.deepEqual(view.conflicts, conflicts);
    for (const row of view.classified) {
      const indexed = view.byTx.get(row.chain + ":" + row.hash);
      assert.equal(indexed.find((item) => item.id === row.id), row);
      assert.equal(!!row.precisionConflict, conflicts.length > 0);
    }
  }
});

test("cached incoming pending projections stay equivalent when another transaction changes relationships", () => {
  const model = createViewModel();
  const pendingHash = "0x" + "d".repeat(64);
  const pending = {
    ...raw,
    hash: pendingHash,
    id: `4663:${pendingHash}:internal-transactions:1`,
  };
  for (const rows of [[pending], [pending, fee], [pending], [pending, fee]]) {
    const view = model(rows, {}, 0);
    assert.deepEqual(view.classified, autoAccount(rows));
    assert.equal(view.pending[0].id, pending.id);
  }
});
