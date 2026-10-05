import { awaitWithSignal } from "./network.mjs";
// Public, immutable-query responses only. API keys/credentials never enter keys or values.
const memory = new Map(),
  inFlight = new Map();
let memoryBytes = 0;
let database,
  forceRefresh = false,
  enabled =
    typeof window !== "undefined" || typeof WorkerGlobalScope !== "undefined";
const MAX_ENTRIES = 1000,
  MAX_BYTES = 16 * 1024 * 1024,
  MAX_ITEM = 1024 * 1024,
  TTL = 6 * 60 * 60 * 1000;
export function configureEvidenceCache({ force = false, active = true } = {}) {
  forceRefresh = force;
  enabled = active;
}
export function evidenceKey(url, options = {}) {
  let body;
  try {
    body = JSON.parse(options.body || "null");
  } catch {
    return null;
  }
  if (!body) return null;
  const u = new URL(String(url), "https://ledger.local");
  if (
    u.pathname === "/api/blockscout" &&
    /^transactions\/0x[0-9a-f]{64}(?:\/(?:logs|token-transfers|internal-transactions))?$/i.test(
      body.path || "",
    )
  )
    return JSON.stringify([
      "blockscout",
      String(body.chain),
      body.path,
      body.params || {},
    ]);
  if (
    u.hostname === "api.helius.xyz" &&
    u.pathname === "/v0/transactions" &&
    Array.isArray(body.transactions) &&
    body.transactions.every((x) => /^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(x))
  )
    return JSON.stringify(["solana-enhanced", body.transactions]);
  const { method, params } = body;
  if (!Array.isArray(params)) return null;
  const historical =
    [
      "eth_getTransactionByHash",
      "eth_getTransactionReceipt",
      "eth_getBlockByHash",
    ].includes(method) ||
    (["eth_getCode", "eth_call"].includes(method) &&
      /^0x[0-9a-f]+$/i.test(params[1] || "")) ||
    (method === "getTransaction" && params[1]?.commitment === "finalized") ||
    (method === "nr_getAssetTransfers" &&
      /^0x[0-9a-f]{64}$/i.test(params[0]?.transactionHash || ""));
  if (!historical) return null;
  const chain =
    u.pathname === "/api/linea"
      ? "linea"
      : u.hostname.includes("helius")
        ? "solana"
        : u.hostname.includes("nodereal")
          ? "bsc"
          : u.origin;
  return JSON.stringify([chain, method, params]);
}
async function db() {
  if (typeof indexedDB === "undefined") return null;
  return (database ||= new Promise((resolve) => {
    const r = indexedDB.open("rebate-public-evidence", 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (d.objectStoreNames.contains("responses"))
        d.deleteObjectStore("responses");
      const responses = d.createObjectStore("responses");
      responses.createIndex("at", "at");
      if (!d.objectStoreNames.contains("meta")) d.createObjectStore("meta");
      r.transaction.objectStore("meta").put({ count: 0, bytes: 0 }, "size");
    };
    r.onsuccess = () => {
      r.result.onversionchange = () => {
        r.result.close();
        database = null;
      };
      resolve(r.result);
    };
    r.onerror = r.onblocked = () => { database = null; resolve(null); };
  }));
}
function forget(key) {
  const prior = memory.get(key);
  if (prior) memoryBytes -= prior.bytes;
  memory.delete(key);
}
function remember(key, entry) {
  forget(key);
  memory.set(key, entry);
  memoryBytes += entry.bytes;
  for (const [oldKey] of memory) {
    if (memory.size <= MAX_ENTRIES && memoryBytes <= MAX_BYTES) break;
    forget(oldKey);
  }
}
async function cacheWait(value, signal) {
  const budget = AbortSignal.timeout(1000);
  try { return await awaitWithSignal(value, signal ? AbortSignal.any([signal,budget]) : budget); }
  catch (error) { if (signal?.aborted) throw error; return null; }
}
export async function getEvidence(key, { signal, bypass = false } = {}) {
  if (signal?.aborted) throw signal.reason || Error("已暂停");
  if (!enabled || !key || forceRefresh || bypass) return null;
  let entry = memory.get(key);
  if (!entry) {
    const d = await cacheWait(db(), signal);
    if (d) entry = await cacheWait(new Promise(resolve => {
      try {
        const t = d.transaction("responses"), r = t.objectStore("responses").get(key);
        r.onsuccess = () => resolve(r.result || null);
        r.onerror = t.onabort = () => resolve(null);
      } catch { resolve(null); }
    }), signal);
  }
  if (!entry || !Number.isFinite(entry.bytes) || Date.now() - entry.at > TTL) {
    forget(key);
    return null;
  }
  remember(key, entry);
  return structuredClone(entry.value);
}
export async function putEvidence(key, value, {signal} = {}) {
  if (
    !enabled ||
    !key ||
    value?.error ||
    value?.result === null ||
    value?.result?.blockHash === null ||
    value?.status === "pending"
  )
    return;
  let text;
  try {
    const query = JSON.parse(key);
    if (
      query[0] === "blockscout" &&
      (query[2].split("/").length === 2
        ? !value?.hash
        : !Array.isArray(value?.items))
    )
      return;
    if (
      query[0] === "solana-enhanced" &&
      (!Array.isArray(value) || !value.length)
    )
      return;
    if (
      /^(eth_|getTransaction$|nr_)/.test(query[1] || "") &&
      !Object.hasOwn(value || {}, "result")
    )
      return;
  } catch {}
  try {
    text = JSON.stringify(value);
  } catch {
    return;
  }
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_ITEM) return;
  const entry = { value: structuredClone(value), bytes, at: Date.now() };
  remember(key, entry);
  const d = await cacheWait(db(), signal);
  if (!d) return;
  await cacheWait(new Promise((resolve) => {
    const t = d.transaction(["responses", "meta"], "readwrite"),
      s = t.objectStore("responses"),
      meta = t.objectStore("meta"),
      old = s.get(key),
      size = meta.get("size");
    let ready = 0;
    const update = () => {
      if (++ready !== 2) return;
      const totals = size.result || { count: 0, bytes: 0 };
      totals.count += old.result ? 0 : 1;
      totals.bytes += bytes - (old.result?.bytes || 0);
      s.put(entry, key);
      const cursor = s.index("at").openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (
          c &&
          (totals.count > MAX_ENTRIES ||
            totals.bytes > MAX_BYTES ||
            Date.now() - c.value.at > TTL)
        ) {
          totals.count--;
          totals.bytes -= c.value.bytes;
          c.delete();
          c.continue();
          return;
        }
        meta.put(totals, "size");
      };
    };
    old.onsuccess = size.onsuccess = update;
    t.oncomplete = t.onerror = t.onabort = resolve;
  }), signal);
}
export async function cachedEvidence(key, load, onHit = () => {}, options = {}) {
  const {signal, bypass = false} = options;
  const found = await getEvidence(key, options);
  if (found) { onHit(); return found; }
  if (key && !bypass && !forceRefresh && inFlight.has(key)) {
    onHit();
    return structuredClone(await awaitWithSignal(inFlight.get(key), signal));
  }
  const task = (async () => {
    const value = await load();
    await putEvidence(key, value, {signal});
    return value;
  })();
  if (key) inFlight.set(key, task);
  try { return await task; }
  finally { if (key && inFlight.get(key) === task) inFlight.delete(key); }
}
export async function clearEvidenceCache() {
  memory.clear();
  memoryBytes = 0;
  const d = await db();
  if (d)
    await new Promise((resolve) => {
      const t = d.transaction(["responses", "meta"], "readwrite");
      t.objectStore("responses").clear();
      t.objectStore("meta").put({ count: 0, bytes: 0 }, "size");
      t.oncomplete = t.onerror = t.onabort = resolve;
    });
}
export function evidenceDiagnostics() {
  return {
    memoryEntries: memory.size,
    memoryBytes,
    maxEntries: MAX_ENTRIES,
    maxBytes: MAX_BYTES,
    ttlMs: TTL,
  };
}
