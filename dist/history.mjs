import {
  validateState,
  validateHistoryBackup,
  validateWallets,
} from "./validation.mjs";
// Finished scans retain their checkpoints. Only completed streams open a new window.
export function incrementalStreams(streams = {}, records = []) {
  return Object.fromEntries(
    Object.entries(streams).map(([name, p]) => {
      if (!p?.complete) return [name, { ...p }];
      if (name === "solana") {
        const head =
          p.headSignature ||
          records
            .filter((r) => r.chain === "solana" && r.time)
            .sort((a, b) => b.time.localeCompare(a.time))[0]?.hash ||
          null;
        return [name, { complete: false, until: head, headSignature: head }];
      }
      if (
        ["transactions", "internal-transactions", "token-transfers"].includes(
          name,
        )
      )
        return [
          name,
          {
            complete: false,
            stopBlock: Number.isSafeInteger(p.highBlock)
              ? Math.max(0, p.highBlock - 64)
              : null,
            highBlock: p.highBlock ?? null,
            anchors: Number.isSafeInteger(p.highBlock)
              ? []
              : records
                  .filter((r) => r.stream === name)
                  .sort((a, b) => (b.time || "").localeCompare(a.time || ""))
                  .slice(0, 50)
                  .map((r) => r.hash),
          },
        ];
      if (Number.isSafeInteger(p.endBlock))
        return [
          name,
          {
            complete: false,
            minBlock: p.endBlock + 1,
            count: p.count,
            fullRange: p.fullRange,
          },
        ];
      return [name, {}];
    }),
  );
}
export function historyBackup(state, wallets) {
  const pair = validateWallets(wallets);
  return {
    format: "rebate-history",
    backupVersion: 2,
    createdAt: new Date().toISOString(),
    wallets: pair,
    state: validateState(state, { wallets: pair }),
  };
}
export function restoreHistory(data, wallets, validateRecord) {
  if (data?.format === "rebate-history")
    return validateHistoryBackup(data, { wallets }).state;
  const records = Array.isArray(data) ? data : data?.records;
  if (!Array.isArray(records) || records.length > 100000)
    throw Error("历史文件缺少 records 或超过十万笔");
  if (validateRecord) for (const row of records) validateRecord(row);
  return validateState(
    { version: 1, records, coverage: {}, selected: [], updated: null },
    { wallets, trustEvidence: false },
  );
}
