import { configureWallets } from "./ledger.mjs";
import { inspectEVM, inspectSolana } from "./api.mjs";
import { inspectExtended } from "./extended-api.mjs";
import { inspectXLayer } from "./xlayer-api.mjs";
import { configureEvidenceCache } from "./evidence-cache.mjs";
import { networkDiagnostics } from "./network.mjs";
let current;
const providerFor = (job) =>
  job.chain.id === "solana" ? "helius" : job.chain.provider || "blockscout";
function finishIfReady() {
  const run = current;
  if (!run || run.active || run.queue.length) return;
  if (!run.ended && !run.controller.signal.aborted) {
    if (!run.requested) {
      run.requested = true;
      self.postMessage({ type: "need-jobs" });
    }
    return;
  }
  self.postMessage({
    type: "done",
    aborted: run.controller.signal.aborted,
    diagnostics: networkDiagnostics(),
  });
  current = null;
}
function pump() {
  const run = current;
  if (!run) return;
  if (run.controller.signal.aborted) {
    run.queue = [];
    return finishIfReady();
  }
  for (let i = 0; i < run.queue.length; ) {
    const job = run.queue[i],
      provider = providerFor(job),
      limit = provider === "blockscout" ? 3 : 1;
    if ((run.byProvider[provider] || 0) >= limit) {
      i++;
      continue;
    }
    run.queue.splice(i, 1);
    run.active++;
    run.byProvider[provider] = (run.byProvider[provider] || 0) + 1;
    (async () => {
      const { chain, hash, rows } = job,
        key = run.keys[provider],
        signal = run.controller.signal;
      let result;
      try {
        if (provider === "helius")
          result = await inspectSolana(hash, key, signal);
        else if (provider === "blockscout") {
          const r = await inspectEVM(
            chain,
            hash,
            key,
            run.routers,
            rows,
            signal,
          );
          result = [...r.replace, ...r.fees];
        } else
          result = await (
            provider === "xlayer" ? inspectXLayer : inspectExtended
          )(chain, hash, key, run.routers, signal);
        self.postMessage({
          type: "result",
          key: job.key,
          fingerprint: job.fingerprint,
          chain: chain.id,
          hash,
          rows: result,
        });
      } catch (e) {
        if (!signal.aborted)
          self.postMessage({
            type: "result",
            key: job.key,
            fingerprint: job.fingerprint,
            chain: chain.id,
            hash,
            error: e.message,
          });
      } finally {
        run.active--;
        run.byProvider[provider]--;
        if (current === run) {
          pump();
          finishIfReady();
        }
      }
    })();
  }
  finishIfReady();
}
self.onmessage = ({ data }) => {
  if (data.type === "cancel") {
    if (current) {
      current.controller.abort();
      current.ended = true;
      current.queue = [];
      finishIfReady();
    }
    return;
  }
  if (data.type === "append") {
    if (current && !current.ended) {
      current.requested = false;
      current.queue.push(...(data.jobs || []));
      pump();
    }
    return;
  }
  if (data.type === "end") {
    if (current) {
      current.ended = true;
      finishIfReady();
    }
    return;
  }
  if (data.type !== "start" || current) return;
  try {
    configureWallets(data.wallets.evm, data.wallets.sol);
    configureEvidenceCache({ force: !!data.forceRefresh });
    current = {
      controller: new AbortController(),
      queue: [...(data.jobs || [])],
      active: 0,
      byProvider: {},
      ended: !data.streaming,
      keys: data.keys,
      routers: data.routers,
    };
    pump();
  } catch (e) {
    self.postMessage({ type: "fatal", error: e.message });
    current = null;
  }
};
