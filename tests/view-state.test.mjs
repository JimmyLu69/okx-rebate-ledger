import "./fixtures.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { seed } from "./fixtures.mjs";
import {
  createViewModel,
  pageItems,
  visibleGroups,
  coverageSummary,
} from "../dist/view-model.mjs";
import { createSaver } from "../dist/persistence.mjs";
import { RecordIndex } from "../dist/sync-controller.mjs";
import { valueGroups, addressTotals } from "../dist/valuation.mjs";

test("classification cache survives filtering and invalidates on data, judgment or policy changes", () => {
  const derive = createViewModel(),
    rows = [{ ...seed }],
    decisions = {};
  const first = derive(rows, decisions, 1);
  assert.equal(derive(rows, decisions, 1), first);
  visibleGroups(first.groups, { search: "absent" });
  assert.equal(derive(rows, decisions, 1), first);
  assert.notEqual(derive([...rows], decisions, 1), first);
  const second = derive(rows, decisions, 1);
  assert.notEqual(derive(rows, {}, 1), second);
  assert.notEqual(derive(rows, decisions, 2), second);
});

test("pagination bounds HTML work after filters shrink the dataset", () => {
  const rows = Array.from({ length: 100000 }, (_, i) => i);
  assert.deepEqual(pageItems(rows, 2).items, rows.slice(25, 50));
  assert.equal(pageItems(rows, 100000).items.length, 25);
  assert.deepEqual(pageItems([], 9), { items: [], total: 0, page: 1, max: 1 });
});

test("transaction replacement deletes old fee rows but rejects mismatched results atomically", () => {
  const old = { ...seed, id: "old" },
    fee = { ...seed, id: "fee" },
    other = { ...seed, id: "other", hash: "another" };
  const index = new RecordIndex([old, fee, other]);
  assert.throws(() => index.replace(seed.chain, seed.hash, [other]), /不匹配/);
  assert.equal(index.values().length, 3);
  index.replace(seed.chain, seed.hash, [{ ...seed, id: "fresh" }]);
  assert.deepEqual(
    index
      .values()
      .map((r) => r.id)
      .sort(),
    ["fresh", "other"],
  );
  index.merge([{ ...other, hash: "moved" }]);
  assert.deepEqual(index.transaction(seed.chain, "another"), []);
  index.replace(seed.chain, "another", []);
  assert.equal(index.transaction(seed.chain, "moved").length, 1);
});

test("settlement tolerance leaves exact amounts intact and removes both actionable totals", () => {
  const groups = [
    {
      chain: "1",
      asset: "native",
      trader: "alice",
      decimals: 6,
      due: "1000000",
      paid: "990000",
      remaining: "10000",
      excess: "0",
      status: "partial",
    },
    {
      chain: "1",
      asset: "other",
      trader: "alice",
      decimals: 6,
      due: "1000000",
      paid: "1010000",
      remaining: "0",
      excess: "10000",
      status: "over",
    },
  ];
  const quote = { usd: "1", at: Date.now() },
    valued = valueGroups(groups, { "1:native": quote, "1:other": quote });
  assert.equal(valued[0].remaining, "10000");
  assert.equal(valued[1].excess, "10000");
  assert(valued.every((g) => g.status === "settled"));
  assert.deepEqual(addressTotals(valued).get("evm:alice"), {
    due: 2,
    paid: 2,
    remaining: 0,
    excess: 0,
    missing: 0,
  });
});

test("coverage uses the selected networks and treats missing credentials distinctly", () => {
  const report = coverageSummary(
    ["solana", "8453"],
    { 8453: { status: "complete" } },
    (id) => ({ id }),
    { blockscout: "fake" },
    { evm: "fake", sol: "fake" },
  );
  assert.equal(report.length, 2);
  assert.equal(report[0].status, "missing");
  assert.equal(report[1].status, "complete");
});

test("checkpoint saver serializes writes and coalesces pending snapshots", async () => {
  let release,
    started,
    active = 0,
    peak = 0;
  const writes = [];
  const begun = new Promise((resolve) => (started = resolve)),
    gate = new Promise((resolve) => (release = resolve));
  const saver = createSaver(async (key, value) => {
    active++;
    peak = Math.max(peak, active);
    writes.push([key, value]);
    if (value === 1) {
      started();
      await gate;
    }
    active--;
  }, 10000);
  saver.queue("wallet", () => 1);
  const pending = saver.flush();
  await begun;
  saver.queue("wallet", () => 2);
  saver.queue("wallet", () => 3);
  release();
  await pending;
  assert.equal(peak, 1);
  assert.deepEqual(writes, [
    ["wallet", 1],
    ["wallet", 3],
  ]);
  assert.equal(saver.pending, 0);
});
