/**
 * Research theses from the private Personal Investment records, read by the
 * weekly model run (automation/run.mjs) and by build_model_portfolio, so the
 * optimiser knows what research concluded:
 *   - rejected names stay out until their review date (unless held);
 *   - needs-review names get less confidence;
 *   - a thesis's own `impliedReturn` replaces the model's valuation;
 *   - `cycle: peak` marks the whole industry as at a cyclical peak.
 * See construct.reliability() and pipeline.buildInputs().
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** The records folder: env var, the server clone, or the gitignored folder in this repo. */
export function personalInvestmentDir() {
  const candidates = [process.env.PERSONAL_INVESTMENT_DIR, join(homedir(), 'personal-investment'), join(here, '..', '..', 'Personal Investment')].filter(Boolean);
  return candidates.find((d) => existsSync(join(d, 'theses'))) || null;
}

/** Theses with their front matter (symbol, status, review, triggers, impliedReturn, cycle, ...). */
export function readTheses(dir = personalInvestmentDir()) {
  if (!dir) return [];
  const tdir = join(dir, 'theses');
  if (!existsSync(tdir)) return [];
  const out = [];
  for (const f of readdirSync(tdir).filter((x) => x.endsWith('.md') && !x.startsWith('_'))) {
    const text = readFileSync(join(tdir, f), 'utf8').replace(/\r\n/g, '\n');
    const m = text.match(/^---\n([\s\S]*?)\n---\n/);
    const fm = { triggers: {} };
    if (m) {
      let inTriggers = false;
      for (const line of m[1].split('\n')) {
        const clean = line.replace(/\s+#.*$/, '');
        const t = clean.match(/^ {2}(\w+):\s*(.+)$/);
        const k = clean.match(/^(\w+):\s*(.*)$/);
        if (t && inTriggers) fm.triggers[t[1]] = Number(t[2]);
        else if (k) {
          inTriggers = k[1] === 'triggers';
          if (!inTriggers) fm[k[1]] = k[2].trim();
        }
      }
    }
    const ir = fm.impliedReturn != null && fm.impliedReturn !== '' ? Number(fm.impliedReturn) : null;
    out.push({ file: f, ...fm, symbol: (fm.symbol || f.replace(/\.md$/, '')).toUpperCase(), impliedReturn: Number.isFinite(ir) ? ir : null });
  }
  return out;
}

/**
 * The `research` input for pipeline.buildInputs. `industryOf(symbol)` looks
 * up a screener industry (for theses marked `cycle: peak`).
 */
export async function researchInput(industryOf, dir = personalInvestmentDir()) {
  const list = readTheses(dir);
  const theses = Object.fromEntries(list.map((t) => [t.symbol, { status: t.status || null, review: t.review || null, reason: t.reason || null, impliedReturn: t.impliedReturn, cycle: t.cycle || null }]));
  const peakIndustries = {};
  for (const t of list.filter((x) => String(x.cycle || '').toLowerCase() === 'peak')) {
    const ind = await Promise.resolve(industryOf(t.symbol)).catch(() => null);
    if (ind) peakIndustries[ind] = peakIndustries[ind] || t.symbol;
  }
  return { dir, theses, peakIndustries };
}
