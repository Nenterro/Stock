/**
 * Price indicators and chart-pattern detection for the paper-trading
 * strategies (mcp/paper/strategies.mjs). Pure functions over a bar series,
 * oldest first: [{ date, price (close), adjClose, volume? }].
 *
 * Patterns are detected on closing prices with fixed, written definitions,
 * so a test can be repeated and no pattern is "seen" with hindsight. PSX
 * history has closes and volume but no highs and lows, so closes are used
 * everywhere (as in Lo, Mamaysky and Wang 2000).
 */

export const closes = (bars) => bars.map((b) => b.adjClose ?? b.price);

export function sma(xs, n, end = xs.length) {
  if (end < n) return null;
  let s = 0;
  for (let i = end - n; i < end; i++) s += xs[i];
  return s / n;
}

/** Return over the last n bars (on adjusted closes). */
export function ret(xs, n, end = xs.length) {
  if (end - 1 - n < 0) return null;
  const a = xs[end - 1 - n];
  const b = xs[end - 1];
  return a > 0 ? b / a - 1 : null;
}

/** 12-1 momentum: return from 252 to 21 bars ago (shorter histories: from the start, if 200+ bars). */
export function momentum12_1(xs) {
  const n = xs.length;
  if (n < 200) return null;
  const start = xs[Math.max(0, n - 253)];
  const skip = xs[n - 22];
  return start > 0 ? skip / start - 1 : null;
}

/** Wilder RSI over n bars. */
export function rsi(xs, n = 14, end = xs.length) {
  if (end <= n) return null;
  let gain = 0;
  let loss = 0;
  for (let i = end - n; i < end; i++) {
    const d = xs[i] - xs[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  if (loss === 0) return 100;
  const rs = gain / n / (loss / n);
  return 100 - 100 / (1 + rs);
}

export const high = (xs, n, end = xs.length) => (end < n ? null : Math.max(...xs.slice(end - n, end)));
export const low = (xs, n, end = xs.length) => (end < n ? null : Math.min(...xs.slice(end - n, end)));

/** Average volume over the n bars before `end` (excluding it); null without volume. */
export function avgVolume(bars, n, end = bars.length - 1) {
  const v = bars.slice(Math.max(0, end - n), end).map((b) => b.volume).filter((x) => x > 0);
  return v.length >= Math.min(10, n) ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/** Volume on bar `i` relative to the previous 20; null when unknown (counts as unconfirmed). */
export function volumeRatio(bars, i = bars.length - 1) {
  const avg = avgVolume(bars, 20, i);
  return avg && bars[i].volume > 0 ? bars[i].volume / avg : null;
}

/**
 * Swing points: local highs and lows that are the extreme of the `w` bars on
 * each side. Only points with w bars after them are confirmed, so detection
 * never uses the future.
 */
export function pivots(xs, w = 5) {
  const out = [];
  for (let i = w; i < xs.length - w; i++) {
    const win = xs.slice(i - w, i + w + 1);
    if (xs[i] === Math.max(...win)) out.push({ i, type: 'H', v: xs[i] });
    else if (xs[i] === Math.min(...win)) out.push({ i, type: 'L', v: xs[i] });
  }
  // Keep alternating highs and lows (the more extreme of a run).
  const alt = [];
  for (const p of out) {
    const last = alt[alt.length - 1];
    if (last && last.type === p.type) {
      if ((p.type === 'H' && p.v > last.v) || (p.type === 'L' && p.v < last.v)) alt[alt.length - 1] = p;
    } else alt.push(p);
  }
  return alt;
}

const near = (a, b, tol) => Math.abs(a - b) / Math.max(a, b) <= tol;

/**
 * Bullish breakouts confirmed on the last bar. Each returns
 * { pattern, breakout (level), stop, target, height } or null.
 * Confirmation: the close crosses the level today (it was below yesterday)
 * and, where volume exists, volume is at least 1.5x its 20-day average.
 */
export function bullishPatterns(bars) {
  const xs = closes(bars);
  const n = xs.length;
  if (n < 80) return [];
  const last = xs[n - 1];
  const prev = xs[n - 2];
  const vr = volumeRatio(bars);
  const volOk = vr == null ? bars.every((b) => b.volume == null) : vr >= 1.5;
  if (!volOk) return [];
  const crossed = (level) => last > level && prev <= level;
  const piv = pivots(xs.slice(0, n - 1), 5).filter((p) => p.i >= n - 130);
  const found = [];
  const L = piv.filter((p) => p.type === 'L');
  const H = piv.filter((p) => p.type === 'H');

  // Double bottom: two lows within 3%, 15-80 bars apart, a peak between them
  // at least 8% above; breakout over that peak.
  for (let a = 0; a < L.length - 1; a++) {
    const b = L.length - 1; // the latest low is the second bottom
    if (a === b) continue;
    const l1 = L[a];
    const l2 = L[b];
    const gap = l2.i - l1.i;
    if (gap < 15 || gap > 80 || !near(l1.v, l2.v, 0.03)) continue;
    const mid = H.filter((h) => h.i > l1.i && h.i < l2.i);
    if (!mid.length) continue;
    const peak = Math.max(...mid.map((h) => h.v));
    const bottom = Math.min(l1.v, l2.v);
    if (peak < bottom * 1.08 || !crossed(peak) || xs.slice(l2.i, n - 1).some((x) => x > peak)) continue;
    found.push({ pattern: 'double bottom', breakout: peak, stop: bottom, height: peak - bottom, target: peak + (peak - bottom) });
    break;
  }

  // Inverse head and shoulders: three lows, the middle the lowest by 3%+,
  // shoulders within 6% of each other; neckline = the higher of the two
  // peaks between them; breakout over the neckline.
  if (L.length >= 3) {
    const [s1, hd, s2] = L.slice(-3);
    const peaks = H.filter((h) => h.i > s1.i && h.i < s2.i);
    if (hd.v < Math.min(s1.v, s2.v) * 0.97 && near(s1.v, s2.v, 0.06) && peaks.length && s2.i - s1.i <= 120) {
      const neck = Math.max(...peaks.map((h) => h.v));
      if (crossed(neck) && !xs.slice(s2.i, n - 1).some((x) => x > neck)) {
        found.push({ pattern: 'inverse head and shoulders', breakout: neck, stop: s2.v, height: neck - hd.v, target: neck + (neck - hd.v) });
      }
    }
  }

  // Ascending triangle: two or more highs within 2% (flat resistance) over
  // 20-90 bars, and two or more rising lows between them; breakout over the
  // highest of those highs.
  const recentH = H.filter((h) => h.i >= n - 91);
  if (recentH.length >= 2) {
    const top = Math.max(...recentH.map((h) => h.v));
    const flat = recentH.filter((h) => near(h.v, top, 0.02));
    if (flat.length >= 2 && flat[flat.length - 1].i - flat[0].i >= 20) {
      const lows = L.filter((l) => l.i > flat[0].i);
      const rising = lows.length >= 2 && lows.every((l, k) => k === 0 || l.v > lows[k - 1].v);
      if (rising && crossed(top)) {
        const base = lows[0].v;
        found.push({ pattern: 'ascending triangle', breakout: top, stop: lows[lows.length - 1].v, height: top - base, target: top + (top - base) });
      }
    }
  }

  // Bull flag: a pole of 15%+ in at most 15 bars, then 5-20 bars of
  // consolidation that gives back at most half the pole; breakout over the
  // consolidation's high.
  for (let len = 5; len <= 20; len++) {
    const flagStart = n - 1 - len;
    const flag = xs.slice(flagStart, n - 1);
    const fh = Math.max(...flag);
    const fl = Math.min(...flag);
    const poleTop = xs[flagStart];
    const poleBase = Math.min(...xs.slice(Math.max(0, flagStart - 15), flagStart));
    if (poleTop < poleBase * 1.15) continue;
    if (fh > poleTop * 1.02 || fl < poleTop - (poleTop - poleBase) / 2) continue;
    if (crossed(fh)) {
      found.push({ pattern: 'bull flag', breakout: fh, stop: fl, height: poleTop - poleBase, target: fh + (poleTop - poleBase) });
      break;
    }
  }

  // Resistance breakout: the close clears the highest close of the last 60
  // bars (resistance), with volume at least twice average where known.
  const res = high(xs, 60, n - 1);
  if (res && crossed(res) && (vr == null || vr >= 2)) {
    const base = low(xs, 60, n - 1);
    found.push({ pattern: 'resistance breakout', breakout: res, stop: Math.max(base, res * 0.92), height: res - base, target: res + (res - base) });
  }
  return found.filter((f) => f.stop < last && f.target > last);
}

/**
 * Bearish breakdowns on the last bar (used only as exits: the strategies are
 * long-only): double top and head and shoulders, broken on a close below the
 * trough or neckline.
 */
export function bearishPatterns(bars) {
  const xs = closes(bars);
  const n = xs.length;
  if (n < 80) return [];
  const last = xs[n - 1];
  const prev = xs[n - 2];
  const broke = (level) => last < level && prev >= level;
  const piv = pivots(xs.slice(0, n - 1), 5).filter((p) => p.i >= n - 130);
  const H = piv.filter((p) => p.type === 'H');
  const L = piv.filter((p) => p.type === 'L');
  const found = [];
  if (H.length >= 2) {
    const h1 = H[H.length - 2];
    const h2 = H[H.length - 1];
    const troughs = L.filter((l) => l.i > h1.i && l.i < h2.i);
    if (near(h1.v, h2.v, 0.03) && h2.i - h1.i >= 15 && troughs.length) {
      const t = Math.min(...troughs.map((l) => l.v));
      if (t < Math.max(h1.v, h2.v) * 0.92 && broke(t)) found.push({ pattern: 'double top', level: t });
    }
  }
  if (H.length >= 3) {
    const [s1, hd, s2] = H.slice(-3);
    const troughs = L.filter((l) => l.i > s1.i && l.i < s2.i);
    if (hd.v > Math.max(s1.v, s2.v) * 1.03 && near(s1.v, s2.v, 0.06) && troughs.length) {
      const neck = Math.min(...troughs.map((l) => l.v));
      if (broke(neck)) found.push({ pattern: 'head and shoulders', level: neck });
    }
  }
  return found;
}
