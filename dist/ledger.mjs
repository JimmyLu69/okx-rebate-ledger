import { fixedUsdPrice } from "./stablecoins.mjs";
import { classifySolanaRows } from "./solana-classification.mjs";
import { assetAllowed, allowlistEnabled, revokedAsset } from "./allowlist.mjs";
export let EVM = "";
export let SOL = "";
export const LEGACY_FEE_TOPICS = [
  "0x0d3b1268ca3dbb6d3d8a0ea35f44f8f9d58cf578d732680b71b6904fb2733e0d",
  "0xf171268de859ec269c52bbfac94dcb7715e784de194342abb284bf34fd30b32d",
];
export const FEE_TOPICS = [
  "0xcd5eae9d9d0b96532bd1b7dbf6628ce436b2af735829087a03c548439f8bf850",
  "0x3cfb523a4c38d88561dd3bf04805a31715c8b5fc468a03b8d684356f360dea99",
  ...LEGACY_FEE_TOPICS,
];
export function canonical(chain, address) {
  return chain === "solana" ? address : address?.toLowerCase() || "";
}
export function validAddress(chain, a) {
  return chain === "solana"
    ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)
    : /^0x[0-9a-fA-F]{40}$/.test(a);
}
export function format(raw, decimals) {
  let n = BigInt(raw),
    sign = n < 0n ? "-" : "";
  if (n < 0n) n = -n;
  let s = n.toString().padStart(decimals + 1, "0");
  return (
    sign +
    (decimals
      ? s.slice(0, -decimals) + "." + s.slice(-decimals).replace(/0+$/, "")
      : s
    ).replace(/\.$/, "")
  );
}
export function parseAmount(s, d) {
  if (!/^\d+(\.\d+)?$/.test(s)) throw Error("金额必须是非负十进制字符串");
  const [a, b = ""] = s.split(".");
  if (b.length > d) throw Error("金额精度超过代币精度");
  return BigInt(a + b.padEnd(d, "0")).toString();
}
export function safeJSON(text) {
  return JSON.parse(
    text.replace(
      /"(?:\\.|[^"\\])*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (full, n) => (n && /^-?\d{16,}$/.test(n) ? `"${n}"` : full),
    ),
  );
}
export function decisionsFromLegacy(records) {
  const decisions = {};
  for (const r of records)
    if (
      r.reviewed &&
      ["commission", "refund", "ignore", "pending"].includes(r.kind)
    )
      decisions[r.id] = {
        kind: r.kind,
        trader: r.trader || "",
        reason: r.reviewReason || r.evidence || "历史人工判断",
        updatedAt: r.reviewedAt || r.time || new Date().toISOString(),
        keep: !!r.spamDismissed,
      };
  return decisions;
}
// Migrate once: raw records never retain a second, hidden manual decision.
export function migrateManualDecisions(
  records,
  decisions = {},
  trustLegacy = true,
) {
  const migrated = trustLegacy ? decisionsFromLegacy(records) : {};
  return {
    decisions: { ...migrated, ...decisions },
    records: records.map((r) => {
      if (!r.reviewed) return r;
      const next = { ...r, kind: "pending", trader: "" };
      for (const key of [
        "reviewed",
        "reviewedAt",
        "reviewReason",
        "spamDismissed",
        "whitelistKind",
        "automatic",
      ])
        delete next[key];
      // Legacy manual edits may have overwritten the machine-derived trader.
      // Undo must not re-use that address as protocol evidence.
      next.attributionVerified = false;
      return next;
    }),
  };
}
export function decisionMatchesDirection(row, decision) {
  return (
    !!decision &&
    ["commission", "refund", "ignore", "pending"].includes(decision.kind) &&
    (decision.kind !== "commission" || row.direction === "in") &&
    (decision.kind !== "refund" || row.direction === "out")
  );
}
function unavailableEvidence(row) {
  return row.importedUnverified || row.canonicalMissing || !!row.metadataError;
}
// Decisions on real receipts take precedence over all fee rows representing the
// same money. A partly reviewed batch is shown as raw receipts until resolved.
function manualReceiptProjection(records, decisions) {
  const byId = new Map(records.map((r) => [r.id, r])),
    blocked = new Set();
  const receipts = new Map(),
    links = new Map();
  for (const f of records.filter((r) => r.feeEvent)) {
    const ids = (f.matchedReceiptIds || []).filter((id) => byId.has(id));
    receipts.set(f.id, ids);
    for (const id of ids) {
      if (!links.has(id)) links.set(id, []);
      links.get(id).push(f.id);
    }
  }
  const queue = records
    .filter(
      (r) =>
        !r.feeEvent &&
        !unavailableEvidence(r) &&
        decisionMatchesDirection(r, decisions[r.id]),
    )
    .map((r) => r.id);
  const restored = new Set(queue);
  for (let i = 0; i < queue.length; i++) {
    for (const feeId of links.get(queue[i]) || []) {
      if (blocked.has(feeId)) continue;
      blocked.add(feeId);
      for (const id of receipts.get(feeId))
        if (!restored.has(id)) {
          restored.add(id);
          queue.push(id);
        }
    }
  }
  return records.map((r) => {
    if (blocked.has(r.id))
      return {
        ...r,
        kind: "ignore",
        manualSuppressed: true,
        manualBlocked: "对应到账已有人工判断，请在原始到账流水修改",
        attributionVerified: false,
      };
    if (restored.has(r.id) && r.supersededBy) {
      const next = {
        ...r,
        kind: "pending",
        manualConflict:
          "原始到账已人工处理，关联机器返佣暂停；未处理的同组到账需核对",
      };
      delete next.supersededBy;
      return next;
    }
    return r;
  });
}
export function canBookManual(row, records) {
  if (unavailableEvidence(row) || row.manualSuppressed) return false;
  if (!row.feeEvent) return true;
  if (!hasCommissionProof(row) || !row.matchedReceiptIds?.length) return false;
  const byId =
    records instanceof Map ? records : new Map(records.map((r) => [r.id, r]));
  return row.matchedReceiptIds.every((id) => {
    const receipt = byId.get(id);
    return (
      receipt &&
      !receipt.feeEvent &&
      !unavailableEvidence(receipt) &&
      receipt.direction === "in" &&
      receipt.chain === row.chain &&
      receipt.hash === row.hash &&
      receipt.asset === row.asset &&
      receipt.to === row.to &&
      receipt.supersededBy?.includes(row.id)
    );
  });
}
// A completed inspection is authoritative for this transaction. In particular,
// vanished fee events must be removed, rather than survive an additive merge.
// Manual decisions live separately; callers retain them even if an ID disappears.
export function replaceTransactionRecords(old, items, scope = {}) {
  const chain = scope.chain || items[0]?.chain,
    hash = scope.hash || items[0]?.hash;
  if (
    !chain ||
    !hash ||
    items.some((r) => r.chain !== chain || r.hash !== hash)
  )
    throw Error("交易替换范围不一致");
  return mergeRecords(
    old.filter((r) => r.chain !== chain || r.hash !== hash),
    items,
  );
}
export function mergeRecords(old, items) {
  const m = new Map(old.map((r) => [r.id, r]));
  for (let r of items) {
    const prev = m.get(r.id);
    if (prev?.spamDismissed) r = { ...r, spamDismissed: true };
    m.set(
      r.id,
      prev?.reviewed
        ? {
            ...r,
            kind: prev.kind,
            trader: prev.trader,
            reviewed: true,
            evidence: prev.evidence,
          }
        : r,
    );
  }
  return [...m.values()];
}
export function summarize(records, conflicts = []) {
  const m = new Map(),
    precision = new Map(),
    invalid = new Set();
  for (const r of records) {
    if (r.supersededBy || !["commission", "refund"].includes(r.kind)) continue;
    const key = r.chain + ":" + canonical(r.chain, r.asset);
    if (precision.has(key) && precision.get(key) !== r.decimals)
      invalid.add(key);
    else precision.set(key, r.decimals);
  }
  for (const key of invalid)
    conflicts.push({
      assetKey: key,
      reason: "同一代币存在精度冲突，已暂停此资产计账",
    });
  for (const r of records) {
    if (
      r.supersededBy ||
      invalid.has(r.chain + ":" + canonical(r.chain, r.asset)) ||
      !["commission", "refund"].includes(r.kind) ||
      !r.trader
    )
      continue;
    const trader = canonical(r.chain, r.trader),
      asset = canonical(r.chain, r.asset),
      key = [r.chain, asset, trader].join(":");
    if (!m.has(key))
      m.set(key, {
        key,
        chain: r.chain,
        asset,
        symbol: r.symbol,
        decimals: r.decimals,
        trader,
        due: 0n,
        paid: 0n,
        ids: [],
        hashes: new Set(),
      });
    const g = m.get(key);
    if (g.decimals !== r.decimals)
      throw Error("同一代币存在精度冲突，请核对数据源");
    g[r.kind === "commission" ? "due" : "paid"] += BigInt(r.raw);
    g.ids.push(r.id);
    g.hashes.add(r.hash);
  }
  return [...m.values()].map((g) => {
    let net = g.due - g.paid;
    return {
      ...g,
      hashes: [...g.hashes],
      due: g.due.toString(),
      paid: g.paid.toString(),
      remaining: (net > 0n ? net : 0n).toString(),
      excess: (net < 0n ? -net : 0n).toString(),
      status:
        net > 0n
          ? g.paid === 0n
            ? "unpaid"
            : "partial"
          : net < 0n
            ? "over"
            : "settled",
    };
  });
}
function decodeLegacyFeeLogs(
  logs,
  chain,
  tx,
  tokenMeta = {},
  trustedRouters = [],
) {
  if (tx.status !== "ok" && tx.status !== "success" && tx.status !== "0x1")
    return [];
  return logs.flatMap((l, i) => {
    const topic = l.topics?.[0]?.toLowerCase(),
      data = l.data?.toLowerCase().replace(/^0x/, "");
    if (
      !FEE_TOPICS.includes(topic) ||
      !data ||
      data.length !== (LEGACY_FEE_TOPICS.includes(topic) ? 192 : 256) ||
      l.removed
    )
      return [];
    const w = data.match(/.{64}/g);
    if (!/^0{24}[0-9a-f]{40}$/.test(w[0]) || !/^0{24}[0-9a-f]{40}$/.test(w[2]))
      return [];
    const recipient = "0x" + w[2].slice(-40);
    if (recipient !== EVM) return [];
    const token = "0x" + w[0].slice(-40),
      asset =
        token === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
          ? "native"
          : token,
      raw = BigInt("0x" + w[1]).toString();
    if (raw === "0") return [];
    const meta =
      asset === "native"
        ? { symbol: chain.symbol, decimals: chain.decimals }
        : tokenMeta[asset];
    if (!meta || meta.decimals == null)
      throw Error("返佣代币缺少精度，需补查代币元数据");
    const router = canonical(chain.id, l.address?.hash || l.address),
      trader = canonical(chain.id, tx.from?.hash || tx.from),
      to = canonical(chain.id, tx.to?.hash || tx.to);
    const trusted =
      trustedRouters.includes(router) &&
      router === to &&
      tx.from?.is_contract === false &&
      validAddress(chain.id, trader) &&
      trader !== router &&
      trader !== EVM &&
      trader !== "0x" + "0".repeat(40);
    const index = Number(l.index ?? l.logIndex ?? i);
    return [
      {
        id: `${chain.id}:${tx.hash}:fee:${index}`,
        chain: chain.id,
        asset,
        symbol: meta.symbol || asset,
        decimals: Number(meta.decimals),
        raw,
        hash: tx.hash,
        from: router,
        to: EVM,
        trader,
        direction: "in",
        kind: "pending",
        time: tx.timestamp || "",
        verified: trusted,
        attributionVerified: trusted,
        protocol: "legacy-router",
        roles: {
          router,
          transactionSender: trader,
          owner: trusted ? trader : "",
        },
        evidence: trusted
          ? "OKX 官方路由 + 成功交易返佣事件；归属交易发起人"
          : "检测到返佣事件，但路由或交易人需人工核对",
        feeEvent: true,
      },
    ];
  });
}
// Settlement ABI: CommissionFeePaid(bytes,address,address,uint256,uint256,uint256)
// and Trade(address,address,address,uint256,uint256,bytes). UID = digest + owner + validTo.
// Verified source: https://base.blockscout.com/address/0x25ed72c3f671b626810a6db597dcfd50f215a423?tab=contract
export const SETTLEMENT_FEE_TOPIC =
  "0x02b4603e6be0c4002f11c4445116c51a20adeecb33e1434306ec55378f75a099";
export const SETTLEMENT_TRADE_TOPIC =
  "0xd65443291bb59863c3ddfe64892356e9f0c3888a4c99efd97df5c028cb5db267";
const settlementAddress = "0x25ed72c3f671b626810a6db597dcfd50f215a423";
function settlementUID(data, offsetWord, headWords) {
  if (!/^0x[0-9a-f]+$/i.test(data || "")) return "";
  const words = data.slice(2).toLowerCase().match(/.{64}/g);
  if (
    data.length !== 2 + (headWords + 3) * 64 ||
    BigInt("0x" + words[offsetWord]) !== BigInt(headWords * 32) ||
    BigInt("0x" + words[headWords]) !== 56n
  )
    return "";
  const tail = words.slice(headWords + 1).join("");
  if (!/^0{16}$/.test(tail.slice(112))) return "";
  return tail.slice(0, 112);
}
export function settlementFeeAsset(log) {
  if (
    log.topics?.[0]?.toLowerCase() !== SETTLEMENT_FEE_TOPIC ||
    log.topics.length !== 3 ||
    log.removed
  )
    return "";
  if (!log.topics.slice(1).every((t) => /^0x0{24}[0-9a-f]{40}$/i.test(t)))
    return "";
  return log.topics[2].slice(-40).toLowerCase() === EVM.slice(2)
    ? "0x" + log.topics[1].slice(-40).toLowerCase()
    : "";
}
export function decodeFeeLogs(
  logs,
  chain,
  tx,
  tokenMeta = {},
  trustedRouters = [],
) {
  const legacy = decodeLegacyFeeLogs(
    logs,
    chain,
    tx,
    tokenMeta,
    trustedRouters,
  );
  if (
    !["ok", "success", "0x1"].includes(tx.status) ||
    !["56", "8453"].includes(chain.id)
  )
    return legacy;
  const atRouter = (l) =>
    canonical(chain.id, l.address?.hash || l.address) === settlementAddress &&
    !l.removed;
  const trades = new Map();
  for (const l of logs) {
    if (
      !atRouter(l) ||
      l.topics?.[0]?.toLowerCase() !== SETTLEMENT_TRADE_TOPIC ||
      l.topics.length !== 4 ||
      !l.topics.slice(1).every((t) => /^0x0{24}[0-9a-f]{40}$/i.test(t))
    )
      continue;
    const uid = settlementUID(l.data, 2, 3),
      owner = "0x" + l.topics[1].slice(-40).toLowerCase();
    if (
      uid &&
      owner === "0x" + uid.slice(64, 104) &&
      owner !== EVM &&
      owner !== settlementAddress &&
      owner !== "0x" + "0".repeat(40)
    )
      trades.set(uid, {
        owner,
        tokens: l.topics.slice(2).map((t) => "0x" + t.slice(-40).toLowerCase()),
      });
  }
  const fees = logs.flatMap((l, i) => {
    const token = settlementFeeAsset(l);
    if (!token || !atRouter(l)) return [];
    const uid = settlementUID(l.data, 0, 4);
    if (!uid) return [];
    const raw = BigInt("0x" + l.data.slice(130, 194)).toString();
    if (raw === "0") return [];
    const asset =
      token === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" ? "native" : token;
    const meta =
      asset === "native"
        ? { symbol: chain.symbol, decimals: chain.decimals }
        : tokenMeta[asset];
    if (meta?.decimals == null)
      throw Error("返佣代币缺少精度，需补查代币元数据");
    const trade = trades.get(uid),
      matched = !!trade && trade.tokens.includes(token);
    return [
      {
        id: `${chain.id}:${tx.hash}:fee:${Number(l.index ?? l.logIndex ?? i)}`,
        chain: chain.id,
        asset,
        symbol: meta.symbol || asset,
        decimals: Number(meta.decimals),
        raw,
        hash: tx.hash,
        from: settlementAddress,
        to: EVM,
        trader: matched ? trade.owner : "",
        txSender: canonical(chain.id, tx.from?.hash || tx.from),
        direction: "in",
        kind: "pending",
        time: tx.timestamp || "",
        feeEvent: true,
        protocol: "settlement",
        orderUid: uid,
        attributionVerified: matched,
        verified: matched,
        roles: {
          router: settlementAddress,
          transactionSender: canonical(chain.id, tx.from?.hash || tx.from),
          owner: matched ? trade.owner : "",
        },
        evidence: matched
          ? "Settlement 返佣事件与同订单 Trade.owner 一致；等待实际到账核验"
          : "Settlement 返佣事件缺少同订单交易凭证，不能归属合约或代执行者",
      },
    ];
  });
  return [...legacy, ...fees];
}
export function isDirectTokenTransfer(tx, row) {
  const input = tx.raw_input || tx.input || "";
  return (
    /^0xa9059cbb0{24}[0-9a-f]{40}[0-9a-f]{64}$/i.test(input) &&
    canonical(row.chain, tx.to?.hash || tx.to) === row.asset &&
    canonical(row.chain, tx.from?.hash || tx.from) === row.from &&
    "0x" + input.slice(34, 74).toLowerCase() === row.to &&
    BigInt("0x" + input.slice(74)).toString() === row.raw
  );
}
// Only direct, wallet-authorized payment calls are automatically offset. A token
// Transfer log by itself does not demonstrate the wallet authorized this payment.
export function paymentEvidence(tx, row) {
  const txSender = canonical(row.chain, tx.from?.hash || tx.from);
  const directTokenTransfer =
    row.asset !== "native" && isDirectTokenTransfer(tx, row);
  const input = tx.raw_input || tx.input || "0x";
  const directNative =
    row.asset === "native" &&
    canonical(row.chain, tx.to?.hash || tx.to) ===
      canonical(row.chain, row.to) &&
    txSender === canonical(row.chain, row.from) &&
    BigInt(tx.value || 0).toString() === row.raw &&
    /^(?:0x)?$/.test(input);
  return {
    txSender,
    directTokenTransfer,
    directTransfer: directTokenTransfer || directNative,
    paymentAuthorized:
      txSender === EVM && canonical(row.chain, row.from) === EVM,
  };
}
export function hasCommissionProof(r) {
  if (
    unavailableEvidence(r) ||
    r.direction !== "in" ||
    !validAddress(r.chain, r.trader || "") ||
    canonical(r.chain, r.to) !== (r.chain === "solana" ? SOL : EVM) ||
    canonical(r.chain, r.trader) === (r.chain === "solana" ? SOL : EVM)
  )
    return false;
  if (r.chain === "solana")
    return (
      r.solanaCommission === true &&
      r.attributionVerified === true &&
      r.ownerVerified === true &&
      r.attributionMethod === "okx-swap-v3-source-owner"
    );
  return (
    r.feeEvent === true &&
    r.attributionVerified === true &&
    r.receiptMatched === true &&
    ["legacy-router", "settlement"].includes(r.protocol)
  );
}
// Match only receipt transfers from the proved payer/router. Unrelated deposits
// remain pending; they cannot invalidate, or be borrowed to fund, another fee.
export function reconcileFeeReceipts(rows, feeRows) {
  const replace = [
    ...new Map(rows.filter((r) => !r.feeEvent).map((r) => [r.id, r])).values(),
  ].map((r) => {
    const next = { ...r };
    if (next.supersededBy) {
      if (!next.reviewed) next.kind = "pending";
      delete next.supersededBy;
    }
    return next;
  });
  const fees = [...new Map(feeRows.map((f) => [f.id, f])).values()].map((f) => {
    const next = { ...f, kind: "ignore" };
    delete next.receiptMatched;
    return next;
  });
  const groups = new Map();
  for (const f of fees) {
    if (
      !f.attributionVerified ||
      !["legacy-router", "settlement"].includes(f.protocol)
    ) {
      f.evidence = "返佣事件缺少可信协议与最终归属证明，不计入账目";
      continue;
    }
    const key = [
      f.chain,
      f.hash,
      f.asset,
      f.from,
      f.protocol === "settlement" ? "" : f.trader,
    ].join(":");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const consumed = new Set();
  const bind = (rs, fs) => {
    for (const f of fs) {
      f.receiptMatched = true;
      f.kind = "commission";
      f.matchedReceiptIds = rs.map((r) => r.id);
    }
    for (const r of rs) {
      consumed.add(r.id);
      r.kind = "ignore";
      r.supersededBy = fs.map((f) => f.id);
      r.evidence = "已由同笔、同资产的已验证返佣事件计入，不重复计算到账流水";
    }
  };
  for (const fs of groups.values()) {
    const sample = fs[0],
      senders = new Set(
        fs
          .flatMap((f) =>
            f.protocol === "settlement" ? [f.from] : [f.from, f.trader],
          )
          .map((a) => canonical(sample.chain, a)),
      );
    const rs = replace.filter(
      (r) =>
        !consumed.has(r.id) &&
        !r.feeEvent &&
        r.direction === "in" &&
        r.kind !== "ignore" &&
        r.chain === sample.chain &&
        r.hash === sample.hash &&
        canonical(r.chain, r.asset) === canonical(sample.chain, sample.asset) &&
        canonical(r.chain, r.to) === EVM &&
        senders.has(canonical(r.chain, r.from)),
    );
    const total = fs.reduce((n, f) => n + BigInt(f.raw), 0n),
      sum = rs.reduce((n, r) => n + BigInt(r.raw), 0n);
    if (total > 0n && sum === total) {
      bind(rs, fs);
      continue;
    }
    const combined = rs.find((r) => BigInt(r.raw) === total);
    if (combined) {
      bind([combined], fs);
      continue;
    }
    // Exact individual payments can be matched without a subset-sum guess. An
    // ambiguous split remains pending, while unrelated extra payments stay visible.
    for (const f of fs) {
      const r = rs.find(
        (r) => !consumed.has(r.id) && BigInt(r.raw) === BigInt(f.raw),
      );
      if (r) bind([r], [f]);
      else f.evidence = "返佣事件尚无可独立匹配的实际到账；相关流水保留待核对";
    }
  }
  return { replace, fees };
}
export function blockscoutRows(items, stream, chain) {
  return items.flatMap((x, i) => {
    if (
      (x.status && !["ok", "success"].includes(x.status)) ||
      x.success === false ||
      x.error
    )
      return [];
    if (stream === "token-transfers" && x.token?.type !== "ERC-20") return [];
    const from = canonical(chain.id, x.from?.hash),
      to = canonical(chain.id, x.to?.hash);
    if (from === to || (from !== EVM && to !== EVM)) return [];
    const raw = String(
      stream === "token-transfers" ? (x.total?.value ?? "0") : (x.value ?? "0"),
    );
    if (!/^\d+$/.test(raw) || BigInt(raw) === 0n) return [];
    if (stream !== "transactions" && x.log_index == null && x.index == null)
      throw Error("转账缺少稳定索引，无法安全去重");
    const hash = x.transaction_hash || x.hash,
      decimals =
        stream === "token-transfers" ? x.token?.decimals : chain.decimals;
    if (decimals == null) throw Error("代币缺少精度，不能安全计账");
    return [
      {
        id: `${chain.id}:${hash}:${stream}:${stream === "transactions" ? 0 : (x.log_index ?? x.index ?? i)}`,
        chain: chain.id,
        asset:
          stream === "token-transfers"
            ? canonical(chain.id, x.token.address_hash)
            : "native",
        symbol:
          stream === "token-transfers"
            ? x.token.symbol || x.token.address_hash
            : chain.symbol,
        decimals: Number(decimals),
        raw,
        hash,
        from,
        to,
        trader: from === EVM ? to : "",
        direction: from === EVM ? "out" : "in",
        kind: "pending",
        time: x.timestamp || "",
        stream,
        sourceSpam: x.token?.reputation === "scam" || x.token?.is_scam === true,
        evidence:
          from === EVM
            ? "链上转出；请确认是否属于手动返还"
            : "链上转入；等待返佣事件与归属核对",
      },
    ];
  });
}
export function parseSolanaTransaction(tx, signature) {
  if (!tx || !tx.meta) throw Error("Solana 交易详情不可用，历史扫描不完整");
  if (tx.meta.err) return [];
  const keys = tx.transaction.message.accountKeys.map((k) =>
    typeof k === "string" ? k : k.pubkey,
  );
  const owner = new Map(),
    mint = new Map(),
    decimals = new Map();
  for (const b of [
    ...(tx.meta.preTokenBalances || []),
    ...(tx.meta.postTokenBalances || []),
  ]) {
    owner.set(keys[b.accountIndex], b.owner);
    mint.set(keys[b.accountIndex], b.mint);
    decimals.set(b.mint, b.uiTokenAmount.decimals);
  }
  const instructions = [];
  for (const [i, x] of tx.transaction.message.instructions.entries()) {
    instructions.push([`${i}`, x]);
    for (const [j, y] of (
      tx.meta.innerInstructions?.find((v) => v.index === i)?.instructions || []
    ).entries())
      instructions.push([`${i}.${j}`, y]);
  }
  const rows = instructions.flatMap(([path, x]) => {
    const p = x.parsed;
    if (
      !p ||
      !["transfer", "transferChecked", "transferCheckedWithFee"].includes(
        p.type,
      )
    )
      return [];
    const info = p.info;
    let from = info.source,
      to = info.destination,
      asset,
      symbol,
      d,
      raw;
    if (x.program === "system") {
      asset = "native";
      symbol = "SOL";
      d = 9;
      raw = String(info.lamports);
    } else if (["spl-token", "spl-token-2022"].includes(x.program)) {
      asset = info.mint || mint.get(info.source) || mint.get(info.destination);
      if (!asset) return [];
      from = owner.get(info.source) || info.authority;
      to = owner.get(info.destination);
      d = info.tokenAmount?.decimals ?? decimals.get(asset);
      raw = String(info.tokenAmount?.amount ?? info.amount);
      symbol =
        asset === "So11111111111111111111111111111111111111112"
          ? "WSOL"
          : asset === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
            ? "USDC"
            : asset === "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
              ? "USDT"
              : asset.slice(0, 6) + "…";
      if (p.type === "transferCheckedWithFee")
        raw = (
          BigInt(raw) - BigInt(info.feeAmount?.amount ?? info.feeAmount ?? 0)
        ).toString();
    } else return [];
    if (from === to || (from !== SOL && to !== SOL)) return [];
    if (d == null || !/^\d+$/.test(raw))
      throw Error("Solana 转账精度或金额缺失");
    if (BigInt(raw) === 0n) return [];
    return [
      {
        id: `solana:${signature}:ix:${path}`,
        chain: "solana",
        asset,
        symbol,
        decimals: Number(d),
        raw,
        hash: signature,
        from: from || "",
        to: to || "",
        trader: from === SOL ? to : from,
        direction: from === SOL ? "out" : "in",
        kind: "pending",
        time: tx.blockTime
          ? new Date(Number(tx.blockTime) * 1000).toISOString()
          : "",
        evidence:
          from === SOL
            ? "Solana 成功转出；请确认返还用途"
            : "Solana 精确转入；转账来源不一定是被邀请人，请核对归属",
      },
    ];
  });
  return classifySolanaRows(tx, rows, SOL);
}

// Address is the outer grouping. Assets never offset a different chain/contract.
export function byAddress(groups) {
  const m = new Map();
  for (const g of groups) {
    const k = (g.chain === "solana" ? "sol:" : "evm:") + g.trader;
    if (!m.has(k)) m.set(k, { address: g.trader, assets: [], recordCount: 0 });
    const a = m.get(k);
    a.assets.push(g);
    a.recordCount += g.ids.length;
  }
  return [...m.values()]
    .map((a) => ({
      ...a,
      owedAssets: a.assets.filter((g) =>
        ["unpaid", "partial"].includes(g.status),
      ).length,
    }))
    .sort(
      (a, b) =>
        b.owedAssets - a.owedAssets || a.address.localeCompare(b.address),
    );
}

// Automatic accounting requested by the owner. Preserve raw history and any
// previous explicit decisions; never treat an arbitrary deposit as a referral.
// Reports identify assets by chain and full contract / mint, never ticker text.
export const REPORTED_SPAM_ASSETS = new Set([
  "56:0x8f0aa047622b72e71615bab186c2d97985c886bd",
  "42161:0xa693e56e496a13658ab9e3efafa7e13e846a8780",
  "10:0xcd4ea8bd757f8e431923ae64b7ce98bcb7d08392",
  "solana:AWs2J3buZeyvvSE5pyoFVJQUNKa36g8sbouskt6W9fre",
]);
export function autoAccount(records, decisions = {}, options = {}) {
  const whitelist = allowlistEnabled();
  records = manualReceiptProjection(records, decisions);
  const byId = new Map(records.map((r) => [r.id, r]));
  const rows = records.map((r) => {
    const copy = { ...r };
    delete copy.needsProof;
    if (
      !r.reviewed &&
      ((r.kind === "commission" && !hasCommissionProof(r)) ||
        (r.kind === "refund" &&
          !(
            r.paymentAuthorized &&
            r.directTransfer &&
            canonical(r.chain, r.txSender) ===
              (r.chain === "solana" ? SOL : EVM)
          )))
    )
      copy.needsProof = true;
    delete copy.spam;
    delete copy.spamReason;
    delete copy.needsReview;
    if (copy.whitelistKind) {
      copy.kind = copy.whitelistKind;
      delete copy.whitelistKind;
    }
    // Old automatic outcomes are never authority for the next calculation.
    if (
      !copy.reviewed &&
      (copy.automatic || ["commission", "refund"].includes(copy.kind))
    ) {
      copy.kind = "pending";
      delete copy.automatic;
    }
    if (copy.autoExcluded && !copy.reviewed && !copy.supersededBy) {
      copy.kind = "pending";
      delete copy.autoExcluded;
    }
    if (unavailableEvidence(copy)) {
      copy.kind = "pending";
      delete copy.supersededBy;
      delete copy.reviewed;
      delete copy.automatic;
      delete copy.autoExcluded;
      delete copy.spamDismissed;
    }
    // A backup decision cannot authenticate its underlying amount or owner.
    // Retain it separately, but apply it only after the transfer itself is rechecked.
    const candidate = decisions[copy.id];
    const decision =
      unavailableEvidence(copy) ||
      copy.manualSuppressed ||
      !decisionMatchesDirection(copy, candidate)
        ? null
        : candidate;
    const bookable = canBookManual(copy, byId);
    if (copy.canonicalMissing)
      copy.manualBlocked = "交易所在区块尚未通过核验，暂不能计账";
    else if (copy.metadataError)
      copy.manualBlocked = "代币精度尚未核验，暂不能计账";
    if (copy.feeEvent && !bookable)
      copy.manualBlocked ||= "返佣事件尚未匹配真实到账，不能人工计入金额";
    if (
      decision &&
      ["commission", "refund", "ignore", "pending"].includes(decision.kind)
    ) {
      const trader = canonical(copy.chain, decision.trader || "");
      if (
        !["commission", "refund"].includes(decision.kind) ||
        (bookable &&
          validAddress(copy.chain, trader) &&
          trader !== (copy.chain === "solana" ? SOL : EVM))
      ) {
        copy.kind = decision.kind;
        copy.trader = trader;
        copy.reviewed = true;
        copy.reviewReason = String(decision.reason || "人工判断");
        copy.evidence = copy.reviewReason;
        copy.spamDismissed = !!decision.keep;
      }
    }
    if (!assetAllowed(copy.chain, copy.asset)) {
      copy.whitelistKind = copy.kind;
      copy.kind = "pending";
      copy.spam = true;
      copy.spamReason = revokedAsset(copy.chain, copy.asset)
        ? "已撤销信任的假 USDbC 合约；不属于官方桥接 USDbC"
        : "合约 / Mint 不在当前网络白名单";
      copy.needsReview = true;
    }
    return copy;
  });
  for (const r of rows) {
    if (
      r.chain === "solana" &&
      r.direction === "in" &&
      r.asset === "native" &&
      BigInt(r.raw) > 0n &&
      BigInt(r.raw) <= 1n &&
      !r.spamDismissed &&
      !unavailableEvidence(r)
    ) {
      r.kind = "pending";
      r.spam = true;
      r.spamReason = "1 lamport SOL 微量转入（dusting）";
      r.needsReview = true;
      continue;
    }
    if (
      r.chain === "solana" &&
      r.solanaSelfSwap &&
      !unavailableEvidence(r) &&
      !r.spam &&
      !r.reviewed
    ) {
      r.kind = "ignore";
      r.trader = "";
      r.autoExcluded = true;
      r.exclusionReason = "本钱包自己的 swap，非返佣 / 返还";
    }
    if (
      unavailableEvidence(r) ||
      r.manualSuppressed ||
      r.spam ||
      r.supersededBy ||
      r.reviewed ||
      r.kind !== "pending"
    )
      continue;
    if (
      !whitelist &&
      !r.spamDismissed &&
      REPORTED_SPAM_ASSETS.has(r.chain + ":" + canonical(r.chain, r.asset))
    )
      continue;
    if (hasCommissionProof(r)) {
      r.kind = "commission";
      r.automatic = true;
      r.evidence =
        r.chain === "solana"
          ? "OKX SwapV3 指定返佣账户实际到账，归属签名用户"
          : r.protocol === "settlement"
            ? "Settlement 返佣事件、订单持有人与实际到账一致"
            : "官方路由返佣事件、直接交易发起人与实际到账一致";
    }
  }
  if (options.phase === "commission") return rows;
  return finalizeAccounting(rows);
}
export function accountingContext(rows) {
  const commissions = rows.filter(
    (r) => !r.spam && !r.supersededBy && r.kind === "commission",
  );
  const assetKey = (r) => r.chain + ":" + canonical(r.chain, r.asset);
  const relationships = new Set(
    commissions.map((r) => assetKey(r) + ":" + canonical(r.chain, r.trader)),
  );
  const knownAssets = new Set(commissions.map(assetKey));
  const fragments = new Map();
  if (!allowlistEnabled())
    for (const r of commissions) {
      if (r.chain === "solana") continue;
      const address = canonical(r.chain, r.trader),
        key = address.slice(0, 6) + address.slice(-4);
      if (!fragments.has(key)) fragments.set(key, new Set());
      fragments.get(key).add(address);
    }
  return { relationships, knownAssets, fragments };
}
export function finalizeAccounting(input, context) {
  const whitelist = allowlistEnabled();
  const rows = input.map((r) => (r.kind === "pending" ? { ...r } : r));
  const { relationships, knownAssets, fragments } =
    context || accountingContext(rows);
  const assetKey = (r) => r.chain + ":" + canonical(r.chain, r.asset);
  for (const r of rows) {
    if (
      unavailableEvidence(r) ||
      r.manualSuppressed ||
      r.spam ||
      r.supersededBy ||
      r.reviewed ||
      r.kind !== "pending"
    )
      continue;
    const own = r.chain === "solana" ? SOL : EVM,
      recipient = canonical(r.chain, r.to);
    if (!whitelist && !r.spamDismissed && r.asset !== "native") {
      const similar =
        r.chain !== "solana"
          ? fragments.get(recipient.slice(0, 6) + recipient.slice(-4))
          : null;
      const lookalike =
        !!similar && (similar.size > 1 || !similar.has(recipient));
      if (
        REPORTED_SPAM_ASSETS.has(assetKey(r)) ||
        (!unavailableEvidence(r) && r.sourceSpam) ||
        (!knownAssets.has(assetKey(r)) && r.direction === "out" && lookalike)
      ) {
        r.spam = true;
        r.spamReason = REPORTED_SPAM_ASSETS.has(assetKey(r))
          ? "案例报告标记为疑似钓鱼资产（按网络与完整合约 / Mint 匹配）"
          : r.sourceSpam
            ? "数据源标记为可疑代币 / 垃圾记录"
            : "合约未匹配返佣资产，且收款地址仿似已知被邀请地址";
        r.needsReview = true;
        continue;
      }
    }
    if (
      r.direction === "out" &&
      canonical(r.chain, r.from) === own &&
      relationships.has(assetKey(r) + ":" + recipient) &&
      !unavailableEvidence(r) &&
      r.paymentAuthorized === true &&
      r.directTransfer === true &&
      canonical(r.chain, r.txSender) === own
    ) {
      r.kind = "refund";
      r.trader = recipient;
      r.automatic = true;
      r.evidence =
        "本钱包签名的直接转账，支付给已确认被邀请地址的同网络、同资产；可人工改为其他用途";
    } else {
      r.kind = "pending";
      r.needsReview = true;
      r.reviewReason = r.inspectionError
        ? "凭证核验失败：" + r.inspectionError
        : r.direction === "out"
          ? !r.paymentAuthorized || !r.directTransfer
            ? "尚未证实为本钱包授权的直接付款；协议调用或代授权转出需人工确认用途"
            : "地址、网络或合约尚未匹配返佣"
          : "未识别到可归属的返佣凭证";
    }
  }
  for (const r of rows)
    if (
      r.kind === "pending" &&
      !r.reviewed &&
      !r.spamDismissed &&
      !unavailableEvidence(r) &&
      !r.feeEvent &&
      !r.supersededBy &&
      r.chain === "8453" &&
      r.direction === "in" &&
      r.directTokenTransfer &&
      fixedUsdPrice(r.chain, r.asset) &&
      Number.isInteger(r.decimals) &&
      r.decimals >= 0 &&
      r.decimals <= 36 &&
      BigInt(r.raw) > 0n &&
      BigInt(r.raw) * 1000n < 10n ** BigInt(r.decimals)
    ) {
      r.spam = true;
      r.spamReason = "Base 稳定币直接微额转入 < 0.001 USD（dusting）";
      r.needsReview = true;
    }
  return rows;
}

export function configureWallets(evm, sol) {
  if ((evm && !validAddress("1", evm)) || (sol && !validAddress("solana", sol)))
    throw Error("钱包地址格式错误");
  EVM = (evm || "").toLowerCase();
  SOL = sol || "";
}

export function pendingReview(records, decisions) {
  return autoAccount(records, decisions).filter(
    (r) =>
      r.kind === "pending" && !r.spam && !r.supersededBy && BigInt(r.raw) > 0n,
  );
}

export function spamRecords(records, decisions) {
  return autoAccount(records, decisions).filter(
    (r) => r.spam && !r.supersededBy && BigInt(r.raw) > 0n,
  );
}
