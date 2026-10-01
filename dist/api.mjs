import {
  paymentEvidence,
  reconcileFeeReceipts,
  settlementFeeAsset,
  EVM,
  SOL,
  FEE_TOPICS,
  canonical,
  safeJSON,
  blockscoutRows,
  decodeFeeLogs,
  parseSolanaTransaction,
} from "./ledger.mjs";
import {
  abortableDelay,
  providerName,
  noteRequest,
  retryAfterMs,
  waitForProvider,
  boundedResponseText,
} from "./network.mjs";
import { cachedEvidence, evidenceKey } from "./evidence-cache.mjs";
const delay = abortableDelay;
let blockscoutStart = Promise.resolve(),
  lastBlockscoutStart = 0;
export async function request(url, options = {}, signal, policy = {}) {
  const provider = providerName(url),
    key = policy.cache === false ? null : evidenceKey(url, options);
  return cachedEvidence(
    key,
    async () => {
      const deadline = AbortSignal.timeout(policy.deadlineMs ?? 90000),
        combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
      const attempts = policy.attempts ?? 3;
      for (let i = 0; i < attempts; i++) {
        if (combined.aborted)
          throw Error(
            signal?.aborted ? "已暂停" : "查询总时限已到；可重试失败项",
          );
        await waitForProvider(provider, combined);
        let response;
        const started = Date.now();
        noteRequest(provider, "requests");
        try {
          response = await fetch(url, {
            ...options,
            signal: AbortSignal.any([
              combined,
              AbortSignal.timeout(policy.timeoutMs ?? 25000),
            ]),
            cache: "no-store",
            referrerPolicy: "no-referrer",
          });
        } catch {
          noteRequest(provider, "errors");
          if (combined.aborted)
            throw Error(
              signal?.aborted ? "已暂停" : "查询总时限已到；可重试失败项",
            );
          if (i === attempts - 1)
            throw Error("网络连接失败或超时；数据尚未完整");
          noteRequest(provider, "retries");
          await delay(Math.min(800 * 2 ** i, 8000), combined);
          continue;
        } finally {
          noteRequest(provider, "elapsedMs", Date.now() - started);
        }
        let detail = "";
        if (!response.ok && String(url).startsWith("/api/"))
          try {
            detail = (await response.clone().json()).message || "";
          } catch {}
        if (response.status === 429 || response.status >= 500) {
          noteRequest(provider, "errors");
          if (i === attempts - 1)
            throw Error(
              detail ||
                `数据源限流或暂不可用（${response.status}），可稍后继续`,
            );
          noteRequest(provider, "retries");
          await delay(
            Math.min(
              15000,
              retryAfterMs(response.headers.get("retry-after")) || 800 * 2 ** i,
            ),
            combined,
          );
          continue;
        }
        if (!response.ok) {
          noteRequest(provider, "errors");
          throw Error(
            detail ||
              (response.status === 401 || response.status === 403
                ? "API Key 无效、额度不足或尚未开通此接口"
                : `数据源返回 HTTP ${response.status}`),
          );
        }
        const { text, bytes } = await boundedResponseText(response);
        noteRequest(provider, "bytes", bytes);
        let data;
        try {
          data = safeJSON(text);
        } catch {
          throw Error("数据源返回了非 JSON 响应");
        }
        if (data.error) {
          noteRequest(provider, "errors");
          if (
            i < attempts - 1 &&
            /rate limit|too many requests|requests per second/i.test(
              String(data.error.message || ""),
            )
          ) {
            noteRequest(provider, "retries");
            await delay(Math.min(800 * 2 ** i, 8000), combined);
            continue;
          }
          let msg = String(data.error.message || data.error).slice(0, 300);
          const u = new URL(url, "https://ledger.local");
          for (const secret of [
            ...u.searchParams.values(),
            u.pathname.split("/").at(-1),
          ])
            if (secret && secret.length > 8)
              msg = msg.split(secret).join("[已隐藏]");
          throw Error(`数据源错误 ${data.error.code || ""}：${msg}`);
        }
        return data;
      }
      throw Error("查询失败");
    },
    () => noteRequest(provider, "cacheHits"),
  );
}
export async function bs(chain, path, key, params = {}, signal) {
  if (!key) throw Error("请先填写 Blockscout API Key");
  const turn = blockscoutStart.then(async () => {
    const wait = 260 - (Date.now() - lastBlockscoutStart);
    if (wait > 0) await delay(wait, signal);
    if (signal?.aborted) throw Error("已暂停");
    lastBlockscoutStart = Date.now();
  });
  blockscoutStart = turn.catch(() => {});
  await turn;
  return request(
    "/api/blockscout",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chain, path, key, params }),
    },
    signal,
  );
}
async function pages(chain, path, key, signal) {
  let cursor = null,
    items = [],
    seen = new Set();
  do {
    const data = await bs(chain, path, key, cursor || {}, signal);
    if (!Array.isArray(data.items)) throw Error("分页响应缺少 items");
    items.push(...data.items);
    cursor = data.next_page_params;
    const c = JSON.stringify(cursor);
    if (cursor && seen.has(c))
      throw Error("分页游标重复，停止以免遗漏或重复计算");
    seen.add(c);
  } while (cursor);
  return items;
}
export async function scanEVM(
  chain,
  key,
  routers,
  onPage,
  onProgress,
  signal,
  start = {},
) {
  for (const stream of [
    "transactions",
    "internal-transactions",
    "token-transfers",
  ]) {
    const saved = { ...start[stream] };
    if (saved.complete) continue;
    let cursor = saved.cursor || null,
      highBlock = saved.highBlock ?? null,
      seen = new Set();
    do {
      onProgress(
        `${chain.name} · ${saved.stopBlock != null ? "增量" : "历史"} · ${stream}`,
      );
      const data = await bs(
        chain.id,
        `addresses/${EVM}/${stream}`,
        key,
        cursor || {},
        signal,
      );
      if (!Array.isArray(data.items)) throw Error("地址历史响应格式不正确");
      const height = (x) => Number(x.block_number ?? x.block);
      if (saved.stopBlock == null && saved.anchors?.length) {
        const anchor = data.items.find(
          (x) =>
            saved.anchors.includes(x.transaction_hash || x.hash) &&
            Number.isSafeInteger(height(x)),
        );
        if (anchor) saved.stopBlock = Math.max(0, height(anchor) - 64);
      }
      const heights = data.items.map(height).filter(Number.isSafeInteger);
      if (heights.length) highBlock = Math.max(highBlock ?? 0, ...heights);
      const reached =
        saved.stopBlock != null &&
        data.items.some(
          (x) => Number.isSafeInteger(height(x)) && height(x) < saved.stopBlock,
        );
      const items = data.items.filter(
        (x) =>
          saved.stopBlock == null ||
          !Number.isSafeInteger(height(x)) ||
          height(x) >= saved.stopBlock,
      );
      const rows = blockscoutRows(items, stream, chain);
      cursor = reached ? null : data.next_page_params;
      await onPage(rows, {
        stream,
        cursor,
        complete: !cursor,
        highBlock,
        stopBlock: saved.stopBlock ?? null,
        anchors: saved.anchors || [],
      });
      const c = JSON.stringify(cursor);
      if (cursor && seen.has(c)) throw Error("分页未前进，历史尚未完整");
      seen.add(c);
    } while (cursor);
  }
  return;
}
export async function inspectEVM(chain, hash, key, routers, rows, signal) {
  rows = rows.filter((r) => !r.feeEvent);
  const tx = await bs(chain.id, `transactions/${hash}`, key, {}, signal);
  if (canonical(chain.id, tx.hash) !== canonical(chain.id, hash))
    throw Error("数据源返回了其他交易，核验已停止");
  if (["error", "failed", "reverted"].includes(tx.status))
    return { replace: [], fees: [] };
  if (!["ok", "success"].includes(tx.status) || !tx.from?.hash)
    throw Error("交易尚未成功确认或详情不完整");
  tx.from.is_contract ??= true;
  if (!rows.length || rows.some((r) => r.importedUnverified)) {
    const [tokens, internal] = await Promise.all([
      pages(chain.id, `transactions/${hash}/token-transfers`, key, signal),
      pages(
        chain.id,
        `transactions/${hash}/internal-transactions`,
        key,
        signal,
      ),
    ]);
    rows = [
      ...blockscoutRows([tx], "transactions", chain),
      ...blockscoutRows(tokens, "token-transfers", chain),
      ...blockscoutRows(internal, "internal-transactions", chain),
    ];
    if (
      rows.some(
        (r) => canonical(chain.id, r.hash) !== canonical(chain.id, hash),
      )
    )
      throw Error("交易流水与请求哈希不一致，核验已停止");
  }
  const incoming = rows.some((r) => r.direction === "in"),
    logs = incoming
      ? await pages(chain.id, `transactions/${hash}/logs`, key, signal)
      : [];
  const tokenMeta = {};
  for (const r of rows)
    tokenMeta[r.asset] = { symbol: r.symbol, decimals: r.decimals };
  for (const l of logs) {
    if (
      !l.data ||
      ![194, 258].includes(l.data.length) ||
      "0x" + l.data.slice(154, 194).toLowerCase() !== EVM
    )
      continue;
    const token = "0x" + l.data.slice(26, 66).toLowerCase();
    if (
      !["0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"].includes(token) &&
      !tokenMeta[token] &&
      l.topics?.some((t) => FEE_TOPICS.includes(t))
    ) {
      const m = await bs(chain.id, `tokens/${token}`, key, {}, signal);
      tokenMeta[token] = m;
    }
  }
  for (const l of logs) {
    const asset = settlementFeeAsset(l);
    if (
      asset &&
      asset !== "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" &&
      !tokenMeta[asset]
    )
      tokenMeta[asset] = await bs(chain.id, `tokens/${asset}`, key, {}, signal);
  }
  const fees = decodeFeeLogs(
    logs,
    chain,
    tx,
    tokenMeta,
    routers[chain.id] || [],
  );
  const replace = rows.map((r) => {
    const next = { ...r, ...paymentEvidence(tx, r) };
    delete next.inspectionError;
    delete next.importedUnverified;
    if (next.supersededBy && !next.reviewed) {
      next.kind = "pending";
      delete next.supersededBy;
    }
    if (r.direction === "in" && !r.trader)
      next.trader = canonical(chain.id, tx.from?.hash);
    if (
      r.stream === "internal-transactions" &&
      r.asset === "native" &&
      r.from === canonical(chain.id, tx.from?.hash) &&
      r.to === canonical(chain.id, tx.to?.hash) &&
      r.raw === String(tx.value) &&
      Number(r.id.split(":").at(-1)) === 0
    ) {
      next.kind = "ignore";
      next.evidence = "顶层原生币转账重复表示，已去重";
    }
    return next;
  });
  return reconcileFeeReceipts(replace, fees);
}
export async function scanSolana(key, onPage, onProgress, signal, start = {}) {
  if (start.complete) return;
  if (!key) throw Error("请先填写 Helius API Key");
  let before = start.cursor,
    headSignature = start.headSignature || null,
    seen = new Set();
  do {
    onProgress("Solana · SOL / SPL / Token-2022 历史（含代币账户）");
    const u = new URL(
      `https://api.helius.xyz/v0/addresses/${SOL}/transactions`,
    );
    u.searchParams.set("api-key", key);
    u.searchParams.set("limit", "10");
    u.searchParams.set("token-accounts", "balanceChanged");
    u.searchParams.set("commitment", "finalized");
    if (before) u.searchParams.set("before-signature", before);
    const data = await request(u, {}, signal);
    if (!Array.isArray(data)) throw Error("Helius 历史格式错误");
    if (!before && data.length) headSignature = data[0].signature;
    const stop = start.until
      ? data.findIndex((x) => x.signature === start.until)
      : -1;
    const fresh = stop < 0 ? data : data.slice(0, stop);
    const rows = [];
    for (const item of fresh) {
      if (item.transactionError) continue;
      const rpc = await request(
        `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getTransaction",
            params: [
              item.signature,
              {
                encoding: "jsonParsed",
                commitment: "finalized",
                maxSupportedTransactionVersion: 0,
              },
            ],
          }),
        },
        signal,
      );
      const parsed = parseSolanaTransaction(rpc.result, item.signature);
      for (const r of parsed) {
        r.suggestedTrader = item.feePayer;
        r.source = item.source || "UNKNOWN";
      }
      rows.push(...parsed);
    }
    before = data.length ? data.at(-1).signature : null;
    await onPage(rows, {
      stream: "solana",
      cursor: before,
      complete: data.length === 0 || stop >= 0,
      headSignature,
      until: start.until || null,
    });
    if (data.length === 0 || stop >= 0) break;
    if (seen.has(before)) throw Error("Solana 分页未前进");
    seen.add(before);
  } while (before);
}

export async function inspectSolana(signature, key, signal) {
  const rpc = await request(
    `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [
          signature,
          {
            encoding: "jsonParsed",
            commitment: "finalized",
            maxSupportedTransactionVersion: 0,
          },
        ],
      }),
    },
    signal,
  );
  const rows = parseSolanaTransaction(rpc.result, signature);
  // Proven router transfers need no extra paid enhanced-parser lookup.
  if (
    rows.length &&
    rows.every(
      (r) =>
        r.solanaCommission ||
        r.solanaSelfSwap ||
        (r.asset === "native" && r.direction === "in" && r.raw === "1"),
    )
  )
    return rows;
  const enhanced = await request(
    `https://api.helius.xyz/v0/transactions?api-key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactions: [signature] }),
    },
    signal,
  );
  const item = enhanced?.find?.((t) => t.signature === signature);
  if (!item) throw Error("Helius 未返回此交易的解析详情");
  return rows.map((r) => ({
    ...r,
    suggestedTrader: item.feePayer,
    source: item.source || "UNKNOWN",
  }));
}
