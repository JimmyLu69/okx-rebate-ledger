export function errorPresentation(error) {
  const detail = String(error?.message || error || "操作失败");
  if (/429|rate.?limit|限流|额度/i.test(detail)) return { title: "数据源限流", action: "稍后重试失败项，已完成记录会保留。", detail };
  if (/401|403|unauthor|API.?key|凭证.*(失效|错误)|invalid.*key/i.test(detail)) return { title: "凭证不可用", action: "检查对应数据源的凭证和免费额度。", detail };
  if (/timeout|timed out|fetch|网络|超时|连接/i.test(detail)) return { title: "网络连接失败", action: "联网后重试失败项，无需重复扫描全部历史。", detail };
  if (/proof|证据|凭证.*核验|归属|owner/i.test(detail)) return { title: "归属证据不足", action: "可查看交易详情并按实际用途核对。", detail };
  return { title: detail, action: "", detail: "" };
}
export function backupFilename(kind, wallets, { credentials = false, password = "", compress = false, now = new Date() } = {}) {
  const short = value => value ? value.slice(0, 6) + "-" + value.slice(-4) : "";
  const owner = [short(wallets.evm), short(wallets.sol)].filter(Boolean).join("_") || "未设置钱包";
  const stamp = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((v,i) => i ? String(v).padStart(2,"0") : v).join("") + "-" + [now.getHours(),now.getMinutes(),now.getSeconds()].map(v => String(v).padStart(2,"0")).join("");
  return `返佣账本-${owner}-${kind}${credentials ? "-含凭证" : ""}-${stamp}${password ? ".rebate" : ".json"}${compress ? ".gz" : ""}`;
}
export function importSummary(local, incoming, wallets, createdAt) {
  const current = new Map(local.records.map(row => [row.id, row]));
  let added = 0, conflicts = 0, existing = 0;
  for (const row of incoming.records) {
    const prior = current.get(row.id);
    if (!prior) added++;
    else {
      existing++;
      if (["raw","asset","decimals","from","to","hash","chain"].some(key => prior[key] !== row[key])) conflicts++;
    }
  }
  const decisions = Object.entries(incoming.decisions || {});
  return {
    wallets, createdAt, total: incoming.records.length, added, existing, conflicts,
    ignoredDecisions: decisions.filter(([id]) => current.has(id)).length,
    preservedDecisions: Object.keys(local.decisions || {}).length,
    networks: [...new Set(incoming.records.map(row => row.chain))],
    scans: Object.entries(incoming.coverage || {}).map(([chain,cov]) => ({ chain, height: Math.max(0,...Object.values(cov.streams || {}).map(s => Number(s.highBlock) || 0)), trusted: !cov.importedCoverage })),
  };
}
