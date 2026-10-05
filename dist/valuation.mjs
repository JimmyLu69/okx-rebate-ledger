import { fixedUsdPrice } from "./stablecoins.mjs";
// Decimal arithmetic: no rounding across the settlement boundary.
export function decimal(value) {
  const m = String(value).match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
  if (!m) throw Error("无效金额");
  let digits = m[1] + (m[2] || ""),
    scale = (m[2] || "").length - Number(m[3] || 0);
  if (Math.abs(scale) > 100) throw Error("精度过大");
  if (scale < 0) {
    digits += "0".repeat(-scale);
    scale = 0;
  }
  return { n: BigInt(digits), scale };
}
function addDecimal(a, b) {
  const scale = Math.max(a.scale, b.scale);
  return {
    n:
      a.n * 10n ** BigInt(scale - a.scale) +
      b.n * 10n ** BigInt(scale - b.scale),
    scale,
  };
}
function compareDecimal(a, b) {
  const scale = Math.max(a.scale, b.scale);
  const x = a.n * 10n ** BigInt(scale - a.scale),
    y = b.n * 10n ** BigInt(scale - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}
function asNumber(v) {
  return Number(v.n) / 10 ** v.scale;
}
export function valueGroups(groups, prices, settings = {}, now = Date.now()) {
  const threshold = decimal(settings.threshold ?? "0.1");
  return groups.map((g) => {
    const p =
      fixedUsdPrice(g.chain, g.asset, now) || prices[g.chain + ":" + g.asset];
    const fresh =
      p && Number(p.usd) > 0 && now - p.at < 15 * 60e3 && p.at <= now + 60000;
    const exactStatus = g.status;
    if (!fresh) return { ...g, exactStatus, priced: false };
    const price = decimal(p.usd),
      net = BigInt(g.due) - BigInt(g.paid),
      abs = net < 0n ? -net : net;
    const withinTolerance =
      settings.enabled !== false &&
      abs > 0n &&
      abs * price.n * 10n ** BigInt(threshold.scale) <
        threshold.n * 10n ** BigInt(g.decimals + price.scale);
    const exact = (raw) => ({
      n: BigInt(raw) * price.n,
      scale: g.decimals + price.scale,
    });
    const usd = (raw) => asNumber(exact(raw));
    const exactUsd = {
      due: exact(g.due),
      paid: exact(g.paid),
      remaining: exact(withinTolerance ? 0 : g.remaining),
      excess: exact(withinTolerance ? 0 : g.excess),
    };
    return {
      ...g,
      exactStatus,
      status: withinTolerance ? "settled" : g.status,
      withinTolerance,
      priced: true,
      price: p,
      exactUsd,
      usdDue: usd(g.due),
      usdPaid: usd(g.paid),
      usdRemaining: usd(g.remaining),
      usdExcess: usd(g.excess),
      usdActionable: withinTolerance ? 0 : usd(g.remaining),
      usdActionableExcess: withinTolerance ? 0 : usd(g.excess),
      usdDifference: usd(abs),
    };
  });
}
export function addressTotals(groups) {
  const totals = new Map();
  for (const g of groups) {
    const key = (g.chain === "solana" ? "sol:" : "evm:") + g.trader;
    const a = totals.get(key) || {
      due: 0,
      paid: 0,
      remaining: 0,
      excess: 0,
      missing: 0,
    };
    if (!a.exact)
      Object.defineProperty(a, "exact", {
        value: {
          due: decimal("0"),
          paid: decimal("0"),
          remaining: decimal("0"),
          excess: decimal("0"),
        },
      });
    if (!g.priced) a.missing++;
    else {
      const fallback = {
        due: g.usdDue,
        paid: g.usdPaid,
        remaining: g.usdActionable ?? g.usdRemaining,
        excess: g.usdActionableExcess ?? g.usdExcess,
      };
      for (const field of ["due", "paid", "remaining", "excess"]) {
        a.exact[field] = addDecimal(
          a.exact[field],
          g.exactUsd?.[field] || decimal(fallback[field] || 0),
        );
        a[field] = asNumber(a.exact[field]);
      }
    }
    totals.set(key, a);
  }
  return totals;
}
export function filterMinimum(groups, minimum, field = "due") {
  const totals = addressTotals(groups),
    min = decimal(minimum === "" || minimum == null ? "0" : minimum);
  if (!["due", "paid", "remaining", "excess"].includes(field)) field = "due";
  return groups.filter((g) => {
    const a = totals.get((g.chain === "solana" ? "sol:" : "evm:") + g.trader);
    return (
      min.n === 0n || a.missing > 0 || compareDecimal(a.exact[field], min) >= 0
    );
  });
}
