import {
  autoAccount,
  accountingContext,
  finalizeAccounting,
  summarize,
  byAddress,
  EVM,
  SOL,
} from "./ledger.mjs";
import { valueGroups, addressTotals, filterMinimum } from "./valuation.mjs";

function createIncrementalSummary() {
  const cache = new Map(),
    parts = new Map(),
    totals = new Map(),
    precisions = new Map(),
    conflictCounts = new Map();
  const trackPrecision = (groups, conflicts, delta) => {
    for (const group of groups) {
      const key = group.chain + ":" + group.asset;
      let counts = precisions.get(key);
      if (!counts) precisions.set(key, (counts = new Map()));
      const count = (counts.get(group.decimals) || 0) + delta;
      if (count) counts.set(group.decimals, count);
      else counts.delete(group.decimals);
      if (!counts.size) precisions.delete(key);
    }
    for (const { assetKey } of conflicts) {
      const count = (conflictCounts.get(assetKey) || 0) + delta;
      if (count) conflictCounts.set(assetKey, count);
      else conflictCounts.delete(assetKey);
    }
  };
  return (transactions) => {
    const dirty = new Set();
    let summarizedTransactions = 0;
    const remove = (key) => {
      const prior = cache.get(key);
      for (const g of prior?.groups || []) {
        parts.get(g.key)?.delete(key);
        dirty.add(g.key);
      }
      if (prior) trackPrecision(prior.groups, prior.conflicts, -1);
      cache.delete(key);
    };
    for (const key of cache.keys()) if (!transactions.has(key)) remove(key);
    for (const [key, rows] of transactions) {
      if (cache.get(key)?.rows === rows) continue;
      remove(key);
      const conflicts = [],
        groups = summarize(rows, conflicts);
      cache.set(key, { rows, groups, conflicts });
      trackPrecision(groups, conflicts, 1);
      summarizedTransactions++;
      for (const g of groups) {
        if (!parts.has(g.key)) parts.set(g.key, new Map());
        parts.get(g.key).set(key, g);
        dirty.add(g.key);
      }
    }
    for (const key of dirty) {
      const pieces = [...(parts.get(key)?.values() || [])];
      if (!pieces.length) {
        parts.delete(key);
        totals.delete(key);
        continue;
      }
      let due = 0n,
        paid = 0n;
      const ids = [],
        hashes = new Set();
      for (const g of pieces) {
        due += BigInt(g.due);
        paid += BigInt(g.paid);
        for (const id of g.ids) ids.push(id);
        for (const hash of g.hashes) hashes.add(hash);
      }
      const net = due - paid;
      totals.set(key, {
        ...pieces[0],
        due: String(due),
        paid: String(paid),
        ids,
        hashes: [...hashes],
        remaining: String(net > 0n ? net : 0n),
        excess: String(net < 0n ? -net : 0n),
        status:
          net > 0n
            ? paid === 0n
              ? "unpaid"
              : "partial"
            : net < 0n
              ? "over"
              : "settled",
      });
    }
    const invalid = new Set(conflictCounts.keys());
    for (const [key, counts] of precisions)
      if (counts.size > 1) invalid.add(key);
    return {
      groups: [...totals.values()].filter(
        (g) => !invalid.has(g.chain + ":" + g.asset),
      ),
      conflicts: [...invalid].map((assetKey) => ({
        assetKey,
        reason: "同一代币存在精度冲突，已暂停此资产计账",
      })),
      summarizedTransactions,
    };
  };
}
// Data changes invalidate classification. Filters and prices never rerun decoders.
export function createViewModel() {
  let previousRecords,
    previousDecisions,
    previousPolicy,
    result,
    previousWallets;
  const transactionCache = new Map(),
    updateSummary = createIncrementalSummary();
  let previousRelationships = new Set();
  return (records, decisions, policyVersion) => {
    if (
      records === previousRecords &&
      decisions === previousDecisions &&
      policyVersion === previousPolicy &&
      previousWallets === EVM + ":" + SOL
    )
      return result;
    const start = performance.now(),
      wallets = EVM + ":" + SOL;
    if (previousPolicy !== policyVersion || previousWallets !== wallets)
      transactionCache.clear();
    previousRecords = records;
    previousDecisions = decisions;
    previousPolicy = policyVersion;
    previousWallets = wallets;
    const transactions = new Map();
    for (const record of records) {
      const key = record.chain + ":" + record.hash;
      if (!transactions.has(key)) transactions.set(key, []);
      transactions.get(key).push(record);
    }
    const firstPass = [];
    let reclassifiedTransactions = 0;
    for (const [key, rows] of transactions) {
      const cached = transactionCache.get(key);
      if (
        cached &&
        cached.rows.length === rows.length &&
        rows.every(
          (r, i) =>
            r === cached.rows[i] &&
            decisions?.[r.id] === cached.choices?.[i],
        )
      )
        for (const row of cached.classified) firstPass.push(row);
      else {
        const classified = autoAccount(rows, decisions, {
          phase: "commission",
        });
        const choices = rows.some((r) => decisions?.[r.id])
          ? rows.map((r) => decisions?.[r.id])
          : undefined;
        transactionCache.set(key, {
          rows,
          choices,
          classified,
          contextDependent: rows.some((r) => r.direction === "out"),
        });
        for (const row of classified) firstPass.push(row);
        reclassifiedTransactions++;
      }
    }
    for (const key of transactionCache.keys())
      if (!transactions.has(key)) transactionCache.delete(key);
    const context = accountingContext(firstPass);
    const relationshipsChanged =
      previousRelationships.size !== context.relationships.size ||
      [...previousRelationships].some((key) => !context.relationships.has(key));
    previousRelationships = context.relationships;
    const finalizedByTx = new Map();
    let classified = [];
    for (const [key, item] of transactionCache) {
      if (
        !item.finalized ||
        (relationshipsChanged && item.contextDependent)
      ) {
        item.finalized = item.classified.some((r) => r.kind === "pending")
          ? finalizeAccounting(item.classified, context)
          : item.classified;
        // Only outgoing records can depend on a different transaction's
        // commission relationships. Incoming projections need no second copy.
        if (!item.contextDependent) item.classified = item.finalized;
      }
      finalizedByTx.set(key, item.finalized);
      for (const row of item.finalized) classified.push(row);
    }
    const { groups, conflicts, summarizedTransactions } =
      updateSummary(finalizedByTx);
    const invalid = new Set(conflicts.map((c) => c.assetKey));
    if (invalid.size)
      classified = classified.map((row) =>
        invalid.has(row.chain + ":" + row.asset) && !row.supersededBy
          ? {
              ...row,
              kind: "pending",
              needsReview: true,
              precisionConflict: true,
              manualBlocked: "同一代币精度冲突，须核验后计账",
              reviewReason: "同一代币精度冲突，已暂停此资产计账",
            }
          : row,
      );
    const byId = new Map(),
      byTx = invalid.size ? new Map() : finalizedByTx,
      assets = new Map(),
      chains = new Set();
    const pending = [],
      spam = [],
      ignored = [];
    for (const row of classified) {
      byId.set(row.id, row);
      chains.add(row.chain);
      if (invalid.size) {
        const key = row.chain + ":" + row.hash;
        if (!byTx.has(key)) byTx.set(key, []);
        byTx.get(key).push(row);
      }
      if (!row.supersededBy && row.raw !== "0") {
        assets.set(row.chain + ":" + row.asset, row);
        if (row.spam) spam.push(row);
        else if (row.kind === "pending") pending.push(row);
        else if (row.kind === "ignore") ignored.push(row);
      }
    }
    result = {
      classified,
      pending,
      spam,
      ignored,
      groups,
      conflicts,
      reclassifiedTransactions,
      summarizedTransactions,
      byId,
      byTx,
      assets,
      chains,
      ms: performance.now() - start,
    };
    return result;
  };
}
export function matchesFilters(row, filters, view) {
  const accepts = (name, value) =>
    !filters[name]?.size || filters[name].has(value);
  const rawView = ["review", "spam", "ignored"].includes(view);
  if (rawView && !accepts("direction", row.direction)) return false;
  if (
    !accepts("chains", row.chain) ||
    !accepts("tokens", row.chain + ":" + row.asset) ||
    !accepts("types", row.asset === "native" ? "native" : "token")
  )
    return false;
  const q = filters.search?.trim().toLowerCase();
  return (
    !q ||
    [row.trader, row.from, row.to, row.hash, row.symbol, row.asset].some(
      (s) => typeof s === "string" && s.toLowerCase().includes(q),
    ) ||
    row.hashes?.some(
      (hash) => typeof hash === "string" && hash.toLowerCase().includes(q),
    ) ||
    false
  );
}
export function visibleGroups(groups, filters) {
  const filtered = groups
    .filter((g) => matchesFilters(g, filters, "ledger"))
    .filter(
      (g) =>
        !filters.statuses?.size ||
        filters.statuses.has(g.status) ||
        (filters.statuses.has("outstanding") &&
          ["unpaid", "partial"].includes(g.status)),
    );
  return filterMinimum(filtered, filters.minimum, filters.minimumField);
}
export function sortAddresses(groups, sort = "remaining") {
  const totals = addressTotals(groups);
  const items = byAddress(groups);
  const key = (a) =>
    (a.assets[0]?.chain === "solana" ? "sol:" : "evm:") + a.address;
  items.sort((a, b) =>
    sort === "address"
      ? a.address.localeCompare(b.address)
      : (totals.get(key(b))?.[sort] || 0) - (totals.get(key(a))?.[sort] || 0) ||
        a.address.localeCompare(b.address),
  );
  return { items, totals };
}
export function pageItems(items, page, size = 25) {
  const max = Math.max(1, Math.ceil(items.length / size));
  const current = Math.max(1, Math.min(page, max));
  return {
    items: items.slice((current - 1) * size, current * size),
    total: items.length,
    page: current,
    max,
  };
}
export function coverageSummary(selected, coverage, chainBy, keys, wallets) {
  return selected.map((id) => {
    const chain = chainBy(id),
      provider = id === "solana" ? "helius" : chain.provider || "blockscout";
    const enabled = !!(id === "solana"
      ? wallets.sol && keys.helius
      : wallets.evm && keys[provider]);
    return {
      chain,
      enabled,
      coverage: coverage[id] || {},
      status: !enabled ? "missing" : coverage[id]?.status || "idle",
    };
  });
}
