// Shared cancellation, bounded work and non-sensitive local diagnostics.
const metrics = new Map();
export function noteRequest(provider, field, amount = 1) {
  const row = metrics.get(provider) || {
    requests: 0,
    errors: 0,
    retries: 0,
    cacheHits: 0,
    bytes: 0,
    elapsedMs: 0,
  };
  row[field] = (row[field] || 0) + amount;
  metrics.set(provider, row);
}
export function networkDiagnostics() {
  return Object.fromEntries([...metrics].map(([k, v]) => [k, { ...v }]));
}
export function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || Error("已暂停"));
    const stop = () => {
        clearTimeout(timer);
        reject(signal.reason || Error("已暂停"));
      },
      timer = setTimeout(
        () => {
          signal?.removeEventListener("abort", stop);
          resolve();
        },
        Math.max(0, ms),
      );
    signal?.addEventListener("abort", stop, { once: true });
  });
}
export async function mapLimit(items, limit, fn) {
  let cursor = 0;
  const output = new Array(items.length);
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        output[i] = await fn(items[i], i);
      }
    }),
  );
  return output;
}
export function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}
export function providerName(url) {
  const u = new URL(String(url), "https://ledger.local");
  if (u.pathname.startsWith("/api/")) return u.pathname.slice(5);
  if (u.hostname.includes("helius")) return "helius";
  if (u.hostname.includes("nodereal")) return "nodereal";
  if (u.hostname.includes("etherscan")) return "etherscan";
  return u.hostname;
}
const starts = new Map(),
  lastStart = new Map();
export async function waitForProvider(provider, signal) {
  const interval =
    { helius: 120, nodereal: 250, etherscan: 600, linea: 100 }[provider] || 0;
  if (!interval) return;
  const turn = (starts.get(provider) || Promise.resolve()).then(async () => {
    await abortableDelay(
      Math.max(0, interval - (Date.now() - (lastStart.get(provider) || 0))),
      signal,
    );
    lastStart.set(provider, Date.now());
  });
  starts.set(
    provider,
    turn.catch(() => {}),
  );
  await turn;
}
export async function boundedResponseText(
  response,
  maxBytes = 20 * 1024 * 1024,
) {
  if (!response.body?.getReader) {
    const text = await response.text(),
      bytes = new TextEncoder().encode(text).length;
    if (bytes > maxBytes) throw Error("数据源响应过大，请缩小查询范围");
    return { text, bytes };
  }
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let bytes = 0,
    text = "";
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw Error("数据源响应过大，请缩小查询范围");
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return { text, bytes };
  } finally {
    reader.releaseLock();
  }
}
