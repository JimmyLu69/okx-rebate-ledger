import { autoAccount, summarize, byAddress } from "./ledger.mjs";
import { valueGroups, addressTotals, filterMinimum } from "./valuation.mjs";

// Data changes invalidate classification. Filters and prices never rerun decoders.
export function createViewModel() {
  let previousRecords, previousDecisions, previousPolicy, result;
  return (records, decisions, policyVersion) => {
    if (
      records === previousRecords &&
      decisions === previousDecisions &&
      policyVersion === previousPolicy
    )
      return result;
    previousRecords = records;
    previousDecisions = decisions;
    previousPolicy = policyVersion;
    const start = performance.now();
    const classified = autoAccount(records, decisions);
    const byId = new Map(),
      byTx = new Map(),
      assets = new Map(),
      chains = new Set();
    const pending = [],
      spam = [],
      ignored = [];
    for (const row of classified) {
      byId.set(row.id, row);
      chains.add(row.chain);
      const key = row.chain + ":" + row.hash;
      if (!byTx.has(key)) byTx.set(key, []);
      byTx.get(key).push(row);
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
      groups: summarize(classified),
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
    )
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
