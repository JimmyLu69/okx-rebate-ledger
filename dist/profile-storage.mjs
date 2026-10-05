import { readHistory, writeHistories, releaseHistory, protectHistory, readRawHistory, listHistoryRecoveries, readRecoveryHistory } from "./storage.mjs";
import { validateState } from "./validation.mjs";

export const profileKey = ({ evm = "", sol = "" }) => `rebate-ledger-wallet:${evm}:${sol}`;
export const accountKeys = ({ evm = "", sol = "" }) => [
  ...(evm ? [{ key: `rebate-ledger-account:evm:${evm}`, sol: false }] : []),
  ...(sol ? [{ key: `rebate-ledger-account:sol:${sol}`, sol: true }] : []),
];
const empty = () => ({ version: 1, records: [], decisions: {}, coverage: {}, selected: [], updated: null, decoderVersion: 4 });
export function partitionHistory(state, sol) {
  const records = state.records.filter(row => (row.chain === "solana") === sol), ids = new Set(records.map(row => row.id));
  return { ...state, records,
    decisions: Object.fromEntries(Object.entries(state.decisions || {}).filter(([id]) => ids.has(id))),
    coverage: Object.fromEntries(Object.entries(state.coverage || {}).filter(([chain]) => (chain === "solana") === sol)),
    selected: (state.selected || []).filter(chain => (chain === "solana") === sol),
    ...(state.lastRecheck ? { lastRecheck: { ...state.lastRecheck, entries: state.lastRecheck.entries.filter(row => (row.chain === "solana") === sol) } } : {}),
  };
}
export function mergeAccounts(parts) {
  if (!parts.some(Boolean)) return null;
  const merged = empty(), reports = [];
  for (const part of parts.filter(Boolean)) {
    for (const row of part.records) merged.records.push(row);
    Object.assign(merged.decisions, part.decisions);
    Object.assign(merged.coverage, part.coverage);
    merged.selected.push(...(part.selected || []));
    if ((part.updated || "") > (merged.updated || "")) merged.updated = part.updated;
    if (part.decoderVersion !== 4) merged.decoderVersion = part.decoderVersion || 0;
    if (part.migrationPending) merged.migrationPending = true;
    if (part.lastRecheck) reports.push(part.lastRecheck);
  }
  merged.selected = [...new Set(merged.selected)];
  if (reports.length) {
    const latest = reports.sort((a,b) => b.started.localeCompare(a.started))[0];
    merged.lastRecheck = { ...latest, entries: reports.filter(r => r.started === latest.started).flatMap(r => r.entries) };
  }
  return merged;
}
export async function readProfile(wallets, fallback = null) {
  const slots = accountKeys(wallets), parts = [];
  let legacy;
  try {
    for (const slot of slots) {
      const pair = slot.sol ? { evm: "", sol: wallets.sol } : { evm: wallets.evm, sol: "" };
      const saved = await readHistory(slot.key, { validate: value => validateState(value, { trustEvidence: true, wallets: pair }) });
      parts.push(saved);
    }
    if (parts.some(p => !p) || !slots.length) {
      legacy = await readHistory(profileKey(wallets), { validate: value => validateState(value, { trustEvidence: true, wallets }) });
      if (!legacy && fallback) legacy = validateState(fallback, { trustEvidence: true, wallets });
      for (let i = 0; i < slots.length; i++) if (!parts[i] && legacy) parts[i] = partitionHistory(legacy, slots[i].sol);
    }
    // Legacy pair snapshots are recovery copies, never active write baselines.
    // Release their in-memory duplicate after splitting into account views.
    releaseHistory(profileKey(wallets));
    return slots.length ? mergeAccounts(parts) : legacy || null;
  } catch (error) {
    for (const slot of slots) protectHistory(slot.key, error);
    protectHistory(profileKey(wallets), error);
    throw error;
  }
}
export async function writeProfile(wallets, state, options) {
  const result = await writeHistories(accountKeys(wallets).map(slot => [slot.key, partitionHistory(state, slot.sol)]), options);
  releaseHistory(profileKey(wallets));
  return result;
}
export function releaseProfile(previous, current) {
  const active = new Set(accountKeys(current).map(slot => slot.key));
  for (const slot of accountKeys(previous)) if (!active.has(slot.key)) releaseHistory(slot.key);
  if (profileKey(previous) !== profileKey(current)) releaseHistory(profileKey(previous));
}
export async function exportRawProfile(wallets) {
  const keys = [...accountKeys(wallets).map(slot => slot.key), profileKey(wallets)];
  const snapshots = [];
  for (const key of keys) {
    const recovery = [];
    for (const archive of await listHistoryRecoveries(key)) recovery.push({ ...archive, state: await readRecoveryHistory(archive.id) });
    snapshots.push({ key, state: await readRawHistory(key), recovery });
  }
  return { format: "rebate-recovery", version: 1, wallets, createdAt: new Date().toISOString(), snapshots };
}
