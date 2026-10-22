#!/usr/bin/env node
/**
 * Monthly geopolitical indicators from the GDELT daily aggregates
 * (gdelt-daily.py), for the blind news-indicator backtest.
 *
 * GDELT's source coverage grows over the years, so raw counts mean little.
 * Every indicator is relative:
 *   share      the key's events as a share of all world events
 *   conflict   material-conflict share of the key's events (QuadClass 4)
 *   violence   assault, fight and mass-violence events (CAMEO 18-20) per
 *              world event
 *   protest    protest events (CAMEO 14) per world event
 *   tone       mention-weighted average tone of coverage
 *   stability  mention-weighted Goldstein scale (-10 conflict .. +10 cooperation)
 * and each is also given as a z-score against its own previous 12 months,
 * which is all that was known at the time.
 *
 * Keys: countries by event location (loc:PK) and by actor (act:PAK), plus
 * regions built from them. Output: ~/stock-backtest/gdelt/monthly.json
 *
 * Usage: node mcp/scripts/geo-indicators.js [daily.jsonl] [out.json]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const IN = process.argv[2] || join(homedir(), 'stock-backtest', 'gdelt', 'daily.jsonl');
const OUT = process.argv[3] || join(homedir(), 'stock-backtest', 'gdelt', 'monthly.json');
if (!existsSync(IN)) throw new Error(`no GDELT daily file at ${IN}`);

const REGIONS = {
  'region:south-asia': ['loc:PK', 'loc:IN', 'loc:AF'],
  'region:gulf-mideast': ['loc:IR', 'loc:SA', 'loc:AE', 'loc:IS', 'loc:IZ', 'loc:YM', 'loc:QA'],
  'region:great-powers': ['loc:US', 'loc:CH', 'loc:RS', 'loc:UP']
};

const blank = () => ({ n: 0, m: 0, q: [0, 0, 0, 0], r: new Array(20).fill(0), tw: 0, gw: 0, days: 0 });
function addDay(acc, x) {
  acc.n += x.n;
  acc.m += x.m;
  x.q.forEach((v, i) => (acc.q[i] += v));
  x.r.forEach((v, i) => (acc.r[i] += v));
  acc.tw += x.tone * x.m;
  acc.gw += x.gs * x.m;
  acc.days += 1;
}

// Month -> key -> accumulator.
const months = new Map();
for (const line of readFileSync(IN, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const d = JSON.parse(line);
  const m = `${d.date.slice(0, 4)}-${d.date.slice(4, 6)}`;
  if (!months.has(m)) months.set(m, new Map());
  const acc = months.get(m);
  for (const [k, x] of Object.entries(d)) {
    if (k === 'date') continue;
    if (!acc.has(k)) acc.set(k, blank());
    addDay(acc.get(k), x);
  }
  for (const [region, keys] of Object.entries(REGIONS)) {
    if (!acc.has(region)) acc.set(region, blank());
    for (const k of keys) if (d[k]) addDay(acc.get(region), d[k]);
  }
}

const sorted = [...months.keys()].sort();
const indicators = {};
for (const m of sorted) {
  const acc = months.get(m);
  const world = acc.get('world');
  if (!world?.n) continue;
  indicators[m] = {};
  for (const [k, a] of acc) {
    if (k === 'world' || !a.n) continue;
    indicators[m][k] = {
      share: a.n / world.n,
      conflict: a.q[3] / a.n,
      violence: (a.r[17] + a.r[18] + a.r[19]) / world.n,
      protest: a.r[13] / world.n,
      tone: a.m ? a.tw / a.m : null,
      stability: a.m ? a.gw / a.m : null,
      days: a.days
    };
  }
}

// z-scores against the previous 12 months (needs at least 9 of them).
const FIELDS = ['share', 'conflict', 'violence', 'protest', 'tone', 'stability'];
for (let i = 0; i < sorted.length; i++) {
  const m = sorted[i];
  if (!indicators[m]) continue;
  for (const [k, x] of Object.entries(indicators[m])) {
    x.z = {};
    for (const f of FIELDS) {
      const prev = sorted
        .slice(Math.max(0, i - 12), i)
        .map((pm) => indicators[pm]?.[k]?.[f])
        .filter((v) => v != null && Number.isFinite(v));
      if (prev.length < 9 || x[f] == null) continue;
      const mu = prev.reduce((a, b) => a + b, 0) / prev.length;
      const sd = Math.sqrt(prev.reduce((a, b) => a + (b - mu) ** 2, 0) / (prev.length - 1));
      x.z[f] = sd > 0 ? +((x[f] - mu) / sd).toFixed(2) : null;
    }
    for (const f of FIELDS) if (x[f] != null) x[f] = +x[f].toFixed(6);
  }
}

writeFileSync(OUT, JSON.stringify({ builtAt: new Date().toISOString(), from: sorted[0], to: sorted[sorted.length - 1], regions: REGIONS, months: indicators }));
console.log(`${Object.keys(indicators).length} months, ${sorted[0]}..${sorted[sorted.length - 1]} -> ${OUT}`);
