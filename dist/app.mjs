import {
  revokedAsset,
  upgradeAllowlist,
  normalizeAllowlist,
  parseAllowlist,
  formatAllowlist,
  configureAssetAllowlist,
} from "./allowlist.mjs";
import {
  RECHECK_REVISION,
  planRecheck,
  recheckOutcome,
  pendingCounts,
} from "./recheck.mjs";
import { readHistory, writeHistory, storageDiagnostics } from "./storage.mjs";
import {
  EVM,
  SOL,
  configureWallets,
  format,
  validAddress,
  decisionsFromLegacy,
} from "./ledger.mjs";
import { lookupPrices } from "./prices.mjs";
import { valueGroups, addressTotals } from "./valuation.mjs";
import {
  COMMON_CHAINS,
  EXTRA_CHAINS,
  providerFor,
  credentialFields,
  emptyKeys,
} from "./catalog.mjs";
import {
  createViewModel,
  matchesFilters,
  visibleGroups,
  sortAddresses,
  pageItems,
  coverageSummary,
} from "./view-model.mjs";
import { createSaver } from "./persistence.mjs";
import { runSync, RecordIndex } from "./sync-controller.mjs";
import {
  validateState,
  validateRecord,
  validateRecheckReport,
} from "./validation.mjs";
import { encodeCsv } from "./csv.mjs";
import { networkDiagnostics } from "./network.mjs";

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const short = (value) =>
  value?.length > 20 ? value.slice(0, 8) + "…" + value.slice(-6) : value || "—";
const usd = (value) =>
  Number.isFinite(Number(value))
    ? Number(value).toLocaleString("en-US", { maximumFractionDigits: 4 }) +
      " USD"
    : "—";
const quantity = (raw, decimals) => {
  const full = format(raw, decimals);
  return full.length > 19
    ? Number(full).toLocaleString("en-US", { maximumSignificantDigits: 10 })
    : full;
};
const emptyState = () => ({
  version: 1,
  records: [],
  decisions: {},
  selected: [...COMMON_CHAINS],
  coverage: {},
  updated: null,
  decoderVersion: 4,
});
const safeRead = (store, key, fallback) => {
  try {
    return JSON.parse(store.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
};
const [catalog, routers, defaultAllowlist] = await Promise.all(
  ["chains.json", "routers.json", "asset-allowlist.json"].map((f) =>
    fetch(new URL("./" + f, import.meta.url)).then((r) => {
      if (!r.ok) throw Error("无法载入应用资源，请联网刷新");
      return r.json();
    }),
  ),
);
const chains = [...catalog, ...EXTRA_CHAINS].map((c) => ({
  ...c,
  name: c.name.trim(),
}));
const chainMap = new Map(chains.map((c) => [c.id, c]));
const chainBy = (id) => chainMap.get(id) || { id, name: id, explorer: "" };
let state = emptyState(),
  busy = false,
  controller,
  view = "ledger",
  page = 1,
  reportPage = 1,
  progress = "",
  storageWarn = "";
let policyVersion = 0,
  prices = {},
  priceBusy = false,
  renderTimer,
  activeRecordIds = [],
  settingsDraft = [],
  importCandidate,
  importWallet;
let scanOptions = safeRead(localStorage, "rebate-scan-options-v1", {});
let preferences = {
  enabled: true,
  threshold: "0.1",
  ...safeRead(localStorage, "rebate-preferences-v1", {}),
};
let credentialMode = localStorage.getItem("rebate-credential-mode") || "local";
let keys = {
  ...emptyKeys(),
  ...safeRead(
    credentialMode === "session" ? sessionStorage : localStorage,
    "rebate-credentials-v1",
    {},
  ),
};
const wallets = safeRead(localStorage, "rebate-wallets-v1", {
  evm: "",
  sol: "",
});
try {
  configureWallets(wallets.evm, wallets.sol);
} catch {
  configureWallets("", "");
  storageWarn = "钱包设置无法读取，请重新设置";
}
const walletStorage = () => `rebate-ledger-wallet:${EVM}:${SOL}`;
let assetAllowlist;
try {
  const policy = upgradeAllowlist(
    safeRead(
      localStorage,
      "rebate-asset-allowlist-v2",
      safeRead(localStorage, "rebate-asset-allowlist-v1", null),
    ),
    defaultAllowlist,
  );
  assetAllowlist = policy.assets;
  localStorage.setItem("rebate-asset-allowlist-v2", JSON.stringify(policy));
} catch {
  assetAllowlist = normalizeAllowlist(defaultAllowlist);
  storageWarn = "合约名单读取失败，已载入内置名单";
}
configureAssetAllowlist(assetAllowlist);
try {
  const saved =
    (await readHistory(walletStorage())) ||
    safeRead(localStorage, walletStorage(), null) ||
    safeRead(localStorage, "rebate-ledger-v1", null);
  if (saved)
    state = validateState(saved, {
      trustEvidence: true,
      wallets: { evm: EVM, sol: SOL },
    });
} catch {
  storageWarn = "本机历史读取失败，请从备份恢复。原数据未删除。";
}
function migrateState(target = state) {
  target.decisions = {
    ...decisionsFromLegacy(target.records),
    ...target.decisions,
  };
  if (target.decoderVersion !== 4) {
    // Only conclusions lacking current proof become pending. Cursor history is retained.
    target.decoderVersion = 4;
    target.migrationPending = true;
    for (const coverage of Object.values(target.coverage))
      coverage.inspected = [];
    return true;
  }
  return false;
}
const migrated = migrateState();
const derive = createViewModel();
const model = () => derive(state.records, state.decisions, policyVersion);
const saver = createSaver(async (key, snapshot) => {
  try {
    await writeHistory(key, snapshot);
    storageWarn = "";
  } catch (error) {
    storageWarn = "历史保存失败，请立即导出备份";
    toast(storageWarn);
    throw error;
  }
});
function save(flush = false) {
  const owner = state;
  saver.queue(walletStorage(), () => owner);
  return flush ? saver.flush() : Promise.resolve();
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").style.display = "block";
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("toast").style.display = "none"), 6000);
}
function scheduleRender() {
  if (document.hidden) return;
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 100);
}
function setProgress(text) {
  progress = text;
  $("notice").textContent = text;
}
function selectedValues(id) {
  return [...$(id).selectedOptions]
    .map((o) => o.value)
    .filter((v) => v !== "all");
}
function filters() {
  return {
    search: $("search").value,
    chains: new Set(selectedValues("chainFilter")),
    statuses: new Set(selectedValues("statusFilter")),
    direction: new Set(selectedValues("directionFilter")),
    tokens: new Set(selectedValues("tokenFilter")),
    types: new Set(selectedValues("assetFilter")),
    minimum: $("minimumUsd").value,
    minimumField: $("minimumField").value,
  };
}
const statusText = {
  unpaid: "未返还",
  partial: "返还不足",
  settled: "已结清",
  over: "超额返还",
};
const rawViews = new Set(["review", "spam", "ignored"]);
const badge = (g) =>
  `<span class="pill ${g.status === "over" ? "red" : g.status === "settled" ? "" : "amber"}">${g.withinTolerance ? "小额差额已忽略" : statusText[g.status] || esc(g.status)}</span>`;
const link = (r) => {
  const explorer = chainBy(r.chain).explorer;
  return explorer
    ? `${explorer.replace(/\/$/, "")}/tx/${encodeURIComponent(r.hash)}`
    : "";
};
const nowGroups = () => valueGroups(model().groups, prices, preferences);
const filteredGroups = () => visibleGroups(nowGroups(), filters());
const currency = (r) =>
  `<div class="currency">${esc(r.symbol)}<span class="cellsub">${esc(chainBy(r.chain).name)} · ${r.asset === "native" ? "原生币" : esc(short(r.asset))}</span></div>`;
let filterSignature = "",
  restoredFilters = safeRead(localStorage, "rebate-filters-v2", null);
function syncFilterOptions() {
  const data = model(),
    signature =
      [...new Set([...COMMON_CHAINS, ...state.selected, ...data.chains])].join(
        ",",
      ) +
      "|" +
      [...data.assets.keys()].sort().join(",");
  if (signature === filterSignature) return;
  filterSignature = signature;
  const oldChain = selectedValues("chainFilter"),
    oldToken = selectedValues("tokenFilter");
  $("chainFilter").innerHTML = [
    ...new Set([...COMMON_CHAINS, ...state.selected, ...data.chains]),
  ]
    .filter((id) => chainMap.has(id))
    .map((id) => `<option value="${esc(id)}">${esc(chainBy(id).name)}</option>`)
    .join("");
  $("tokenFilter").innerHTML = [...data.assets]
    .sort((a, b) => a[1].symbol.localeCompare(b[1].symbol))
    .map(
      ([key, row]) =>
        `<option value="${esc(key)}">${esc(row.symbol)} · ${esc(chainBy(row.chain).name)} · ${esc(short(row.asset))}</option>`,
    )
    .join("");
  for (const [id, chosen] of [
    ["chainFilter", oldChain],
    ["tokenFilter", oldToken],
  ])
    for (const option of $(id).options)
      option.selected = chosen.includes(option.value);
  if (restoredFilters) {
    for (const id of [
      "chainFilter",
      "tokenFilter",
      "statusFilter",
      "directionFilter",
      "assetFilter",
    ])
      for (const o of $(id).options)
        o.selected = restoredFilters[id]?.includes(o.value) || false;
    for (const id of ["search", "minimumUsd", "minimumField", "sortBy"])
      if (typeof restoredFilters[id] === "string")
        $(id).value = restoredFilters[id];
    restoredFilters = null;
  }
}
function drawFilterMenus() {
  for (const menu of document.querySelectorAll("[data-filter]")) {
    const select = $(menu.dataset.filter),
      body = menu.querySelector(".checkmenu");
    const signature = [...select.options]
      .map((o) => o.value + o.text)
      .join("|");
    if (body.dataset.signature !== signature) {
      body.innerHTML = [...select.options]
        .map(
          (o) =>
            `<label><input type="checkbox" value="${esc(o.value)}"><span>${esc(o.text)}</span></label>`,
        )
        .join("");
      body.dataset.signature = signature;
    }
    const chosen = new Set(selectedValues(select.id)),
      q = menu.querySelector(".optionsearch")?.value.toLowerCase() || "";
    for (const input of body.querySelectorAll("input")) {
      input.checked = chosen.has(input.value);
      input.closest("label").hidden = !input
        .closest("label")
        .textContent.toLowerCase()
        .includes(q);
    }
    menu.querySelector(".filtercount").textContent = chosen.size || "";
    menu.classList.toggle("has-selection", chosen.size > 0);
    menu.hidden =
      (select.id === "directionFilter" && !rawViews.has(view)) ||
      (select.id === "statusFilter" && rawViews.has(view));
  }
}
function persistFilters() {
  try {
    localStorage.setItem(
      "rebate-filters-v2",
      JSON.stringify(
        Object.fromEntries(
          [
            "chainFilter",
            "statusFilter",
            "directionFilter",
            "tokenFilter",
            "assetFilter",
          ]
            .map((id) => [id, selectedValues(id)])
            .concat(
              ["search", "minimumUsd", "minimumField", "sortBy"].map((id) => [
                id,
                $(id).value,
              ]),
            ),
        ),
      ),
    );
  } catch {}
}
function coverage() {
  return coverageSummary(state.selected, state.coverage, chainBy, keys, {
    evm: EVM,
    sol: SOL,
  });
}
const expandedAddresses = new Set();
function render() {
  const started = performance.now();
  syncFilterOptions();
  drawFilterMenus();
  const currentFilters = filters(),
    data = model(),
    allGroups = nowGroups(),
    groups = visibleGroups(allGroups, currentFilters);
  const outstanding = groups.filter((g) =>
      ["unpaid", "partial"].includes(g.status),
    ),
    missing = outstanding.filter((g) => !g.priced).length;
  const amount = outstanding.reduce(
      (sum, g) => sum + (g.usdActionable || 0),
      0,
    ),
    hasPrice = outstanding.some((g) => g.priced);
  $("heroAmount").textContent =
    !state.records.length || (missing && !hasPrice)
      ? "—"
      : (missing ? "≥ " : "") +
        amount.toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 4,
        });
  $("heroDetail").textContent = missing
    ? `${missing} 项缺少报价，未计入总额`
    : state.records.length
      ? "按当前筛选与结清阈值计算 · 稳定币固定 1 USD"
      : "先设置收款钱包与数据源";
  const cov = coverage(),
    done = cov.filter((c) => c.status === "complete").length;
  $("metrics").innerHTML =
    `<div><p>需返还地址</p><strong>${new Set(outstanding.map((g) => (g.chain === "solana" ? "sol:" : "evm:") + g.trader)).size}</strong></div><div><p>待核对</p><strong>${data.pending.length}</strong></div>`;
  $("reviewCount").textContent = data.pending.length;
  $("notice").textContent =
    storageWarn ||
    (busy
      ? progress
      : !state.records.length
        ? "尚未同步"
        : `已完成 ${done}/${cov.length} 个所选网络${cov.some((c) => c.status === "missing") ? " · 有网络缺少凭证" : ""}`);
  $("updated").textContent = state.updated
    ? "更新于 " + new Date(state.updated).toLocaleString("zh-CN")
    : "";
  $("syncButton").textContent = busy
    ? "暂停"
    : !state.records.length
      ? "开始同步"
      : cov.some((c) => ["paused", "error", "running"].includes(c.status))
        ? "继续未完成"
        : "同步新增";
  for (const id of [
    "setupButton",
    "retryButton",
    "recheckPending",
    "auditConfirmed",
  ])
    $(id).disabled = busy;
  $("recheckPending").hidden = !rawViews.has(view) || view === "ignored";
  $("recheckResults").hidden = !state.lastRecheck;
  $("sortBy").hidden = view !== "ledger";
  $("ledgerView").hidden = rawViews.has(view);
  $("reviewView").hidden = !rawViews.has(view);
  $("minimumControl").hidden = $("minimumField").hidden = rawViews.has(view);
  $("ledgerTab").classList.toggle("active", !rawViews.has(view));
  $("reviewTab").classList.toggle("active", rawViews.has(view));
  $("ledgerTab").setAttribute("aria-selected", String(!rawViews.has(view)));
  $("reviewTab").setAttribute("aria-selected", String(rawViews.has(view)));
  $("tableArea").setAttribute(
    "aria-labelledby",
    rawViews.has(view) ? "reviewTab" : "ledgerTab",
  );
  const chosen = [
    "chainFilter",
    "statusFilter",
    "directionFilter",
    "tokenFilter",
    "assetFilter",
  ].reduce((n, id) => n + selectedValues(id).length, 0);
  $("filterSummary").textContent =
    chosen || $("search").value || Number($("minimumUsd").value)
      ? `已应用筛选 · 汇总仅含当前范围${Number($("minimumUsd").value) ? " · 缺报价地址保留" : ""}`
      : "全部记录";
  $("evmDisplay").textContent = EVM || "未设置";
  $("solDisplay").textContent = SOL || "未设置";
  $("migrationNote").hidden = !(
    state.migrationPending ||
    data.pending.some((r) => r.needsProof || r.importedUnverified)
  );
  $("migrationNote").textContent =
    "已更新归属规则。旧结论缺少凭证的记录已回到待核对，核验后重建；历史扫描进度保留。";
  let items, headers, renderRow;
  if (view === "ledger") {
    const result = sortAddresses(groups, $("sortBy").value);
    items = result.items;
    headers = ["币种", "应返总额", "已返总额", "实际差额", "状态", ""];
    renderRow = (address) => {
      const key =
          (address.assets[0].chain === "solana" ? "sol:" : "evm:") +
          address.address,
        t = result.totals.get(key);
      const head = `<tr class="addresshead"><td colspan="6"><div class="addressbar"><button class="addresscopy mono" data-copy="${esc(address.address)}" title="复制完整地址">${esc(short(address.address))} ⧉</button><div class="addresssummary"><span>应返<b>${usd(t.due)}</b></span><span>已返<b>${usd(t.paid)}</b></span><span>需处理<b class="amount">${usd(t.remaining)}</b></span>${t.excess ? `<span>超返<b>${usd(t.excess)}</b></span>` : ""}${t.missing ? "<span>部分资产缺价</span>" : ""}</div></div></td></tr>`;
      const assets = expandedAddresses.has(key)
        ? address.assets
        : address.assets.slice(0, 5);
      return (
        head +
        assets
          .map((g) => {
            const net = BigInt(g.due) - BigInt(g.paid),
              amountCell = (raw, quote) =>
                `<span class="quantity" title="${esc(format(raw, g.decimals))}">${esc(quantity(raw, g.decimals))}</span><span class="cellsub">${g.priced ? usd(quote) : "缺少报价"}</span>`;
            return `<tr><td>${currency(g)}</td><td class="num">${amountCell(g.due, g.usdDue)}</td><td class="num">${amountCell(g.paid, g.usdPaid)}</td><td class="num ${net < 0n ? "warning" : "amount"}">${amountCell(net, (g.usdDue || 0) - (g.usdPaid || 0))}<span class="cellsub">${net < 0n ? "负数：超返" : net > 0n ? "正数：待返" : "精确结清"}</span></td><td>${badge(g)}</td><td><button class="rowaction" data-group="${esc(g.key)}">明细</button></td></tr>`;
          })
          .join("") +
        (address.assets.length > 5
          ? `<tr class="assetfold"><td colspan="6"><button class="textbutton" data-expand="${esc(key)}">${expandedAddresses.has(key) ? "收起" : "查看全部 " + address.assets.length + " 项资产"}</button></td></tr>`
          : "")
      );
    };
  } else if (view === "assets") {
    const assets = new Map();
    for (const g of groups) {
      const key = g.chain + ":" + g.asset;
      if (!assets.has(key))
        assets.set(key, {
          ...g,
          due: 0n,
          paid: 0n,
          actionable: 0,
          excessValue: 0,
          addresses: new Set(),
        });
      const a = assets.get(key);
      a.due += BigInt(g.due);
      a.paid += BigInt(g.paid);
      a.actionable += g.usdActionable || 0;
      a.excessValue += g.usdActionableExcess || 0;
      a.addresses.add(g.trader);
    }
    items = [...assets.values()].sort((a, b) => b.actionable - a.actionable);
    headers = [
      "网络 / 币种",
      "地址数",
      "应返总额",
      "已返总额",
      "需处理 USD",
      "超返 USD",
    ];
    renderRow = (a) =>
      `<tr><td>${currency(a)}</td><td class="num">${a.addresses.size}</td><td class="num">${esc(quantity(a.due, a.decimals))}</td><td class="num">${esc(quantity(a.paid, a.decimals))}</td><td class="num">${a.priced ? usd(a.actionable) : "缺少报价"}</td><td class="num">${a.priced ? usd(a.excessValue) : "缺少报价"}</td></tr>`;
  } else {
    items = (
      view === "spam"
        ? data.spam
        : view === "ignored"
          ? data.ignored
          : data.pending
    )
      .filter((r) => matchesFilters(r, currentFilters, view))
      .sort((a, b) => (b.time || "").localeCompare(a.time || ""));
    headers = ["时间 / 币种", "方向", "金额", "日志来源 / 去向", "原因", ""];
    renderRow = (r) =>
      `<tr><td>${currency(r)}<span class="cellsub">${r.time ? esc(new Date(r.time).toLocaleString("zh-CN")) : "时间未知"}</span></td><td>${r.direction === "in" ? "转入" : "转出"}</td><td class="num">${esc(quantity(r.raw, r.decimals))}</td><td><button class="addresscopy mono" data-copy="${esc(r.direction === "in" ? r.from : r.to)}">${esc(short(r.direction === "in" ? r.from : r.to))}</button><span class="cellsub">${r.direction === "in" ? "资金来源，不代表归属人" : "日志接收地址"}</span></td><td class="reviewreason">${esc(r.spamReason || r.reviewReason || r.exclusionReason || r.evidence || "需要补充归属证明")}</td><td><button class="rowaction" data-record="${esc(r.id)}">核对</button></td></tr>`;
  }
  const paged = pageItems(items, page);
  page = paged.page;
  $("tableArea").dataset.view = view;
  $("tableArea").innerHTML =
    `<table><thead><tr>${headers.map((h, i) => `<th scope="col"${[2, 3, 4].includes(i) ? ' class="num"' : ""}>${esc(h)}</th>`).join("")}</tr></thead><tbody>${paged.items.map(renderRow).join("") || `<tr><td class="empty" colspan="${headers.length}"><h3>${state.records.length ? "当前范围没有记录" : "还没有账目"}</h3><p>${state.records.length ? "调整筛选查看其他记录。" : "设置钱包和数据源后开始同步，或导入历史备份。"}</p></td></tr>`}</tbody></table>`;
  for (const tr of $("tableArea").querySelectorAll(
    "tr:not(.addresshead):not(.assetfold)",
  ))
    for (const [i, td] of [...tr.cells].entries())
      td.dataset.label = headers[i] || "";
  $("rowCount").textContent =
    `${paged.total} ${view === "ledger" ? "个地址" : view === "assets" ? "项资产" : "条记录"}`;
  $("pageNum").textContent = `${page} / ${paged.max}`;
  $("prev").disabled = page <= 1;
  $("next").disabled = page >= paged.max;
  render.lastMs = performance.now() - started;
}

async function refreshPrices(force = false) {
  if (priceBusy || (document.hidden && !force)) return;
  const assets = [
    ...new Map(
      model().groups.map((g) => [
        g.chain + ":" + g.asset,
        { chain: g.chain, asset: g.asset },
      ]),
    ).values(),
  ];
  if (!assets.length) {
    $("priceStatus").textContent = "";
    return;
  }
  priceBusy = true;
  $("priceStatus").textContent = "更新报价中";
  const walletKey = walletStorage();
  const fetchPrices = async () => {
    const stored = safeRead(localStorage, "rebate-price-cache-v2", {});
    const recent = Object.fromEntries(
      Object.entries(stored).filter(
        ([, p]) => p && Number(p.usd) > 0 && Date.now() - p.at < 5 * 60e3,
      ),
    );
    prices = { ...prices, ...recent };
    const missing = assets.filter(
      (a) => force || !recent[a.chain + ":" + a.asset],
    );
    let failed = false;
    for (let i = 0; i < missing.length; i += 30) {
      const batch = missing.slice(i, i + 30),
        data = await lookupPrices(batch);
      if (walletStorage() !== walletKey) return;
      prices = { ...prices, ...data.prices };
      const unresolved = batch.filter(
        (a) => !data.prices[a.chain + ":" + a.asset],
      );
      if (unresolved.length) {
        try {
          const response = await fetch("/api/prices", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ assets: unresolved }),
            signal: AbortSignal.timeout(20000),
          });
          if (!response.ok) throw Error();
          const fallback = await response.json();
          prices = { ...prices, ...fallback.prices };
          failed ||= !!fallback.errors?.length;
        } catch {
          failed = true;
        }
      }
    }
    const bounded = Object.fromEntries(
      Object.entries(prices)
        .filter(([, p]) => Date.now() - p.at < 15 * 60e3)
        .slice(-1000),
    );
    try {
      localStorage.setItem("rebate-price-cache-v2", JSON.stringify(bounded));
    } catch {}
    $("priceStatus").textContent = failed
      ? "部分资产缺价"
      : "报价 " + new Date().toLocaleTimeString("zh-CN");
  };
  try {
    if (navigator.locks)
      await navigator.locks.request("rebate-price-refresh", fetchPrices);
    else await fetchPrices();
  } catch {
    $("priceStatus").textContent = "报价暂不可用，可重试";
  } finally {
    priceBusy = false;
    scheduleRender();
  }
}
function updateAllowlist(rows) {
  const next = normalizeAllowlist(rows);
  if (next.some((r) => revokedAsset(r.chain, r.asset)))
    throw Error("名单包含已撤销的假币合约");
  localStorage.setItem(
    "rebate-asset-allowlist-v2",
    JSON.stringify({
      assets: next,
      knownDefaults: normalizeAllowlist(defaultAllowlist),
    }),
  );
  assetAllowlist = next;
  configureAssetAllowlist(next);
  policyVersion++;
  prices = {};
}
function fillSettings() {
  settingsDraft = [...state.selected];
  $("evmWallet").value = EVM;
  $("solWallet").value = SOL;
  $("toleranceEnabled").checked = preferences.enabled;
  $("toleranceValue").value = preferences.threshold;
  $("assetAllowlist").value = formatAllowlist(assetAllowlist);
  $("credentialMode").value = credentialMode;
  $("bscStartBlock").value = scanOptions["56"]?.startBlock || 0;
  for (const [id, key] of Object.entries(credentialFields))
    $(id).value = keys[key] || "";
  for (const [id, key] of [
    ["xlayerKey", "key"],
    ["xlayerSecret", "secret"],
    ["xlayerPassphrase", "passphrase"],
  ])
    $(id).value = keys.xlayer?.[key] || "";
  $("showAllNetworks").checked = false;
  $("chainSearch").value = "";
  drawChoices();
}
function settings() {
  fillSettings();
  $("settings").showModal();
}
function drawChoices() {
  const q = $("chainSearch").value.toLowerCase(),
    all = $("showAllNetworks").checked;
  $("chainChoices").innerHTML = chains
    .filter(
      (c) =>
        !c.unsupported &&
        !/testnet/i.test(c.name) &&
        (all ||
          q ||
          COMMON_CHAINS.includes(c.id) ||
          settingsDraft.includes(c.id)),
    )
    .filter((c) => (c.name + " " + c.id).toLowerCase().includes(q))
    .sort(
      (a, b) =>
        Number(COMMON_CHAINS.includes(b.id)) -
        Number(COMMON_CHAINS.includes(a.id)),
    )
    .map(
      (c) =>
        `<label><input type="checkbox" data-chain="${esc(c.id)}" ${settingsDraft.includes(c.id) ? "checked" : ""}><span>${esc(c.name)}</span></label>`,
    )
    .join("");
}
async function saveSettings() {
  if (busy) return;
  busy = true;
  controller = null;
  try {
    const evm = $("evmWallet").value.trim().toLowerCase(),
      sol = $("solWallet").value.trim(),
      threshold = $("toleranceValue").value;
    if (
      (evm && !validAddress("1", evm)) ||
      (sol && !validAddress("solana", sol))
    )
      throw Error("钱包地址格式不正确");
    if (
      !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(threshold) ||
      threshold.length > 40 ||
      Number(threshold) > 1000000
    )
      throw Error("请填写有效差额阈值");
    const nextAllowlist = parseAllowlist($("assetAllowlist").value);
    if (nextAllowlist.some((r) => revokedAsset(r.chain, r.asset)))
      throw Error("名单包含已撤销的假币合约");
    const xlayer = {
      key: $("xlayerKey").value.trim(),
      secret: $("xlayerSecret").value.trim(),
      passphrase: $("xlayerPassphrase").value.trim(),
    };
    if (
      Object.values(xlayer).some(Boolean) &&
      !Object.values(xlayer).every(Boolean)
    )
      throw Error("X Layer 需同时填写 Key、Secret 和 Passphrase");
    const nextKeys = Object.fromEntries(
      Object.entries(credentialFields).map(([id, key]) => [
        key,
        $(id).value.trim(),
      ]),
    );
    nextKeys.xlayer = Object.values(xlayer).every(Boolean) ? xlayer : null;
    if (
      Object.values(nextKeys).some(
        (v) => typeof v === "string" && v.length > 512,
      ) ||
      Object.values(xlayer).some((v) => v.length > 512)
    )
      throw Error("凭证长度不正确");
    const startBlock = Number($("bscStartBlock").value);
    if (!Number.isSafeInteger(startBlock) || startBlock < 0)
      throw Error("起始区块应为非负整数");
    const mode = $("credentialMode").value,
      nextPreferences = { enabled: $("toleranceEnabled").checked, threshold },
      nextOptions = { 56: { startBlock } };
    await saver.flush();
    const changedWallet = evm !== EVM || sol !== SOL,
      nextStorage = `rebate-ledger-wallet:${evm}:${sol}`;
    const nextState = changedWallet
      ? validateState((await readHistory(nextStorage)) || emptyState(), {
          trustEvidence: true,
          wallets: { evm, sol },
        })
      : { ...state, coverage: { ...state.coverage } };
    nextState.selected = [...settingsDraft];
    migrateState(nextState);
    const oldStart = scanOptions["56"]?.startBlock || 0;
    if (startBlock !== oldStart && nextState.coverage["56"])
      nextState.coverage["56"] = {
        streams: {},
        inspected: [],
        status: "stale",
        error: "历史范围已改变，将按所选区块补查",
      };
    const assignments = [
      ["rebate-wallets-v1", { evm, sol }],
      ["rebate-preferences-v1", nextPreferences],
      ["rebate-scan-options-v1", nextOptions],
      [
        "rebate-asset-allowlist-v2",
        {
          assets: normalizeAllowlist(nextAllowlist),
          knownDefaults: normalizeAllowlist(defaultAllowlist),
        },
      ],
    ];
    const rollback = assignments.map(([key]) => [
      key,
      localStorage.getItem(key),
    ]);
    const oldMode = localStorage.getItem("rebate-credential-mode"),
      oldLocal = localStorage.getItem("rebate-credentials-v1"),
      oldSession = sessionStorage.getItem("rebate-credentials-v1");
    try {
      for (const [key, value] of assignments)
        localStorage.setItem(key, JSON.stringify(value));
      localStorage.setItem("rebate-credential-mode", mode);
      (mode === "session" ? sessionStorage : localStorage).setItem(
        "rebate-credentials-v1",
        JSON.stringify(nextKeys),
      );
      (mode === "session" ? localStorage : sessionStorage).removeItem(
        "rebate-credentials-v1",
      );
      await writeHistory(nextStorage, nextState);
    } catch (error) {
      for (const [key, value] of rollback)
        value === null
          ? localStorage.removeItem(key)
          : localStorage.setItem(key, value);
      for (const [store, key, value] of [
        [localStorage, "rebate-credential-mode", oldMode],
        [localStorage, "rebate-credentials-v1", oldLocal],
        [sessionStorage, "rebate-credentials-v1", oldSession],
      ])
        value === null ? store.removeItem(key) : store.setItem(key, value);
      throw Error("浏览器无法保存设置，未应用修改");
    }
    // Commit only after every field and persistence operation succeeds.
    configureWallets(evm, sol);
    state = nextState;
    state.selected = [...settingsDraft];
    keys = nextKeys;
    credentialMode = mode;
    preferences = nextPreferences;
    scanOptions = nextOptions;
    assetAllowlist = normalizeAllowlist(nextAllowlist);
    configureAssetAllowlist(assetAllowlist);
    policyVersion++;
    prices = {};
    filterSignature = "";
    navigator.storage?.persist?.().catch(() => {});
    $("settings").close();
    render();
    refreshPrices();
    toast("设置已保存");
  } catch (error) {
    toast(error.message);
  } finally {
    busy = false;
    render();
  }
}
function renderCoverage() {
  const items = coverage();
  $("coverageSummary").textContent =
    `所选 ${items.length} 个网络 · ${items.filter((c) => c.status === "complete").length} 个已完成 · 未完成不代表零欠款`;
  const count = new Map();
  for (const row of state.records)
    count.set(row.chain, (count.get(row.chain) || 0) + 1);
  const labels = {
    complete: "历史已扫描",
    missing: "缺少钱包或凭证",
    error: "同步失败",
    paused: "已暂停",
    running: "同步中",
    stale: "需要补核验",
    idle: "尚未同步",
  };
  $("coverageBody").innerHTML = items
    .map(
      ({ chain, coverage: cov, status }) =>
        `<article class="coveragecard"><strong>${esc(chain.name)} · ${esc(labels[status] || status)}</strong><p>${count.get(chain.id) || 0} 条记录${scanOptions[chain.id]?.startBlock ? " · 从区块 " + scanOptions[chain.id].startBlock + " 查询" : ""}</p><p>${esc(cov.error || (cov.updated && new Date(cov.updated).toLocaleString("zh-CN")) || "")}</p><button class="secondary" data-sync-chain="${esc(chain.id)}" ${busy ? "disabled" : ""}>${status === "missing" ? "设置数据源" : "查询此链"}</button></article>`,
    )
    .join("");
}
async function sync(onlyId = null, retryOnly = false) {
  if (busy) {
    controller?.abort();
    setProgress("正在暂停，保存已完成进度…");
    return;
  }
  let selected = onlyId ? [onlyId] : [...state.selected];
  if (retryOnly)
    selected = selected.filter(
      (id) => state.coverage[id]?.status !== "complete",
    );
  const ready = selected.filter((id) => {
    const c = chainBy(id);
    return (
      !c.unsupported &&
      (id === "solana" ? SOL && keys.helius : EVM && keys[providerFor(c)])
    );
  });
  if (!ready.length) {
    settings();
    toast("请设置钱包和对应数据源，再保存设置");
    return;
  }
  if (onlyId && !state.selected.includes(onlyId))
    state.selected = [...state.selected, onlyId];
  busy = true;
  controller = new AbortController();
  progress = "准备同步";
  render();
  renderCoverage();
  try {
    const result = await runSync({
      state,
      ids: ready,
      chains,
      keys,
      routers,
      wallets: { evm: EVM, sol: SOL },
      signal: controller.signal,
      scanOptions,
      onProgress: setProgress,
      onChange: scheduleRender,
      onCheckpoint: () => save(true),
    });
    toast(
      result.aborted
        ? "已暂停，进度已保存"
        : result.errors.length
          ? `${result.errors.length} 个网络未完成，可在同步详情中重试`
          : "同步完成",
    );
  } catch (error) {
    toast(error.message);
  } finally {
    progress = "";
    await save(true).catch(() => {});
    busy = false;
    render();
    controller = null;
    renderCoverage();
    refreshPrices();
  }
}
function showRecords(ids) {
  activeRecordIds = ids;
  renderDetails();
  if (!$("detail").open) $("detail").showModal();
}
function renderDetails() {
  const rows = activeRecordIds
    .map((id) => model().byId.get(id))
    .filter(Boolean)
    .slice(0, 100);
  $("detailBody").innerHTML =
    rows
      .map((row) => {
        const decision = state.decisions[row.id],
          roles = row.roles || {};
        const type = row.spam
          ? "疑似垃圾"
          : row.kind === "commission"
            ? "返佣收入"
            : row.kind === "refund"
              ? "返还支出"
              : row.kind === "ignore"
                ? "其他 / 未计入"
                : "待核对";
        const fields = [
          [
            "归属地址",
            ["commission", "refund"].includes(row.kind)
              ? row.trader
              : "尚未确认",
          ],
          ["网络", chainBy(row.chain).name],
          ["币种合约", row.asset],
          ["交易", row.hash],
          ["交易发起人", roles.transactionSender || row.txSender || "未核验"],
          ["订单持有人", roles.owner || "未取得证明"],
          ["路由合约", roles.router || "—"],
          ["手续费支付者", roles.feePayer || row.suggestedTrader || "—"],
          ["付款授权", roles.authority || "—"],
          ["日志发送", row.from],
          ["日志接收", row.to],
        ];
        return `<article class="record"><strong>${esc(type)} · ${esc(format(row.raw, row.decimals))} ${esc(row.symbol)}</strong><p class="evidence">${esc(row.spamReason || row.reviewReason || row.exclusionReason || row.evidence || "")}</p><dl>${fields.map(([label, value]) => `<dt>${esc(label)}</dt><dd class="mono">${esc(value)}</dd>`).join("")}</dl><div class="actions"><a href="${esc(link(row))}" target="_blank" rel="noreferrer">链上交易 ↗</a><button class="textbutton" data-copy="${esc(format(row.raw, row.decimals))}">复制完整金额</button></div>${!row.supersededBy && row.raw !== "0" ? `<details class="decisionform"><summary>${decision ? "修改人工判断" : "人工核对"}</summary><p class="metadata">按实际用途判断。原始流水保留，可随时撤销。${row.importedUnverified ? "此记录来自备份；人工用途已保留，需先核验交易与金额才会生效。" : ""}</p><form data-decision="${esc(row.id)}"><label class="field">用途<select name="kind"><option value="pending">待核对</option>${row.direction === "in" ? '<option value="commission">返佣</option>' : '<option value="refund">返还</option>'}<option value="ignore">其他用途，不计入</option></select></label><label class="field">归属地址<input name="trader" value="${esc(decision?.trader || (["commission", "refund"].includes(row.kind) ? row.trader : ""))}" autocomplete="off" placeholder="最终被邀请地址"></label><label class="field">判断原因<input name="reason" maxlength="500" value="${esc(decision?.reason || "")}" required placeholder="用途或凭证说明"></label><div class="actions"><button type="submit" ${busy ? "disabled" : ""}>保存判断</button>${decision ? `<button class="secondary" type="button" data-undo="${esc(row.id)}">撤销人工判断</button>` : ""}</div></form></details>` : ""}${row.spam ? `<div class="actions"><button class="secondary" data-keep="${esc(row.id)}">仅保留这笔记录</button>${row.asset !== "native" ? `<button class="secondary" data-trust="${esc(row.id)}">信任此合约</button>` : ""}</div>` : ""}<details><summary>开发者诊断</summary><button class="secondary" data-case="${esc(row.id)}">复制案例</button></details></article>`;
      })
      .join("") +
    (activeRecordIds.length > 100
      ? '<p class="metadata">仅展开前 100 条凭证；可在核对记录按交易搜索。</p>'
      : "");
  for (const form of $("detailBody").querySelectorAll("[data-decision]"))
    form.elements.kind.value =
      state.decisions[form.dataset.decision]?.kind || "pending";
}
async function applyDecision(id, decision) {
  if (busy) return toast("请先暂停同步或核验");
  const row = model().byId.get(id);
  if (!row) return;
  if (
    ["commission", "refund"].includes(decision.kind) &&
    !validAddress(row.chain, decision.trader)
  )
    return toast("请填写有效的最终归属地址");
  if (["commission", "refund"].includes(decision.kind) && row.spam)
    return toast("请先确认合约身份；单笔保留不会自动信任未知资产");
  await commitDecisions(
    {
      ...state.decisions,
      [id]: {
        ...decision,
        trader:
          row.chain === "solana"
            ? decision.trader
            : decision.trader?.toLowerCase(),
        updatedAt: new Date().toISOString(),
      },
    },
    "人工判断已保存",
  );
}
async function commitDecisions(decisions, message) {
  if (busy) return;
  busy = true;
  controller = null;
  try {
    await saver.flush();
    const candidate = { ...state, decisions };
    await writeHistory(walletStorage(), candidate);
    state = candidate;
    toast(message);
  } catch (error) {
    toast("判断保存失败，原账目未改变：" + error.message);
  } finally {
    busy = false;
    render();
    renderDetails();
    refreshPrices();
  }
}
const recheckLabels = {
  queued: "等待处理",
  missing: "缺少凭证",
  failed: "请求失败",
  resolved: "已解决",
  partial: "部分解决",
  unresolved: "仍待核对",
  cancelled: "未处理",
};
function showRecheckReport() {
  const report = state.lastRecheck;
  if (!report?.entries) return toast("暂无核验结果");
  const filter = $("recheckResultFilter").value;
  const entries = report.entries.filter(
    (e) =>
      filter === "all" ||
      (filter === "unresolved"
        ? ["unresolved", "partial"].includes(e.status)
        : filter === "cancelled"
          ? ["cancelled", "queued"].includes(e.status)
          : e.status === filter),
  );
  const counts = new Map();
  for (const e of report.entries)
    counts.set(e.status, (counts.get(e.status) || 0) + 1);
  $("recheckSummary").textContent =
    `${report.entries.length} 笔交易 · 已解决 ${counts.get("resolved") || 0} · 部分解决 ${counts.get("partial") || 0} · 待核对 ${counts.get("unresolved") || 0} · 失败 ${counts.get("failed") || 0} · 缺凭证 ${counts.get("missing") || 0} · 未处理 ${(counts.get("queued") || 0) + (counts.get("cancelled") || 0)}`;
  const paged = pageItems(entries, reportPage);
  reportPage = paged.page;
  $("recheckRows").replaceChildren(
    ...paged.items.map((entry) => {
      const article = document.createElement("article");
      article.className = "reportrow";
      const first = document.createElement("div"),
        title = document.createElement("strong"),
        a = document.createElement("a");
      title.textContent = chainBy(entry.chain).name;
      a.textContent = short(entry.hash) + " ↗";
      a.href = link(entry);
      a.target = "_blank";
      a.rel = "noreferrer";
      first.append(title, document.createElement("br"), a);
      const second = document.createElement("div"),
        status = document.createElement("p"),
        reason = document.createElement("p");
      status.textContent = `${recheckLabels[entry.status] || "未知"} · 待核对 ${Number(entry.before) || 0} → ${Number(entry.after) || 0}`;
      reason.textContent =
        entry.error ||
        (["unresolved", "partial"].includes(entry.status)
          ? "数据已取得，归属证明仍不足，可人工核对"
          : "已按当前规则处理");
      second.append(status, reason);
      const button = document.createElement("button");
      button.className = "secondary";
      button.textContent = "明细";
      button.dataset.recheckDetail = entry.key;
      article.append(first, second, button);
      return article;
    }),
  );
  $("reportPage").textContent = `${reportPage} / ${paged.max}`;
  $("reportPrev").disabled = reportPage <= 1;
  $("reportNext").disabled = reportPage >= paged.max;
  $("retryRecheckFailures").disabled =
    busy ||
    !report.entries.some((e) =>
      ["failed", "missing", "cancelled", "queued"].includes(e.status),
    );
  if (!$("recheckReport").open) $("recheckReport").showModal();
}
async function recheck(retryKeys = null, scope = "pending") {
  if (busy) return;
  const currentFilters = filters(),
    data = model();
  const candidates = (
    scope === "confirmed"
      ? data.classified.filter(
          (r) =>
            !r.supersededBy &&
            !r.spam &&
            ["commission", "refund", "pending"].includes(r.kind) &&
            r.raw !== "0",
        )
      : view === "spam"
        ? data.spam
        : data.pending
  ).filter((r) =>
    retryKeys
      ? retryKeys.has(r.chain + ":" + r.hash)
      : matchesFilters(r, currentFilters, view),
  );
  const { entries, jobs } = planRecheck(
    candidates,
    state.records,
    chainBy,
    keys,
  );
  if (!entries.length) return toast("当前范围没有可核验的记录");
  state.lastRecheck = {
    started: new Date().toISOString(),
    before: candidates.length,
    total: data.pending.length,
    entries,
  };
  reportPage = 1;
  busy = true;
  controller = new AbortController();
  render();
  try {
    await save(true);
  } catch (error) {
    busy = false;
    controller = null;
    render();
    toast(error.message);
    return;
  }
  if (!jobs.length) {
    busy = false;
    controller = null;
    render();
    return showRecheckReport();
  }
  const force = $("forceRefresh").checked,
    index = new RecordIndex(state.records),
    entryIndex = new Map(entries.map((e, i) => [e.key, i]));
  let completed = 0,
    cursor = 0,
    endSent = false,
    buffer = [],
    lastFlush = Date.now(),
    worker,
    cancel;
  const inspectedByChain = new Map(
    Object.entries(state.coverage).map(([id, cov]) => [
      id,
      new Set(cov.inspected || []),
    ]),
  );
  const flush = async () => {
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    const touchedChains = new Set();
    for (const result of batch) {
      touchedChains.add(result.chain);
      if (!inspectedByChain.has(result.chain))
        inspectedByChain.set(result.chain, new Set());
      const inspected = inspectedByChain.get(result.chain);
      const cov = (state.coverage[result.chain] ||= {
        streams: {},
        inspected: [],
      });
      cov.inspectionErrors ||= {};
      if (result.error) {
        inspected.delete(result.hash);
        cov.inspectionErrors[result.hash] = result.error;
        index.merge(
          index
            .transaction(result.chain, result.hash)
            .map((r) => ({ ...r, inspectionError: result.error })),
        );
      } else {
        index.replace(result.chain, result.hash, result.rows || []);
        inspected.add(result.hash);
        delete cov.inspectionErrors[result.hash];
      }
    }
    for (const id of touchedChains)
      state.coverage[id].inspected = [...inspectedByChain.get(id)];
    state.records = index.values();
    state.updated = new Date().toISOString();
    const counts = pendingCounts(model().pending);
    for (const result of batch) {
      const position = entryIndex.get(result.key);
      state.lastRecheck.entries[position] = recheckOutcome(
        state.lastRecheck.entries[position],
        counts,
        result.error,
      );
    }
    lastFlush = Date.now();
    await save(true);
    scheduleRender();
  };
  const started = Date.now();
  const update = () =>
    setProgress(
      `核验 ${completed}/${jobs.length} 笔交易 · ${Math.round((completed * 60000) / Math.max(1, Date.now() - started))} 笔/分钟${document.hidden ? " · 后台保存进度" : ""}`,
    );
  const nextBatch = () => {
    if (endSent) return;
    const batch = jobs.slice(cursor, cursor + 30);
    cursor += batch.length;
    if (batch.length) worker.postMessage({ type: "append", jobs: batch });
    if (cursor >= jobs.length) {
      worker.postMessage({ type: "end" });
      endSent = true;
    }
  };
  try {
    if (controller.signal.aborted) throw Error("已暂停");
    worker = new Worker(new URL("./recheck-worker.mjs", import.meta.url), {
      type: "module",
    });
    cancel = () => worker.postMessage({ type: "cancel" });
    controller.signal.addEventListener("abort", cancel, { once: true });
    render();
    update();
    await new Promise((resolve, reject) => {
      let flushChain = Promise.resolve();
      worker.onmessage = ({ data: result }) => {
        if (result.type === "need-jobs") nextBatch();
        else if (result.type === "result") {
          completed++;
          buffer.push(result);
          update();
          if (buffer.length >= 10 || Date.now() - lastFlush >= 2500) {
            flushChain = flushChain.then(flush);
            flushChain.catch(reject);
          }
        } else if (result.type === "done") {
          for (const [provider, values] of Object.entries(
            result.diagnostics || {},
          )) {
            workerDiagnostics[provider] ||= {};
            for (const [key, value] of Object.entries(values))
              workerDiagnostics[provider][key] =
                (workerDiagnostics[provider][key] || 0) + value;
          }
          flushChain.then(flush).then(resolve, reject);
        } else if (result.type === "fatal") reject(Error(result.error));
      };
      worker.onerror = (e) => reject(Error(e.message || "核验线程退出"));
      worker.postMessage({
        type: "start",
        streaming: true,
        jobs: [],
        keys,
        routers,
        wallets: { evm: EVM, sol: SOL },
        forceRefresh: force,
      });
    });
  } catch (error) {
    toast(error.message);
    await flush().catch(() => {});
  } finally {
    if (cancel) controller?.signal.removeEventListener("abort", cancel);
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    }
    controller = null;
    const counts = pendingCounts(model().pending);
    state.lastRecheck.entries = state.lastRecheck.entries.map((entry) =>
      entry.status === "queued"
        ? { ...entry, status: "cancelled", error: "任务已暂停，可继续未处理项" }
        : ["missing", "cancelled"].includes(entry.status)
          ? entry
          : recheckOutcome(entry, counts, entry.error),
    );
    state.lastRecheck.finished = new Date().toISOString();
    state.migrationPending = model().pending.some(
      (r) => r.needsProof || r.importedUnverified,
    );
    progress = "";
    await save(true).catch(() => {});
    busy = false;
    render();
    refreshPrices();
    showRecheckReport();
  }
}

function download(filename, content, type = "application/json") {
  const blob =
      content instanceof Blob ? content : new Blob([content], { type }),
    url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
let backupBusy = false;
async function backupWork(message) {
  if (backupBusy) throw Error("请等待当前备份操作完成");
  backupBusy = true;
  $("backupProgress").textContent = "正在处理文件…";
  const worker = new Worker(new URL("./backup-worker.mjs", import.meta.url), {
    type: "module",
  });
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) =>
        data.ok ? resolve(data) : reject(Error(data.error));
      worker.onerror = (e) => reject(Error(e.message || "备份线程失败"));
      worker.postMessage(message);
    });
  } finally {
    worker.terminate();
    backupBusy = false;
    $("backupProgress").textContent = "";
  }
}
async function exportBackup(kind) {
  try {
    if (kind === "history") await saver.flush();
    const include = kind === "settings" && $("includeCredentials").checked,
      password = $("backupPassword").value;
    if (password && password.length < 8) throw Error("加密口令至少 8 个字符");
    const value =
      kind === "history"
        ? {
            format: "rebate-history",
            backupVersion: 2,
            createdAt: new Date().toISOString(),
            wallets: { evm: EVM, sol: SOL },
            state,
          }
        : {
            format: "rebate-settings",
            version: 1,
            wallets: { evm: EVM, sol: SOL },
            preferences,
            selected: state.selected,
            assetAllowlist,
            credentialMode,
            scanOptions,
            ...(include ? { credentials: keys } : {}),
          };
    const compress = kind === "history" && $("compressBackup").checked,
      result = await backupWork({ type: "encode", value, password, compress });
    download(
      `返佣账本-${kind === "history" ? "历史" : "设置"}${include ? "-含凭证" : ""}-${new Date().toISOString().slice(0, 10)}${password ? ".rebate" : ".json"}${compress ? ".gz" : ""}`,
      result.blob,
    );
    toast(include ? "设置已导出，含 API 凭证，请私下保存" : "备份已导出");
  } catch (error) {
    toast(error.message);
  }
}
async function importBackup(event, kind) {
  const input = event.target,
    file = input.files[0];
  if (!file) return;
  try {
    if (busy) throw Error("请先暂停同步或核验");
    if (kind === "history" && !EVM && !SOL)
      throw Error("请先设置与备份相同的钱包");
    const ownerWallet = walletStorage();
    const { value } = await backupWork({
      type: "decode",
      file,
      kind,
      password: $("backupPassword").value,
      wallets: { evm: EVM, sol: SOL },
    });
    if (kind === "history") {
      if (busy || ownerWallet !== walletStorage())
        throw Error("钱包或任务状态已改变，请重新导入");
      importCandidate = value.state;
      importWallet = ownerWallet;
      const ids = new Set(state.records.map((r) => r.id)),
        added = importCandidate.records.filter((r) => !ids.has(r.id)).length;
      $("importSummary").textContent =
        `文件包含 ${importCandidate.records.length.toLocaleString()} 条记录；将新增 ${added.toLocaleString()} 条。已有本机记录与人工判断优先保留。导入的机器归属需核验，扫描检查点保留，不从头扫描。`;
      $("importPreview").showModal();
    } else if (kind === "settings") {
      $("backupCenter").close();
      settings();
      $("evmWallet").value = value.wallets.evm;
      $("solWallet").value = value.wallets.sol;
      $("toleranceEnabled").checked = value.preferences.enabled;
      $("toleranceValue").value = value.preferences.threshold;
      settingsDraft = value.selected.filter((id) => chainMap.has(id));
      $("credentialMode").value = value.credentialMode;
      $("bscStartBlock").value = value.scanOptions?.["56"]?.startBlock || 0;
      if (value.assetAllowlist)
        $("assetAllowlist").value = formatAllowlist(value.assetAllowlist);
      if (value.credentials) {
        for (const [id, key] of Object.entries(credentialFields))
          $(id).value = value.credentials[key] || "";
        for (const [id, key] of [
          ["xlayerKey", "key"],
          ["xlayerSecret", "secret"],
          ["xlayerPassphrase", "passphrase"],
        ])
          $(id).value = value.credentials.xlayer?.[key] || "";
      }
      drawChoices();
      toast("设置已填入，保存后生效");
    } else {
      $("assetAllowlist").value = formatAllowlist(value.assets);
      toast("名单已填入，保存设置后生效");
    }
  } catch (error) {
    toast(error.message);
  } finally {
    input.value = "";
  }
}
async function commitImport() {
  if (!importCandidate || busy) return;
  if (importWallet !== walletStorage()) {
    importCandidate = null;
    return toast("钱包已切换，请重新导入");
  }
  busy = true;
  controller = null;
  try {
    await saver.flush();
    const local = state,
      incoming = importCandidate,
      index = new RecordIndex(incoming.records);
    index.merge(local.records);
    const knownIds = new Set(local.records.map((r) => r.id));
    const importedDecisions = Object.fromEntries(
      Object.entries(incoming.decisions || {}).filter(
        ([id]) => !knownIds.has(id),
      ),
    );
    const candidate = {
      ...incoming,
      records: index.values(),
      decisions: { ...importedDecisions, ...local.decisions },
      selected: incoming.selected?.length
        ? incoming.selected.filter((id) => chainMap.has(id))
        : local.selected,
    };
    for (const [id, cov] of Object.entries(local.coverage))
      if (
        cov.status === "complete" &&
        cov.updated > (candidate.coverage[id]?.updated || "")
      )
        candidate.coverage[id] = cov;
    candidate.decoderVersion = 4;
    candidate.migrationPending = candidate.records.some(
      (r) => r.importedUnverified,
    );
    for (const chain of new Set(
      candidate.records.filter((r) => r.importedUnverified).map((r) => r.chain),
    )) {
      const cov = (candidate.coverage[chain] ||= {
        streams: {},
        inspected: [],
      });
      candidate.coverage[chain] = {
        ...cov,
        status: "stale",
        error: "导入记录尚需核验，历史分页进度保留",
      };
    }
    // Persist first: an import failure leaves the active state and original data intact.
    await writeHistory(walletStorage(), candidate);
    state = candidate;
    importCandidate = null;
    $("importPreview").close();
    $("backupCenter").close();
    filterSignature = "";
    render();
    refreshPrices();
    toast("历史已合并，核验导入记录后可同步新增");
  } catch (error) {
    toast(error.message);
  } finally {
    busy = false;
    render();
  }
}
function exportCsv() {
  const currentFilters = filters();
  let rows;
  if (rawViews.has(view)) {
    const items = (
      view === "spam"
        ? model().spam
        : view === "ignored"
          ? model().ignored
          : model().pending
    ).filter((r) => matchesFilters(r, currentFilters, view));
    rows = [
      [
        "网络",
        "方向",
        "币种",
        "合约",
        "金额",
        "日志发送",
        "日志接收",
        "归属地址",
        "交易",
        "时间",
        "原因",
      ],
      ...items.map((r) => [
        chainBy(r.chain).name,
        r.direction === "in" ? "转入" : "转出",
        r.symbol,
        r.asset,
        format(r.raw, r.decimals),
        r.from,
        r.to,
        ["commission", "refund"].includes(r.kind) ? r.trader : "",
        r.hash,
        r.time,
        r.spamReason || r.reviewReason || r.exclusionReason || r.evidence || "",
      ]),
    ];
  } else {
    rows = [
      [
        "网络",
        "被邀请地址",
        "币种",
        "合约",
        "应返币数",
        "已返币数",
        "实际差额币数",
        "需处理USD",
        "超返USD",
        "状态",
        "固定记账价或报价来源",
        "报价时间",
      ],
      ...filteredGroups().map((g) => [
        chainBy(g.chain).name,
        g.trader,
        g.symbol,
        g.asset,
        format(g.due, g.decimals),
        format(g.paid, g.decimals),
        format(BigInt(g.due) - BigInt(g.paid), g.decimals),
        g.priced ? g.usdActionable : "缺少报价",
        g.priced ? g.usdActionableExcess : "缺少报价",
        g.withinTolerance ? "小额差额已忽略" : statusText[g.status],
        g.price?.source || "",
        g.price?.fixed
          ? "固定 1 USD"
          : g.price?.at
            ? new Date(g.price.at).toISOString()
            : "",
      ]),
    ];
  }
  download("返佣账本-当前筛选.csv", encodeCsv(rows), "text/csv;charset=utf-8");
}
let workerDiagnostics = {};
async function showDiagnostics() {
  const disk = await storageDiagnostics(),
    network = networkDiagnostics();
  const mb = (bytes) =>
    bytes == null ? "不可用" : (bytes / 1024 / 1024).toFixed(2) + " MiB";
  const facts = [
    ["流水记录", state.records.length.toLocaleString()],
    ["待核对", model().pending.length.toLocaleString()],
    ["浏览器存储", mb(disk.usage)],
    ["可用配额", mb(disk.quota)],
    ["当前 JS 堆（近似）", mb(performance.memory?.usedJSHeapSize)],
    ["最近分类", model().ms.toFixed(1) + " ms"],
    ["最近界面更新", (render.lastMs || 0).toFixed(1) + " ms"],
  ];
  $("diagnosticsBody").innerHTML =
    '<div class="diagnosticgrid">' +
    facts
      .map(
        ([name, value]) =>
          `<div><span class="metadata">${esc(name)}</span><strong>${esc(value)}</strong></div>`,
      )
      .join("") +
    "</div><h3>本次运行请求</h3>" +
    [...new Set([...Object.keys(network), ...Object.keys(workerDiagnostics)])]
      .map((provider) => {
        const a = network[provider] || {},
          b = workerDiagnostics[provider] || {};
        return `<p>${esc(provider)}：请求 ${(a.requests || 0) + (b.requests || 0)} · 缓存命中 ${(a.cacheHits || 0) + (b.cacheHits || 0)} · 重试 ${(a.retries || 0) + (b.retries || 0)} · 错误 ${(a.errors || 0) + (b.errors || 0)}</p>`;
      })
      .join("");
  if (!$("diagnostics").open) $("diagnostics").showModal();
}

for (const menu of document.querySelectorAll("[data-filter]")) {
  menu.addEventListener("change", (event) => {
    if (event.target.type !== "checkbox") return;
    const select = $(menu.dataset.filter);
    for (const option of select.options)
      if (option.value === event.target.value)
        option.selected = event.target.checked;
    page = 1;
    persistFilters();
    render();
  });
  menu
    .querySelector(".optionsearch")
    ?.addEventListener("input", drawFilterMenus);
  menu.addEventListener("toggle", () => {
    if (menu.open)
      for (const other of document.querySelectorAll("[data-filter]"))
        if (other !== menu) other.open = false;
  });
}
document.addEventListener("click", (event) => {
  for (const menu of document.querySelectorAll("[data-filter]"))
    if (!menu.contains(event.target)) menu.open = false;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape")
    for (const menu of document.querySelectorAll("[data-filter]"))
      if (menu.open) {
        menu.open = false;
        menu.querySelector("summary").focus();
      }
});
$("setupButton").onclick = settings;
$("saveSettings").onclick = saveSettings;
$("chainSearch").oninput = drawChoices;
$("showAllNetworks").onchange = drawChoices;
$("chainChoices").onchange = (event) => {
  const id = event.target.dataset.chain;
  if (id)
    settingsDraft = event.target.checked
      ? [...new Set([...settingsDraft, id])]
      : settingsDraft.filter((x) => x !== id);
};
$("selectCommon").onclick = () => {
  settingsDraft = [...COMMON_CHAINS];
  drawChoices();
};
$("clearCredentials").onclick = () => {
  localStorage.removeItem("rebate-credentials-v1");
  sessionStorage.removeItem("rebate-credentials-v1");
  keys = emptyKeys();
  for (const id of [
    ...Object.keys(credentialFields),
    "xlayerKey",
    "xlayerSecret",
    "xlayerPassphrase",
  ])
    $(id).value = "";
  toast("本设备凭证已清除，历史保留");
};
$("syncButton").onclick = () =>
  sync(
    null,
    !busy &&
      coverage().some((c) => ["error", "paused", "running"].includes(c.status)),
  );
$("retryButton").onclick = () => sync(null, true);
$("coverageButton").onclick = () => {
  renderCoverage();
  $("coverageDialog").showModal();
};
$("coverageBody").onclick = (event) => {
  const button = event.target.closest("[data-sync-chain]");
  if (button) {
    $("coverageDialog").close();
    sync(button.dataset.syncChain);
  }
};
$("filterToggle").onclick = () => {
  const open = $("filters").classList.toggle("expanded");
  $("filterToggle").setAttribute("aria-expanded", String(open));
};
let searchTimer;
$("search").oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    page = 1;
    persistFilters();
    render();
  }, 180);
};
for (const id of ["minimumUsd", "minimumField", "sortBy"])
  $(id).onchange = () => {
    page = 1;
    persistFilters();
    render();
  };
$("resetFilters").onclick = () => {
  $("search").value = "";
  $("minimumUsd").value = "0";
  for (const id of [
    "chainFilter",
    "statusFilter",
    "assetFilter",
    "tokenFilter",
    "directionFilter",
  ])
    for (const option of $(id).options) option.selected = false;
  page = 1;
  persistFilters();
  render();
};
function switchView(next) {
  view = next;
  page = 1;
  render();
}
$("ledgerTab").onclick = () => switchView($("ledgerView").value);
$("reviewTab").onclick = () => switchView($("reviewView").value);
$("ledgerView").onchange = () => switchView($("ledgerView").value);
$("reviewView").onchange = () => switchView($("reviewView").value);
for (const tab of [$("ledgerTab"), $("reviewTab")])
  tab.onkeydown = (event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const target =
        event.key === "Home"
          ? $("ledgerTab")
          : event.key === "End"
            ? $("reviewTab")
            : tab === $("ledgerTab")
              ? $("reviewTab")
              : $("ledgerTab");
      target.focus();
      target.click();
    }
  };
$("prev").onclick = () => {
  page--;
  render();
};
$("next").onclick = () => {
  page++;
  render();
};
$("refreshPrices").onclick = () => refreshPrices(true);
$("recheckPending").onclick = () => recheck();
$("auditConfirmed").onclick = () => {
  $("settings").close();
  recheck(null, "confirmed");
};
$("recheckResults").onclick = showRecheckReport;
$("recheckResultFilter").onchange = () => {
  reportPage = 1;
  showRecheckReport();
};
$("reportPrev").onclick = () => {
  reportPage--;
  showRecheckReport();
};
$("reportNext").onclick = () => {
  reportPage++;
  showRecheckReport();
};
$("retryRecheckFailures").onclick = () => {
  const ids = new Set(
    state.lastRecheck.entries
      .filter((e) =>
        ["failed", "missing", "cancelled", "queued"].includes(e.status),
      )
      .map((e) => e.key),
  );
  $("forceRefresh").checked = true;
  $("recheckReport").close();
  recheck(ids, "confirmed");
};
$("exportRecheckResults").onclick = () =>
  download("核验结果.json", JSON.stringify(state.lastRecheck, null, 2));
$("recheckRows").onclick = (event) => {
  const b = event.target.closest("[data-recheck-detail]");
  if (b)
    showRecords(
      (model().byTx.get(b.dataset.recheckDetail) || []).map((r) => r.id),
    );
};
$("tableArea").onclick = (event) => {
  const r = event.target.closest("[data-record]"),
    g = event.target.closest("[data-group]"),
    expand = event.target.closest("[data-expand]");
  if (r) showRecords([r.dataset.record]);
  if (g)
    showRecords(
      model().groups.find((row) => row.key === g.dataset.group)?.ids || [],
    );
  if (expand) {
    const key = expand.dataset.expand;
    expandedAddresses.has(key)
      ? expandedAddresses.delete(key)
      : expandedAddresses.add(key);
    render();
  }
};
$("detailBody").onsubmit = (event) => {
  const form = event.target.closest("[data-decision]");
  if (!form) return;
  event.preventDefault();
  applyDecision(form.dataset.decision, {
    kind: form.elements.kind.value,
    trader: form.elements.trader.value.trim(),
    reason: form.elements.reason.value.trim(),
  });
};
$("detailBody").onclick = async (event) => {
  const undo = event.target.closest("[data-undo]"),
    keep = event.target.closest("[data-keep]"),
    trust = event.target.closest("[data-trust]"),
    sample = event.target.closest("[data-case]");
  if (undo && !busy) {
    const next = { ...state.decisions };
    delete next[undo.dataset.undo];
    await commitDecisions(next, "已撤销人工判断");
  }
  if (keep)
    await applyDecision(keep.dataset.keep, {
      kind: "pending",
      trader: "",
      reason: "人工保留此笔记录",
      keep: true,
    });
  if (trust && !busy) {
    const row = model().byId.get(trust.dataset.trust);
    try {
      updateAllowlist([
        ...assetAllowlist,
        { chain: row.chain, asset: row.asset },
      ]);
      render();
      renderDetails();
      toast("合约已加入名单，归属仍须独立核验");
    } catch (error) {
      toast(error.message);
    }
  }
  if (sample) {
    const r = model().byId.get(sample.dataset.case);
    const text = [
      "核对案例",
      "网络：" + chainBy(r.chain).name,
      "方向：" + r.direction,
      "金额：" + format(r.raw, r.decimals) + " " + r.symbol,
      "合约：" + r.asset,
      "日志发送：" + r.from,
      "日志接收：" + r.to,
      "交易：" + r.hash,
      "链接：" + link(r),
      "原因：" + (r.spamReason || r.reviewReason || r.evidence || ""),
      "实际用途：",
      "归属地址：",
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast("案例已复制");
    } catch {
      toast("复制失败，请手动复制详情");
    }
  }
};
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (button) {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      toast("已复制");
    } catch {
      toast("无法访问剪贴板，可在详情中选择文本复制");
    }
  }
});
$("backupCenterButton").onclick = () => $("backupCenter").showModal();
$("backupButton").onclick = () => exportBackup("history");
$("exportSettings").onclick = () => exportBackup("settings");
$("exportButton").onclick = exportCsv;
$("importFile").onchange = (event) => importBackup(event, "history");
$("importSettings").onchange = (event) => importBackup(event, "settings");
$("importAllowlist").onchange = (event) => importBackup(event, "allowlist");
$("confirmImport").onclick = commitImport;
$("importPreview").addEventListener("close", () => {
  importCandidate = null;
});
$("exportAllowlist").onclick = () =>
  download(
    "合约白名单.json",
    JSON.stringify(
      { format: "rebate-allowlist", version: 1, assets: assetAllowlist },
      null,
      2,
    ),
  );
$("diagnosticsButton").onclick = showDiagnostics;
window.addEventListener("pagehide", () => {
  saver.flush().catch(() => {});
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearTimeout(renderTimer);
    saver.flush().catch(() => {});
  } else {
    render();
    refreshPrices();
  }
});
window.addEventListener("storage", (event) => {
  if (event.key === "rebate-price-cache-v2") {
    prices = { ...prices, ...safeRead(localStorage, event.key, {}) };
    scheduleRender();
  }
});
setInterval(
  () => {
    if (!document.hidden) refreshPrices();
  },
  5 * 60 * 1000,
);
setInterval(() => {
  if (
    !document.hidden &&
    model().groups.some((g) => g.asset !== "native" || g.chain)
  )
    scheduleRender();
}, 60000);
if (document.modelContext?.registerTool) {
  try {
    document.modelContext.registerTool({
      name: "read_rebate_ledger",
      title: "读取返佣核对结果",
      description: "只读当前已识别账目与覆盖范围，不触发链上操作。",
      inputSchema: {
        type: "object",
        properties: { chain: { type: "string" } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute(input) {
        if (
          !input ||
          Object.keys(input).some((k) => k !== "chain") ||
          (input.chain !== undefined && !chainMap.has(input.chain))
        )
          throw Error("无效网络参数");
        return {
          rows: model().groups.filter(
            (g) => !input.chain || g.chain === input.chain,
          ),
          pending: model().pending.length,
          coverage: state.coverage,
          updated: state.updated,
        };
      },
    });
  } catch {}
}
if (migrated) save();
render();
refreshPrices();
import { setUpdateGuard } from "./install.mjs";
setUpdateGuard(async () => {
  if (busy || backupBusy) {
    toast("请先暂停当前任务，再更新应用");
    return false;
  }
  try {
    await saver.flush();
    return true;
  } catch {
    toast("请先导出备份；本机保存尚未完成");
    return false;
  }
});
