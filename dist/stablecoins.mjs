import { ASSET_BY_ID } from "./asset-registry.mjs";
// Labels and user-added whitelist entries cannot grant a fixed accounting price.
export function fixedUsdPrice(chain, asset, now = Date.now()) {
  const identity =
    chain + ":" + (chain === "solana" ? asset : asset?.toLowerCase());
  const policy = ASSET_BY_ID.get(identity);
  return policy?.fixedUsd
    ? {
        usd: policy.fixedUsd,
        at: now,
        source: "固定记账价 · " + policy.fixedUsd + " USD",
        fixed: true,
      }
    : null;
}
