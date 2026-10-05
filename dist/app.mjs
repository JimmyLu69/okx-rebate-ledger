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
import { storageDiagnostics } from "./storage.mjs";
import { readProfile, writeProfile, releaseProfile, profileKey, exportRawProfile } from "./profile-storage.mjs";
import { acquireWalletTask } from "./task-coordinator.mjs";
import { errorPresentation, importSummary, backupFilename } from "./ui-helpers.mjs";
import { createBackupController } from "./backup-controller.mjs";
import {
  EVM,
  SOL,
  configureWallets,
  format,
  validAddress,
  migrateManualDecisions,
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
  storageWarn = "",
  historyProtected = false;
let policyVersion = 0,
  prices = {},
  priceBusy = false,
  renderTimer,
  activeRecordIds = [],
  detailPage = 1,
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
const currentWallets = () => ({ evm: EVM, sol: SOL });
const walletStorage = () => profileKey(currentWallets());
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
  const saved = await readProfile(currentWallets(), safeRead(localStorage, walletStorage(), null) || safeRead(localStorage, "rebate-ledger-v1", null));
  if (saved) state = saved;
} catch {
  historyProtected = true;
  storageWarn = "历史读取异常，原始数据已保护，请导出原始数据后恢复备份";
}
function migrateState(target = state) {
  Object.assign(target, migrateManualDecisions(target.records, target.decisions));
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
    if (historyProtected) throw Error("原始历史处于保护状态，请先恢复备份");
    await writeProfile(currentWallets(), snapshot);
    storageWarn = "";
  } catch (error) {
    storageWarn = "历史保存失败，请立即导出备份";
    toast(storageWarn);
    scheduleRender();
    throw error;
  }
});
function save(flush = false) {
  if (historyProtected) return Promise.resolve();
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
  `<span class="pill ${g.status === "over" ? "red" : g.status === "settled" ? "" : "amber"}">${g.withinTolerance ? "阈值内，视为结清" : statusText[g.status] || esc(g.status)}</span>`;
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
function renderFilterChips() {
  const chips = [];
  const raw = rawViews.has(view);
  for (const id of ["chainFilter", "tokenFilter", "assetFilter", raw ? "directionFilter" : "statusFilter"])
    for (const option of $(id).selectedOptions)
      chips.push(`<button type="button" class="filterchip" data-clear-filter="${esc(id)}" data-value="${esc(option.value)}">${esc(option.text)} <span aria-hidden="true">×</span></button>`);
  if ($("search").value.trim()) chips.push(`<button class="filterchip" data-clear-filter="search">搜索：${esc($("search").value)} ×</button>`);
  if (!raw && Number($("minimumUsd").value)) chips.push(`<button class="filterchip" data-clear-filter="minimumUsd">${esc($("minimumField").selectedOptions[0]?.text)} ≥ ${esc($("minimumUsd").value)} ×</button>`);
  $("filterChips").innerHTML = chips.join("");
  $("filterChips").hidden = !chips.length;
  $("resetFilters").hidden = !chips.length;
  $("filterSummary").textContent = chips.length ? "汇总仅含当前筛选范围" + (!raw && Number($("minimumUsd").value) ? " · 缺报价地址保留" : "") : "";
}
$("filterChips").onclick = event => {
  const chip = event.target.closest("[data-clear-filter]");
  if (!chip) return;
  const input = $(chip.dataset.clearFilter);
  if (input.options) for (const option of input.options) { if (option.value === chip.dataset.value) option.selected = false; }
  else input.value = input.id === "minimumUsd" ? "0" : "";
  page = 1; persistFilters(); render();
};
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
      ? `已核实账目 · ${data.pending.length ? data.pending.length + " 条待核对未计入" : "当前筛选范围"}`
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
        : `已扫描 ${done}/${cov.length} 个所选网络${cov.some((c) => c.status === "missing") ? " · 有网络缺少凭证" : ""}`);
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
  $("recheckPending").hidden = !state.records.length;
  $("recoveryNotice").hidden = !historyProtected;
  $("exportRecovery").hidden = false;
  $("exportRecovery").textContent = historyProtected ? "导出受保护原始数据" : "导出原始数据与恢复存档";
  $("syncButton").disabled = historyProtected;
  $("recheckPending").disabled ||= historyProtected;
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
  renderFilterChips();
  $("evmDisplay").textContent = EVM || "未设置";
  $("solDisplay").textContent = SOL || "未设置";
  $("migrationNote").hidden = !(
    state.migrationPending ||
    data.pending.some((r) => r.needsProof || r.importedUnverified)
  );
  $("migrationNote").textContent = data.pending.some(r => r.importedUnverified)
    ? "导入记录待核验；外部扫描进度需确认完整性。本机已核实记录保留。"
    : "识别规则已更新，缺少归属证明的旧记录需重新核验。";
  if (data.conflicts?.length) {
    $("migrationNote").hidden = false;
    $("migrationNote").textContent += ` ${data.conflicts.length} 项资产精度冲突，已暂停该资产计算，其余账目正常。`;
  }
  let items, headers, renderRow;
  if (view === "ledger") {
    const result = sortAddresses(groups, $("sortBy").value);
    items = result.items;
    headers = ["币种", "累计返佣", "累计返还", "实际差额", "状态", ""];
    renderRow = (address) => {
      const key =
          (address.assets[0].chain === "solana" ? "sol:" : "evm:") +
          address.address,
        t = result.totals.get(key);
      const head = `<tr class="addresshead"><td colspan="6"><div class="addressbar"><button class="addresscopy mono" data-copy="${esc(address.address)}" title="复制完整地址">${esc(short(address.address))} ⧉</button><div class="addresssummary"><span>累计返佣<b>${usd(t.due)}</b></span><span>累计返还<b>${usd(t.paid)}</b></span><span>还需返还<b class="amount">${usd(t.remaining)}</b></span>${t.excess ? `<span>超返<b>${usd(t.excess)}</b></span>` : ""}${t.missing ? "<span>部分资产缺价</span>" : ""}</div></div></td></tr>`;
      const assets = expandedAddresses.has(key)
        ? address.assets
        : address.assets.slice(0, 5);
      return (
        head +
        assets
          .map((g) => {
            const net = BigInt(g.due) - BigInt(g.paid),
              amountCell = (raw, quote) =>
                `<span class="quantity" title="${esc(format(raw, g.decimals))}">${esc(quantity(raw, g.decimals))}</span>${g.price?.fixed ? "" : `<span class="cellsub">${g.priced ? usd(quote) : "缺少报价"}</span>`}`;
            return `<tr><td>${currency(g)}</td><td class="num">${amountCell(g.due, g.usdDue)}</td><td class="num">${amountCell(g.paid, g.usdPaid)}</td><td class="num ${net < 0n ? "warning" : "amount"}">${amountCell(net, (g.usdDue || 0) - (g.usdPaid || 0))}</td><td>${badge(g)}</td><td><button class="rowaction" data-group="${esc(g.key)}">明细</button></td></tr>`;
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
      "累计返佣",
      "累计返还",
      "还需返还 USD",
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
    headers = ["时间 / 币种", "方向", "金额", "资金来源 / 去向", "原因", ""];
    renderRow = (r) =>
      `<tr><td>${currency(r)}<span class="cellsub">${r.time ? esc(new Date(r.time).toLocaleString("zh-CN")) : "时间未知"}</span></td><td>${r.direction === "in" ? "转入" : "转出"}</td><td class="num">${esc(quantity(r.raw, r.decimals))}</td><td><button class="addresscopy mono" data-copy="${esc(r.direction === "in" ? r.from : r.to)}">${esc(short(r.direction === "in" ? r.from : r.to))}</button><span class="cellsub">${r.direction === "in" ? "资金来源，不代表归属人" : "日志接收地址"}</span></td><td class="reviewreason">${esc(r.spamReason || r.reviewReason || r.exclusionReason || r.evidence || "需要补充归属证明")}</td><td><button class="rowaction" data-record="${esc(r.id)}">核对</button></td></tr>`;
  }
  const paged = pageItems(items, page);
  page = paged.page;
  $("tableArea").dataset.view = view;
  $("tableArea").innerHTML =
    `<table><thead><tr>${headers.map((h, i) => `<th scope="col"${(view === "ledger" ? [1, 2, 3] : view === "assets" ? [1, 2, 3, 4, 5] : [2]).includes(i) ? ' class="num"' : ""}>${esc(h)}</th>`).join("")}</tr></thead><tbody>${paged.items.map(renderRow).join("") || `<tr><td class="empty" colspan="${headers.length}"><h3>${state.records.length ? "当前范围没有记录" : "还没有账目"}</h3><p>${state.records.length ? "试试清空筛选。" : "设置钱包或导入备份即可开始。"}</p><div class="emptyactions"><button class="secondary" data-empty="${state.records.length ? "reset" : "settings"}">${state.records.length ? "清空筛选" : "设置钱包"}</button>${!state.records.length ? '<button class="secondary" data-empty="import">导入备份</button>' : ""}</div></td></tr>`}</tbody></table>`;
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
  $("settingsStatus").textContent = "";
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
  const providers = new Set(settingsDraft.map(id => providerFor(chainBy(id))));
  for (const field of document.querySelectorAll("[data-provider]")) field.hidden = !providers.has(field.dataset.provider);
  $("providerHint").textContent = providers.size ? "仅显示所选网络需要的凭证" : "先选择需要查询的网络";
}
async function saveSettings() {
  if (busy || backupBusy) return toast("请等待当前任务完成");
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
    if (historyProtected) throw Error("历史读取异常，请先导出原始数据并恢复备份；设置尚未修改");
    await saver.flush();
    const changedWallet = evm !== EVM || sol !== SOL, previousWallets = currentWallets();
    const nextState = changedWallet
      ? (await readProfile({ evm, sol }, safeRead(localStorage, profileKey({evm,sol}), null))) || emptyState()
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
      await writeProfile({ evm, sol }, nextState);
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
    releaseProfile(previousWallets, {evm,sol});
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
    $("settingsStatus").textContent = "已保存";
    toast("设置已保存");
  } catch (error) {
    $("settingsStatus").textContent = error.message;
    toast(error.message);
  } finally {
    busy = false;
    render();
  }
}
function renderCoverage() {
  const items = coverage();
  $("coverageSummary").textContent =
    `所选 ${items.length} 个网络 · ${items.filter((c) => c.status === "complete").length} 个已扫描 · 核验进度另计`;
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
  if (historyProtected) return toast("请先恢复受保护的历史");
  if (backupBusy) return toast("请等待文件处理完成");
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
  let releaseTask;
  try {
    releaseTask = await acquireWalletTask(currentWallets(), controller.signal);
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
    releaseTask?.();
    render();
    controller = null;
    renderCoverage();
    refreshPrices();
  }
}
function showRecords(ids) {
  activeRecordIds = ids;
  detailPage = 1;
  renderDetails();
  if (!$("detail").open) $("detail").showModal();
}
function renderDetails() {
  const byId = model().byId,
    paged = pageItems(
      activeRecordIds.map((id) => byId.get(id)).filter(Boolean),
      detailPage,
      50,
    ),
    rows = paged.items;
  detailPage = paged.page;
  $("detailPager").hidden = paged.max <= 1;
  $("detailPageNum").textContent =
    `${detailPage} / ${paged.max} · ${paged.total} 条`;
  $("detailPrev").disabled = detailPage <= 1;
  $("detailNext").disabled = detailPage >= paged.max;
  $("detailBody").innerHTML = rows
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
          ["commission", "refund"].includes(row.kind) ? row.trader : "尚未确认",
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
      return `<article class="record"><strong>${esc(type)} · ${esc(format(row.raw, row.decimals))} ${esc(row.symbol)}</strong><p class="evidence">${esc(row.spamReason || row.reviewReason || row.exclusionReason || row.evidence || "")}</p><dl>${fields.map(([label, value]) => `<dt>${esc(label)}</dt><dd class="mono">${esc(value)}</dd>`).join("")}</dl><div class="actions"><a href="${esc(link(row))}" target="_blank" rel="noreferrer">链上交易 ↗</a><button class="textbutton" data-copy="${esc(format(row.raw, row.decimals))}">复制完整金额</button></div>${!row.supersededBy && row.raw !== "0" ? `<details class="decisionform"><summary>${decision ? "修改人工判断" : "人工核对"}</summary><p class="metadata">${row.manualBlocked ? esc(row.manualBlocked) : "按实际用途判断，可随时撤销。"}${row.manualConflict ? esc(row.manualConflict) : ""}${row.importedUnverified ? "此记录来自备份；人工用途已保留，需先核验交易与金额才会生效。" : ""}</p><form data-decision="${esc(row.id)}"><label class="field">用途<select name="kind"><option value="pending">待核对</option>${row.manualBlocked ? "" : row.direction === "in" ? '<option value="commission">返佣</option>' : '<option value="refund">返还</option>'}<option value="ignore">其他用途，不计入</option></select></label><label class="field">归属地址<input name="trader" value="${esc(decision?.trader || (["commission", "refund"].includes(row.kind) ? row.trader : ""))}" autocomplete="off" placeholder="最终被邀请地址"></label><label class="field">判断原因<input name="reason" maxlength="500" value="${esc(decision?.reason || "")}" required placeholder="用途或凭证说明"></label><div class="actions"><button type="submit" ${busy ? "disabled" : ""}>保存判断</button>${decision ? `<button class="secondary" type="button" data-undo="${esc(row.id)}">撤销人工判断</button>` : ""}</div></form></details>` : ""}${row.spam ? `<div class="actions"><button class="secondary" data-keep="${esc(row.id)}">仅保留这笔记录</button>${row.asset !== "native" ? `<button class="secondary" data-trust="${esc(row.id)}">信任此合约</button>` : ""}</div>` : ""}<details><summary>开发者诊断</summary><button class="secondary" data-case="${esc(row.id)}">复制案例</button></details></article>`;
    })
    .join("");
  for (const form of $("detailBody").querySelectorAll("[data-decision]"))
    form.elements.kind.value =
      state.decisions[form.dataset.decision]?.kind || "pending";
}
async function applyDecision(id, decision) {
  if (busy) return toast("请先暂停同步或核验");
  const row = model().byId.get(id);
  if (!row) return;
  if (historyProtected) return toast("请先恢复受保护的历史");
  if (["commission", "refund"].includes(decision.kind) && (row.manualBlocked || (decision.kind === "commission" ? row.direction !== "in" : row.direction !== "out"))) return toast(row.manualBlocked || "用途与转账方向不一致");
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
  if (busy || backupBusy) return;
  busy = true;
  controller = null;
  try {
    await saver.flush();
    const candidate = { ...state, decisions };
    await writeProfile(currentWallets(), candidate);
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
function recheckCandidates(scope, retryKeys = null) {
  const data = model(), currentFilters = filters();
  if (retryKeys) {
    const rows = data.classified.filter(r => retryKeys.has(r.chain + ":" + r.hash));
    const found = new Set(rows.map(r => r.chain + ":" + r.hash));
    for (const entry of state.lastRecheck?.entries || []) if (retryKeys.has(entry.key) && !found.has(entry.key)) rows.push({ chain: entry.chain, hash: entry.hash });
    return rows;
  }
  return (scope === "confirmed" ? data.classified.filter(r => !r.supersededBy && !r.spam && ["commission", "refund", "pending"].includes(r.kind) && r.raw !== "0") : view === "spam" ? data.spam : data.pending)
    .filter(r => matchesFilters(r, currentFilters, view));
}
const failedRecheckKeys = () => new Set((state.lastRecheck?.entries || []).filter(e => ["failed", "missing", "cancelled", "queued"].includes(e.status)).map(e => e.key));
function renderRecheckPlan() {
  const scope = $("recheckScope").value, candidates = recheckCandidates(scope === "failures" ? "confirmed" : scope, scope === "failures" ? failedRecheckKeys() : null);
  const plan = planRecheck(candidates, state.records, chainBy, keys);
  $("recheckPlan").textContent = `${plan.entries.length} 笔交易 · ${plan.jobs.length} 笔可开始${plan.entries.length > plan.jobs.length ? " · " + (plan.entries.length - plan.jobs.length) + " 笔缺少凭证" : ""}。默认复用有效缓存，实际请求数取决于交易与数据源。`;
  $("startRecheck").disabled = busy || historyProtected || !plan.entries.length;
}
function openRecheckTask(scope = "pending") {
  $("recheckScope").value = scope;
  renderRecheckPlan();
  $("recheckTask").showModal();
}
$("recheckScope").onchange = renderRecheckPlan;
$("startRecheck").onclick = () => {
  const scope = $("recheckScope").value;
  $("recheckTask").close();
  recheck(scope === "failures" ? failedRecheckKeys() : null, scope === "failures" ? "confirmed" : scope);
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
        entry.error ? errorPresentation(entry.error).title + "。" + errorPresentation(entry.error).action :
        (["unresolved", "partial"].includes(entry.status)
          ? "数据已取得，归属证明仍不足，可人工核对"
          : "已按当前规则处理");
      second.append(status, reason);
      if (entry.error) {
        const detail = document.createElement("details"), summary = document.createElement("summary"), raw = document.createElement("p");
        summary.textContent = "原始错误"; raw.textContent = entry.error;
        detail.append(summary, raw); second.append(detail);
      }
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
  if (busy || backupBusy || historyProtected) return;
  const data = model(), candidates = recheckCandidates(scope, retryKeys);
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
  let releaseTask;
  try {
    releaseTask = await acquireWalletTask(currentWallets(), controller.signal);
    await save(true);
  } catch (error) {
    releaseTask?.();
    busy = false;
    controller = null;
    render();
    toast(error.message);
    return;
  }
  if (!jobs.length) {
    releaseTask?.();
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
  const nextBatch = (credit = 30) => {
    if (endSent) return;
    const batch = jobs.slice(cursor, cursor + Math.min(30, Math.max(0, credit)));
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
        if (result.type === "need-jobs") nextBatch(result.credit);
        else if (result.type === "diagnostics") { liveWorkerDiagnostics = result.diagnostics || {}; }
        else if (result.type === "result") {
          completed++;
          buffer.push(result);
          update();
          if (buffer.length >= 10 || Date.now() - lastFlush >= 2500) {
            flushChain = flushChain.then(flush);
            flushChain.catch(reject);
          }
        } else if (result.type === "done") {
          liveWorkerDiagnostics = {};
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
    liveWorkerDiagnostics = {};
    releaseTask?.();
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
let importOwner, importTarget, importLocal, importRecovery = false;
const backup = createBackupController({
  getContext: () => ({ wallets: currentWallets(), state, keys, preferences, assetAllowlist, credentialMode, scanOptions, busy, protected: historyProtected, unsaved: !!(saver.error || saver.pending) }),
  onBusy: value => { backupBusy = value; }, download, toast,
  prepareStoredExport: async () => {
    if (busy || historyProtected) return false;
    await save();
    const result = await saver.flushForExport();
    return result.saved && !saver.pending && !saver.error;
  },
  getRecovery: async () => ({ ...(await exportRawProfile(currentWallets())), legacyBrowserStorage: { pair: safeRead(localStorage, walletStorage(), null), legacy: safeRead(localStorage, "rebate-ledger-v1", null) } }),
  applySettings(value) {
    $("backupCenter").close(); settings();
    $("evmWallet").value = value.wallets.evm; $("solWallet").value = value.wallets.sol;
    $("toleranceEnabled").checked = value.preferences.enabled; $("toleranceValue").value = value.preferences.threshold;
    settingsDraft = value.selected.filter(id => chainMap.has(id));
    $("credentialMode").value = value.credentialMode; $("bscStartBlock").value = value.scanOptions?.["56"]?.startBlock || 0;
    if (value.assetAllowlist) $("assetAllowlist").value = formatAllowlist(value.assetAllowlist);
    if (value.credentials) {
      for (const [id,key] of Object.entries(credentialFields)) $(id).value = value.credentials[key] || "";
      for (const [id,key] of [["xlayerKey","key"],["xlayerSecret","secret"],["xlayerPassphrase","passphrase"]]) $(id).value = value.credentials.xlayer?.[key] || "";
    }
    drawChoices(); $("settingsStatus").textContent = "已导入草稿，保存后生效"; toast("设置已填入，保存后生效");
  },
  applyAllowlist(value) {
    $("backupCenter").close();
    if (!$("settings").open) settings();
    $("assetAllowlist").value = formatAllowlist(value.assets);
    $("assetAllowlist").closest("details").open = true;
    $("settingsStatus").textContent = "名单已导入草稿，保存后生效";
  },
  async previewHistory(value) {
    importOwner = walletStorage(); importTarget = value.wallets || currentWallets();
    importWallet = profileKey(importTarget); importCandidate = value.state; importRecovery = false;
    try { importLocal = importWallet === walletStorage() && !historyProtected ? state : (await readProfile(importTarget)) || emptyState(); }
    catch { importRecovery = true; importLocal = emptyState(); }
    if (importWallet === walletStorage() && historyProtected) importRecovery = true;
    const plan = importSummary(importLocal, importCandidate, importTarget, value.createdAt);
    $("importSummary").innerHTML = `<dl class="importfacts"><dt>钱包</dt><dd class="mono">${esc(importTarget.evm || "")}<br>${esc(importTarget.sol || "")}</dd><dt>备份时间</dt><dd>${esc(value.createdAt ? new Date(value.createdAt).toLocaleString("zh-CN") : "未知")}</dd><dt>记录</dt><dd>${plan.total} 条 · 新增 ${plan.added} · 已有 ${plan.existing}</dd><dt>冲突</dt><dd>${plan.conflicts} 条金额或身份冲突，保留本机记录</dd><dt>人工判断</dt><dd>保留本机 ${plan.preservedDecisions} 条 · 不覆盖本机的外部判断 ${plan.ignoredDecisions} 条</dd><dt>网络</dt><dd>${esc(plan.networks.map(id => chainBy(id).name).join("、") || "无")}</dd></dl><p class="metadata">本机扫描进度优先保留；外部进度需补查完整性，导入交易需重新核验。</p>${importRecovery ? '<p class="notice warning">原始历史受保护。确认恢复时会先归档原数据，再写入此备份；原数据仍可导出。</p>' : ""}`;
    $("importError").hidden = true;
    $("confirmImport").textContent = importRecovery ? "保留原数据并恢复备份" : importWallet !== walletStorage() ? "切换钱包并合并历史" : "确认合并历史";
    $("importPreview").showModal();
  },
});
const exportBackup = kind => backup.exportBackup(kind);
async function commitImport() {
  if (!importCandidate || busy) return;
  if (importOwner !== walletStorage()) {
    importCandidate = null;
    return toast("钱包已切换，请重新导入");
  }
  busy = true;
  controller = null;
  try {
    if (!historyProtected) await saver.flush();
    const local = importLocal,
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
    // Local coverage is authoritative; an external timestamp cannot override it.
    candidate.coverage = { ...incoming.coverage, ...local.coverage };
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
        error: "导入记录尚需核验；外部历史范围将补查",
      };
    }
    // Persist first: an import failure leaves the active state and original data intact.
    const previousWallets = currentWallets(), previousSetting = localStorage.getItem("rebate-wallets-v1");
    try {
      localStorage.setItem("rebate-wallets-v1", JSON.stringify(importTarget));
      await writeProfile(importTarget, candidate, { recover: importRecovery });
    } catch (error) {
      previousSetting === null ? localStorage.removeItem("rebate-wallets-v1") : localStorage.setItem("rebate-wallets-v1", previousSetting);
      throw error;
    }
    configureWallets(importTarget.evm, importTarget.sol);
    releaseProfile(previousWallets, importTarget);
    historyProtected = false; storageWarn = "";
    state = candidate;
    importCandidate = null;
    $("importPreview").close();
    $("backupCenter").close();
    filterSignature = "";
    render();
    refreshPrices();
    toast("历史已合并，可继续核验与补查");
  } catch (error) {
    $("importError").hidden = false; $("importError").textContent = error.message;
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
        g.withinTolerance ? "阈值内，视为结清" : statusText[g.status],
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
let workerDiagnostics = {}, liveWorkerDiagnostics = {};
async function showDiagnostics() {
  const disk = await storageDiagnostics(),
    network = networkDiagnostics();
  const mb = (bytes) =>
    bytes == null ? "不可用" : (bytes / 1024 / 1024).toFixed(2) + " MiB";
  const facts = [
    ["流水记录", state.records.length.toLocaleString()],
    ["待核对", model().pending.length.toLocaleString()],
    ["浏览器存储", mb(disk.usage)],
    ["存储配额上限（估算）", mb(disk.quota)],
    ["剩余存储（估算）", mb(disk.quota == null ? null : Math.max(0, disk.quota - disk.usage))],
    ["主页面 JS 内存（不含工作线程）", mb(performance.memory?.usedJSHeapSize)],
    ["最近分类", model().ms.toFixed(1) + " ms"],
    ["最近界面更新", (render.lastMs || 0).toFixed(1) + " ms"],
    ["本次实际重分类交易", String(model().reclassifiedTransactions ?? 0)],
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
    [...new Set([...Object.keys(network), ...Object.keys(workerDiagnostics), ...Object.keys(liveWorkerDiagnostics)])]
      .map((provider) => {
        const a = network[provider] || {},
          settled = workerDiagnostics[provider] || {}, live = liveWorkerDiagnostics[provider] || {},
          b = Object.fromEntries([...new Set([...Object.keys(settled), ...Object.keys(live)])].map(key => [key, (settled[key] || 0) + (live[key] || 0)]));
        const requests = (a.requests || 0) + (b.requests || 0), hits = (a.cacheHits || 0) + (b.cacheHits || 0), elapsed = (a.elapsedMs || 0) + (b.elapsedMs || 0);
        return `<p>${esc(provider)}：请求 ${requests} · 缓存 ${hits}${requests + hits ? "（" + Math.round(hits / (requests + hits) * 100) + "%）" : ""} · 重试 ${(a.retries || 0) + (b.retries || 0)} · 错误 ${(a.errors || 0) + (b.errors || 0)} · 请求累计耗时 ${(elapsed / 1000).toFixed(1)} 秒</p>`;
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
  if (id) {
    settingsDraft = event.target.checked ? [...new Set([...settingsDraft, id])] : settingsDraft.filter(x => x !== id);
    drawChoices();
    $("settingsStatus").textContent = "有未保存的修改";
  }
};
$("selectCommon").onclick = () => {
  settingsDraft = [...COMMON_CHAINS];
  drawChoices();
};
const credentialChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("rebate-credentials") : null;
function invalidateCredentials(remote = false) {
  controller?.abort();
  backup.cancel();
  localStorage.removeItem("rebate-credentials-v1"); sessionStorage.removeItem("rebate-credentials-v1");
  keys = emptyKeys();
  for (const id of [...Object.keys(credentialFields), "xlayerKey", "xlayerSecret", "xlayerPassphrase"]) $(id).value = "";
  if (!remote) {
    localStorage.setItem("rebate-credentials-cleared", String(Date.now()));
    credentialChannel?.postMessage({ type: "clear" });
  }
  toast(remote ? "凭证已在另一个页面清除，本页任务已暂停" : "本设备凭证已清除，历史保留");
}
credentialChannel?.addEventListener("message", event => { if (event.data?.type === "clear") invalidateCredentials(true); });
$("clearCredentials").onclick = () => invalidateCredentials();
$("settings").addEventListener("input", () => { $("settingsStatus").textContent = "有未保存的修改"; });
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
$("recheckPending").onclick = () => openRecheckTask();
$("auditConfirmed").onclick = () => {
  $("settings").close();
  openRecheckTask("confirmed");
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
  $("recheckReport").close();
  openRecheckTask("failures");
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
  const empty = event.target.closest("[data-empty]");
  if (empty?.dataset.empty === "settings") settings();
  if (empty?.dataset.empty === "reset") $("resetFilters").click();
  if (empty?.dataset.empty === "import") $("backupCenter").showModal();
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
$("detailPrev").onclick = () => {
  detailPage--;
  renderDetails();
  $("detail").scrollTop = 0;
};
$("detailNext").onclick = () => {
  detailPage++;
  renderDetails();
  $("detail").scrollTop = 0;
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
$("recoveryButton").onclick = () => $("backupCenter").showModal();
$("backupButton").onclick = () => exportBackup("history");
$("exportSettings").onclick = () => exportBackup("settings");
$("exportButton").onclick = exportCsv;

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
  if (event.key === "rebate-credentials-cleared") invalidateCredentials(true);
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
let quoteFreshness = "";
setInterval(() => {
  if (document.hidden) return;
  const signature = Object.entries(prices).map(([key,quote]) => `${key}:${quote.fixed || Date.now() - quote.at < 15 * 60e3}`).join("|");
  if (signature !== quoteFreshness) { quoteFreshness = signature; scheduleRender(); }
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
if (migrated && !historyProtected) save();
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
