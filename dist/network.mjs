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
// Await storage/cache operations with the same cancellation boundary as network.
export function awaitWithSignal(value, signal) {
  if (!signal) return Promise.resolve(value);
  if (signal.aborted) return Promise.reject(signal.reason || Error("已暂停"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || Error("已暂停"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export async function mapLimit(items, limit, fn) {
  let cursor = 0, failure;
  const output = new Array(items.length);
  await Promise.allSettled(Array.from({length:Math.min(Math.max(1,limit),items.length)}, async()=> {
    while (!failure) {
      const i=cursor++; if(i>=items.length) return;
      try { output[i]=await fn(items[i],i); }
      catch(error) { failure ||= error; }
    }
  }));
  if(failure) throw failure;
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
let budgetDB;
async function sharedBudget(signal) {
  if (typeof indexedDB === "undefined") return null;
  const pending = budgetDB ||= new Promise(resolve => {
    const request = indexedDB.open("rebate-network-budget", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("starts");
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); budgetDB = null; };
      resolve(request.result);
    };
    request.onerror = request.onblocked = () => { budgetDB = null; resolve(null); };
  });
  try { return await awaitWithSignal(pending, AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(1000)])); }
  catch (error) { if (signal?.aborted) throw error; return null; }
}
export async function waitForProvider(provider, signal) {
  const interval = {blockscout:260,helius:120,nodereal:250,etherscan:600,linea:100}[provider] || 0;
  if (!interval) return;
  const reserve = async () => {
    let d, previous = lastStart.get(provider) || 0;
    if (globalThis.navigator?.locks) {
      d = await sharedBudget(signal);
      if (d) {
        const at = await awaitWithSignal(new Promise(resolve => {
          try { const r=d.transaction("starts").objectStore("starts").get(provider); r.onsuccess=()=>resolve(r.result); r.onerror=()=>resolve(0); }
          catch { resolve(0); }
        }), signal);
        previous = Math.max(previous, Number(at) || 0);
      }
    }
    await abortableDelay(Math.max(0, interval - (Date.now() - previous)), signal);
    const now = Date.now(); lastStart.set(provider, now);
    if (d) await awaitWithSignal(new Promise(resolve => {
      try { const t=d.transaction("starts","readwrite");t.objectStore("starts").put(now,provider);t.oncomplete=t.onerror=t.onabort=resolve; }
      catch { resolve(); }
    }), signal);
  };
  const turn = (starts.get(provider) || Promise.resolve()).then(() =>
    globalThis.navigator?.locks
      ? navigator.locks.request("rebate-provider:"+provider, {signal}, reserve)
      : reserve());
  starts.set(provider, turn.catch(() => {}));
  await awaitWithSignal(turn, signal);
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
