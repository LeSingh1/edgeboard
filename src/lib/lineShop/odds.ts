/**
 * Price math for line shopping.
 *
 * A sportsbook quotes both sides of an over/under with a built-in margin
 * ("vig"): e.g. Over +113 / Under −130. Converting each price to an implied
 * probability gives 46.9% + 56.5% = 103.4% — the extra 3.4% is the book's cut.
 * Removing it ("devigging") recovers the book's actual opinion:
 *   Under = 56.5 / 103.4 = 54.6%,  Over = 45.4%.
 * The side the book charges MORE to bet (the more negative number) is the side
 * it thinks is more likely. That's the signal this tab bets on.
 */

/** American odds → implied probability (vig included). */
export function americanToProb(american: number): number {
  if (!Number.isFinite(american) || american === 0) return NaN;
  return american < 0 ? -american / (-american + 100) : 100 / (american + 100);
}

/** Probability → American odds (for display of a fair price). */
export function probToAmerican(p: number): number {
  if (!(p > 0 && p < 1)) return NaN;
  return p >= 0.5 ? -Math.round((p / (1 - p)) * 100) : Math.round(((1 - p) / p) * 100);
}

/** Multiplicative devig of a two-way market. Returns fair P(over). */
export function devigTwoWay(overAmerican: number, underAmerican: number): number | null {
  const po = americanToProb(overAmerican);
  const pu = americanToProb(underAmerican);
  if (!Number.isFinite(po) || !Number.isFinite(pu) || po <= 0 || pu <= 0) return null;
  return po / (po + pu);
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26). */
export function normCdf(z: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/** Inverse standard normal CDF (Acklam's rational approximation). */
export function normInv(p: number): number {
  const q = Math.min(1 - 1e-9, Math.max(1e-9, p));
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (q < lo) {
    const r = Math.sqrt(-2 * Math.log(q));
    return (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1);
  }
  if (q > 1 - lo) {
    const r = Math.sqrt(-2 * Math.log(1 - q));
    return -(((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1);
  }
  const r = q - 0.5;
  const s = r * r;
  return ((((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r) / (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1);
}

/**
 * Translate "P(over) at the book's line" into "P(over) at PrizePicks' line".
 * Treat the stat as Normal(μ, sd); solve μ from the book's price, then read
 * the probability at the PrizePicks line. Only used when the lines differ.
 */
export function shiftPOver(pOverAtBook: number, bookLine: number, ppLine: number, sd: number): number {
  if (bookLine === ppLine) return pOverAtBook;
  const mu = bookLine + sd * normInv(pOverAtBook);
  return 1 - normCdf((ppLine - mu) / sd);
}

/** Break-even per-leg probability for an N-pick all-or-nothing slip at `multiplier`. */
export function breakevenPerLeg(legs: number, multiplier: number): number {
  return Math.pow(1 / multiplier, 1 / legs);
}
