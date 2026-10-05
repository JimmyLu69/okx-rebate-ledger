import { configureWallets } from "./ledger.mjs";
import { inspectEVM, inspectSolana } from "./api.mjs";
import { inspectExtended } from "./extended-api.mjs";
import { inspectXLayer } from "./xlayer-api.mjs";
import { configureEvidenceCache } from "./evidence-cache.mjs";
import { networkDiagnostics } from "./network.mjs";
let current;
const providerFor = (job) =>
  job.chain.id === "solana" ? "helius" : job.chain.provider || "blockscout";
const MAX_BUFFERED = 60, LOW_WATER = 15;
function finishIfReady() {
  const run = current;
  if (!run) return;
  const buffered = run.active + run.queue.length;
  if (!run.ended && !run.controller.signal.aborted && buffered <= LOW_WATER && !run.requested) {
    run.requested = true;
    run.credit = Math.min(30, MAX_BUFFERED - buffered);
    self.postMessage({type:"need-jobs",credit:run.credit,queued:run.queue.length,active:run.active});
  }
  if (buffered || (!run.ended && !run.controller.signal.aborted)) return;
  clearInterval(run.diagnosticTimer);
  self.postMessage({type:"done",aborted:run.controller.signal.aborted,diagnostics:networkDiagnostics()});
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
      const jobs = data.jobs || [];
      if (!Array.isArray(jobs) || jobs.length > (current.credit || 30) || current.queue.length + current.active + jobs.length > MAX_BUFFERED) {
        self.postMessage({type:"fatal",error:"核验队列超过上限"});
        current.controller.abort();current.ended=true;current.queue=[];finishIfReady();return;
      }
      current.requested = false;
      current.credit = 0;
      current.queue.push(...jobs);
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
    if (!Array.isArray(data.jobs || []) || (data.jobs || []).length > MAX_BUFFERED) throw Error("核验队列超过上限");
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
    current.diagnosticTimer = setInterval(() => {
      if (current) self.postMessage({type:"diagnostics",diagnostics:networkDiagnostics()});
    }, 1000);
    pump();
  } catch (e) {
    self.postMessage({ type: "fatal", error: e.message });
    current = null;
  }
};
