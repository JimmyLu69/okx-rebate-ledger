import { scanEVM, inspectEVM, scanSolana, inspectSolana } from "./api.mjs";
import { scanLinea, scanBSC, inspectExtended } from "./extended-api.mjs";
import { scanXLayer, inspectXLayer } from "./xlayer-api.mjs";
import { incrementalStreams } from "./history.mjs";
import { providerFor } from "./catalog.mjs";
import { configureEvidenceCache } from "./evidence-cache.mjs";

export class RecordIndex {
  constructor(records = []) {
    this.rows = new Map();
    this.transactions = new Map();
    this.merge(records);
  }
  merge(records) {
    for (const row of records) {
      const old = this.rows.get(row.id);
      if (old && (old.chain !== row.chain || old.hash !== row.hash))
        this.transactions.get(old.chain + ":" + old.hash)?.delete(row.id);
      this.rows.set(row.id, row);
      const key = row.chain + ":" + row.hash;
      if (!this.transactions.has(key)) this.transactions.set(key, new Set());
      this.transactions.get(key).add(row.id);
    }
  }
  transaction(chain, hash) {
    return [...(this.transactions.get(chain + ":" + hash) || [])]
      .map((id) => this.rows.get(id))
      .filter(Boolean);
  }
  replace(chain, hash, records) {
    if (
      records.some((r) => r.chain !== chain || r.hash !== hash) ||
      new Set(records.map((r) => r.id)).size !== records.length
    )
      throw Error("核验返回了不匹配的交易记录，原数据保留");
    const key = chain + ":" + hash;
    for (const id of this.transactions.get(key) || []) this.rows.delete(id);
    this.transactions.delete(key);
    this.merge(records);
  }
  values() {
    return [...this.rows.values()];
  }
}

export async function runSync({
  state,
  ids,
  chains,
  keys,
  routers,
  wallets,
  signal: parentSignal,
  onProgress,
  onChange,
  onCheckpoint,
  scanOptions = {},
  force = false,
}) {
  const cancellation = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, cancellation.signal])
    : cancellation.signal;
  let fatalError;
  const stopAll = (error) => {
    fatalError ||= error;
    cancellation.abort(fatalError);
  };
  const checkCancelled = () => {
    if (signal.aborted) throw signal.reason || Error("已暂停");
  };
  configureEvidenceCache({ force, active: true });
  const index = new RecordIndex(state.records);
  let changed = 0,
    lastFlush = 0;
  const flush = async (forceSave = false) => {
    if (fatalError) throw fatalError;
    try {
      if (changed) {
        state.records = index.values();
        state.updated = new Date().toISOString();
        changed = 0;
        onChange();
      }
      if (forceSave || Date.now() - lastFlush > 2500) {
        lastFlush = Date.now();
        await onCheckpoint();
      }
    } catch (error) {
      stopAll(error);
      throw error;
    }
  };
  const chainBy = (id) => chains.find((c) => c.id === id);
  const providerGroups = Object.groupBy(ids, (id) => providerFor(chainBy(id)));
  const errors = [];
  async function runChain(id) {
    if (signal.aborted) return;
    const chain = chainBy(id),
      provider = providerFor(chain),
      key = keys[provider];
    let cov = state.coverage[id] || { streams: {}, inspected: [] };
    if (cov.status === "complete")
      cov = {
        ...cov,
        streams: incrementalStreams(
          cov.streams,
          state.records.filter((r) => r.chain === id),
        ),
      };
    cov.streams ||= {};
    cov.inspectionErrors ||= {};
    cov.inspected ||= [];
    cov.status = "running";
    cov.error = "";
    state.coverage[id] = cov;
    const inspected = new Set(cov.inspected);
    const checkpoint = async () => {
      cov.inspected = [...inspected];
      await flush(true);
    };
    async function verify(hash) {
      if (signal.aborted) throw Error("已暂停");
      onProgress(`${chain.name} · 核验交易 ${inspected.size.toLocaleString()}`);
      try {
        let rows;
        if (provider === "helius")
          rows = await inspectSolana(hash, key, signal);
        else if (provider === "blockscout") {
          const result = await inspectEVM(
            chain,
            hash,
            key,
            routers,
            index.transaction(id, hash),
            signal,
          );
          rows = [...result.replace, ...result.fees];
        } else
          rows = await (
            provider === "xlayer" ? inspectXLayer : inspectExtended
          )(chain, hash, key, routers, signal);
        checkCancelled();
        // A successful receipt replaces every prior machine-derived row for this tx.
        index.replace(id, hash, rows);
        inspected.add(hash);
        delete cov.inspectionErrors[hash];
        changed++;
      } catch (error) {
        if (signal.aborted) throw error;
        cov.inspectionErrors[hash] = error.message;
        inspected.delete(hash);
        index.merge(
          index
            .transaction(id, hash)
            .map((r) => ({ ...r, inspectionError: error.message })),
        );
        changed++;
      }
      if (changed >= 10 || Date.now() - lastFlush > 2500) await checkpoint();
    }
    const onPage = async (rows, position) => {
      checkCancelled();
      const newRows = rows.filter(
        (r) => !index.rows.has(r.id) || index.rows.get(r.id).importedUnverified,
      );
      if (provider === "helius") {
        // scanSolana returns complete parsed transactions, not one log stream.
        // Replace each full transaction so disappeared machine rows are removed.
        const transactions = new Map();
        for (const row of rows) {
          if (!transactions.has(row.hash)) transactions.set(row.hash, []);
          transactions.get(row.hash).push(row);
        }
        for (const [hash, parsed] of transactions) {
          index.replace(id, hash, parsed);
          inspected.add(hash);
          delete cov.inspectionErrors[hash];
          changed++;
        }
      } else if (newRows.length) {
        index.merge(newRows);
        changed++;
      }
      if (provider === "blockscout")
        for (const row of newRows) inspected.delete(row.hash);
      if (chain.provider)
        for (const hash of new Set(rows.map((r) => r.hash)))
          if (!inspected.has(hash)) await verify(hash);
      cov.streams[position.stream] = position;
      await checkpoint();
    };
    try {
      if (id === "solana") {
        await scanSolana(
          key,
          onPage,
          onProgress,
          signal,
          cov.streams.solana || {},
        );
        const hashes = [...index.transactions.keys()]
          .filter((k) => k.startsWith("solana:"))
          .map((k) => k.slice(7));
        for (const hash of hashes) if (!inspected.has(hash)) await verify(hash);
      } else {
        for (const hash of Object.keys(cov.inspectionErrors))
          await verify(hash);
        if (chain.provider) {
          const scanner = {
            nodereal: scanBSC,
            etherscan: scanLinea,
            xlayer: scanXLayer,
          }[provider];
          await scanner(
            chain,
            key,
            onPage,
            onProgress,
            signal,
            cov.streams,
            scanOptions[id] || {},
          );
        } else
          await scanEVM(
            chain,
            key,
            routers,
            onPage,
            onProgress,
            signal,
            cov.streams,
          );
        const hashes = [...index.transactions.keys()]
          .filter((k) => k.startsWith(id + ":"))
          .map((k) => k.slice(id.length + 1));
        for (const hash of hashes) if (!inspected.has(hash)) await verify(hash);
      }
      if (Object.keys(cov.inspectionErrors).length)
        throw Error(
          `${Object.keys(cov.inspectionErrors).length} 笔未通过核验：${Object.values(cov.inspectionErrors)[0]}`,
        );
      cov.status = "complete";
      cov.updated = new Date().toISOString();
    } catch (error) {
      if (fatalError) {
        cov.status = "error";
        cov.error = "本机保存失败：" + fatalError.message;
        throw fatalError;
      }
      cov.status = signal.aborted ? "paused" : "error";
      cov.error = signal.aborted ? "已暂停，检查点已保存" : error.message;
      errors.push(id);
    }
    await checkpoint();
  }
  const lanes = Object.entries(providerGroups).map(async ([provider, list]) => {
    try {
      // One provider has one quota lane; Blockscout also limits individual requests.
      for (const id of list) {
        if (signal.aborted) break;
        await runChain(id);
      }
    } catch (error) {
      stopAll(error);
      throw error;
    }
  });
  try {
    // A rejected checkpoint cancels every lane immediately, but we wait for all
    // in-flight work to stop before the UI may unlock or switch wallet state.
    await Promise.allSettled(lanes);
    if (fatalError) throw fatalError;
    await flush(true);
  } finally {
    configureEvidenceCache({ force: false, active: true });
  }
  return { errors, aborted: signal.aborted };
}
