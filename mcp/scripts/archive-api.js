#!/usr/bin/env node
/**
 * Archive extraction through the Claude API: Claude Haiku 5.5, one call per
 * report, Message Batches (half price). A one-off for the backtest backlog,
 * paid from API credits; everything else runs on the subscription.
 *
 * Text reports only. The backend hands over the statement pages and the
 * financing/income note pages as text; the answer is structured JSON in the
 * archive_submit shape and goes through the same validation as a session's.
 * Anything rejected, skipped or errored goes back to the queue for a Claude
 * Code session (Sonnet) to redo.
 *
 * Spending is capped: actual token usage from every response is priced and
 * kept in ~/stock-backtest/api-spend.json; a batch is only sent if the
 * ledger plus a deliberately high estimate stays under --budget.
 *
 * Usage (on the home server, ANTHROPIC_API_KEY in mcp/.env):
 *   node mcp/scripts/archive-api.js eval [--n=30]    compare with Sonnet's accepted records (standard API)
 *   node mcp/scripts/archive-api.js run [--batch=150] [--budget=12]
 */
import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { json } from '../lib/backend.js';
import { ENV_FILE } from '../lib/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv.slice(3).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);
const MODE = process.argv[2];
const MODEL = 'claude-haiku-5-5';
// $ per million tokens for prompts up to 100K (Haiku 5.5). Batches are half.
const PRICE = { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 };
const BUDGET = Number(args.budget || 12);
const LEDGER = join(homedir(), 'stock-backtest', 'api-spend.json');

// The API key lives only in mcp/.env on the server.
if (!process.env.ANTHROPIC_API_KEY && existsSync(ENV_FILE)) {
  const m = readFileSync(ENV_FILE, 'utf8').match(/^ANTHROPIC_API_KEY=(.+)$/m);
  if (m) process.env.ANTHROPIC_API_KEY = m[1].trim();
}
const client = new Anthropic();

/* ------------------------------------------------------------- prompt */

const INSTRUCTIONS = readFileSync(join(here, '..', 'archive', 'EXTRACT.md'), 'utf8');
const SYSTEM = `${INSTRUCTIONS}

## One-shot mode

You are called once per report, without tools. The input below already
contains the text of the candidate statement pages and of the financing and
income note pages (noteTexts). Read the figures from them and answer with
the JSON object only. You cannot request more pages: if the primary
statements are not in the text (wrong pages, garbled layout, or only part
of a statement), set skip to true with a skipReason, and a session with page
images will handle the report. Give each printed figure as one entry in
"figures" ({ key, value }, in the stated unit; brackets mean negative).
Never guess a figure the text doesn't show: leave its entry out.`;

// Structured output limits optional (24) and nullable (16) fields, and the
// extraction has ~48. So figures come as a list of { key, value } pairs, keys
// from a fixed list, only the figures the report prints; then rebuilt into
// the archive_submit shape.
const FIGURE_KEYS = [
  ...['totalAssets', 'totalEquity', 'totalLiabilities', 'currentAssets', 'currentLiabilities', 'nonCurrentLiabilities', 'nonControllingInterest', 'cashAndEquivalents', 'shortTermInvestments', 'tradeReceivables', 'inventories', 'totalBorrowings', 'shareCapital', 'deposits', 'advances', 'investments'].map((k) => `balanceSheet.${k}`),
  ...['revenue', 'grossProfit', 'operatingProfit', 'financeCost', 'otherIncome', 'profitBeforeTax', 'profitAfterTax', 'profitAttributableToOwners', 'eps'].map((k) => `incomeStatement.${k}`),
  ...['operatingCashFlow', 'capex', 'dividendsPaid'].map((k) => `cashFlow.${k}`),
  ...['totalAssets', 'totalEquity', 'totalLiabilities', 'nonControllingInterest', 'profitAfterTax', 'revenue'].map((k) => `priorYear.${k}`),
  'sharesOutstanding',
  'faceValue',
  'islamicFinancing',
  'interestIncome',
  'conventionalInvestments'
];
const obj = (props) => ({ type: 'object', additionalProperties: false, properties: props, required: Object.keys(props) });
const SCHEMA = obj({
  skip: { type: 'boolean' },
  skipReason: { type: 'string', description: 'empty unless skip' },
  unit: { type: 'string', enum: ['thousands', 'millions', 'rupees'] },
  periodEnd: { type: 'string', description: 'YYYY-MM-DD; empty if skip' },
  periodMonths: { type: 'integer' },
  statementType: { type: 'string', enum: ['industrial', 'bank', 'insurance'] },
  basis: { type: 'string', enum: ['unconsolidated', 'consolidated'] },
  figures: { type: 'array', items: obj({ key: { type: 'string', enum: FIGURE_KEYS }, value: { type: 'number' } }) },
  pagesUsed: { type: 'array', items: { type: 'integer' } },
  notes: { type: 'string' }
});

/** The structured answer -> the archive_submit shape. */
function shape(a) {
  const out = { skip: a.skip, skipReason: a.skipReason, unit: a.unit, periodEnd: a.periodEnd, periodMonths: a.periodMonths, statementType: a.statementType, basis: a.basis, pagesUsed: a.pagesUsed || [], notes: a.notes || undefined };
  for (const { key, value } of a.figures || []) {
    if (!Number.isFinite(value)) continue;
    const [sec, f] = key.includes('.') ? key.split('.') : [null, key];
    if (sec) (out[sec] ||= {})[f] = value;
    else out[f] = value;
  }
  return out;
}

function userContent(job) {
  const { pages, noteTexts, found, candidates, previous, company, archiveYear, totalPages } = job;
  return `Report: ${company} (archive year ${archiveYear}, ${totalPages} pages).
Statement pages found: ${JSON.stringify(found)}; all candidates: ${JSON.stringify(candidates)}.
Neighbouring years already captured: ${JSON.stringify(previous)}.

STATEMENT PAGES
${pages.map((p) => `--- page ${p.page} ---\n${p.text}`).join('\n')}

NOTE PAGES (financing, income, Shariah disclosure)
${(noteTexts || []).map((p) => `--- page ${p.page} ---\n${p.text}`).join('\n') || '(none found)'}`;
}

const params = (job) => ({
  model: MODEL,
  max_tokens: 12000,
  system: SYSTEM,
  messages: [{ role: 'user', content: userContent(job) }],
  output_config: { format: { type: 'json_schema', schema: SCHEMA } }
});

/* -------------------------------------------------------------- ledger */

function ledger() {
  return existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : { spentUsd: 0, calls: 0, entries: [] };
}
function record(usage, { batch }) {
  const l = ledger();
  const k = batch ? 0.5 : 1;
  const cost = (k * ((usage.input_tokens || 0) * PRICE.input + (usage.output_tokens || 0) * PRICE.output + (usage.cache_creation_input_tokens || 0) * PRICE.cacheWrite + (usage.cache_read_input_tokens || 0) * PRICE.cacheRead)) / 1e6;
  l.spentUsd += cost;
  l.calls += 1;
  mkdirSync(dirname(LEDGER), { recursive: true });
  writeFileSync(LEDGER, JSON.stringify({ ...l, entries: undefined, updatedAt: new Date().toISOString() }, null, 1));
  return cost;
}

function answerOf(message) {
  if (message.stop_reason === 'refusal') return { error: 'refusal' };
  if (message.stop_reason === 'max_tokens') return { error: 'max_tokens' };
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return { answer: shape(JSON.parse(text)) };
  } catch {
    return { error: 'unparseable output' };
  }
}

/* ---------------------------------------------------------------- eval */

const FIELDS = [
  ['balanceSheet', 'totalAssets'],
  ['balanceSheet', 'totalEquity'],
  ['balanceSheet', 'cashAndEquivalents'],
  ['balanceSheet', 'tradeReceivables'],
  ['balanceSheet', 'totalBorrowings'],
  ['incomeStatement', 'revenue'],
  ['incomeStatement', 'profitAfterTax'],
  ['cashFlow', 'operatingCashFlow'],
  ['priorYear', 'totalEquity'],
  ['priorYear', 'profitAfterTax'],
  [null, 'sharesOutstanding'],
  [null, 'islamicFinancing'],
  [null, 'interestIncome'],
  [null, 'conventionalInvestments']
];
const UNIT = { rupees: 0.001, thousands: 1, millions: 1000 };

async function evaluate() {
  const n = Number(args.n || 30);
  const data = '/home/huzaifa/Docker/stock-api/data';
  const queue = JSON.parse(readFileSync(join(data, 'archive_queue.json'), 'utf8')).items;
  const store = JSON.parse(readFileSync(join(data, 'archive_statements.json'), 'utf8')).companies;
  // Accepted text reports with a stored record; spread across companies.
  const cands = Object.values(queue).filter((i) => i.status === 'accepted' && i.mode === 'text' && store[i.symbol]?.periods?.[i.periodEnd]);
  const pick = [];
  const seen = new Map();
  for (const i of cands.sort(() => Math.random() - 0.5)) {
    if ((seen.get(i.symbol) || 0) >= 3) continue;
    seen.set(i.symbol, (seen.get(i.symbol) || 0) + 1);
    pick.push(i);
    if (pick.length >= n) break;
  }
  const stats = Object.fromEntries(FIELDS.map(([, f]) => [f, { compared: 0, agree: 0, onlySonnet: 0, onlyHaiku: 0 }]));
  let allCoreAgree = 0;
  let skipped = 0;
  let spent = 0;
  const disagreements = [];
  for (const it of pick) {
    const job = await json('/api/archive/eval', { id: it.id });
    if (job.mode !== 'text') continue;
    const msg = await client.messages.create(params(job));
    spent += record(msg.usage, { batch: false });
    const { answer, error } = answerOf(msg);
    if (error || answer.skip) {
      skipped += 1;
      disagreements.push(`${it.id}: ${error || `skip: ${answer.skipReason}`}`);
      continue;
    }
    const ref = store[it.symbol].periods[it.periodEnd];
    const k = UNIT[answer.unit] || 1;
    let core = true;
    for (const [sec, f] of FIELDS) {
      const h = sec ? answer[sec]?.[f] : answer[f];
      const s = sec ? ref[sec]?.[f] : ref[f];
      const hv = h == null ? null : f === 'sharesOutstanding' ? h : h * k;
      const st = stats[f];
      if (hv == null && s == null) continue;
      if (hv == null) {
        st.onlySonnet += 1;
        continue;
      }
      if (s == null) {
        st.onlyHaiku += 1;
        continue;
      }
      st.compared += 1;
      const ok = Math.abs(hv - s) <= Math.max(1, Math.abs(s) * 0.005);
      if (ok) st.agree += 1;
      else {
        disagreements.push(`${it.id} ${f}: haiku ${Math.round(hv)} vs sonnet ${Math.round(s)}`);
        if (['totalAssets', 'totalEquity', 'profitAfterTax'].includes(f)) core = false;
      }
    }
    if (answer.periodEnd !== it.periodEnd) {
      core = false;
      disagreements.push(`${it.id}: periodEnd haiku ${answer.periodEnd} vs ${it.periodEnd}`);
    }
    if (core) allCoreAgree += 1;
    process.stderr.write('.');
  }
  console.log(JSON.stringify({ model: MODEL, reports: pick.length, skipped, coreAgree: allCoreAgree, spentUsd: +spent.toFixed(4), fields: stats, disagreements }, null, 1));
}

/* ----------------------------------------------------------------- run */

async function claimBatch(size) {
  const jobs = [];
  let empty = false;
  const worker = async () => {
    while (!empty && jobs.length < size) {
      const job = await json('/api/archive/next', { claimant: 'api', textOnly: true });
      if (job.empty) {
        empty = true;
        return;
      }
      jobs.push(job);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return { jobs, empty };
}

async function release(id, reason, apiFailed = true) {
  await json('/api/archive/release', { id, reason: `api: ${reason}`, apiFailed }).catch(() => {});
}

async function runBatches() {
  const size = Number(args.batch || 150);
  for (;;) {
    const l = ledger();
    // A deliberately high per-report estimate: 40k input + 6k output tokens.
    const perReport = (0.5 * (40000 * PRICE.input + 6000 * PRICE.output)) / 1e6;
    const room = Math.floor((BUDGET - l.spentUsd) / perReport);
    if (room < 1) {
      console.error(`budget reached: $${l.spentUsd.toFixed(2)} of $${BUDGET}`);
      return;
    }
    const { jobs, empty } = await claimBatch(Math.min(size, room));
    if (!jobs.length) {
      console.error('no text reports left');
      return;
    }
    console.error(`${new Date().toISOString()} batch of ${jobs.length} (spent so far $${l.spentUsd.toFixed(2)})`);
    const batch = await client.messages.batches.create({ requests: jobs.map((j) => ({ custom_id: j.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64), params: params(j) })) });
    const byCustom = new Map(jobs.map((j) => [j.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64), j]));
    let b = batch;
    while (b.processing_status !== 'ended') {
      await new Promise((r) => setTimeout(r, 60000));
      b = await client.messages.batches.retrieve(batch.id);
    }
    let accepted = 0;
    let back = 0;
    for await (const res of await client.messages.batches.results(batch.id)) {
      const job = byCustom.get(res.custom_id);
      if (!job) continue;
      if (res.result.type !== 'succeeded') {
        await release(job.id, res.result.type);
        back += 1;
        continue;
      }
      record(res.result.message.usage, { batch: true });
      const { answer, error } = answerOf(res.result.message);
      if (error || answer.skip) {
        await release(job.id, error || `skipped: ${answer.skipReason}`);
        back += 1;
        continue;
      }
      const { skip, skipReason, ...sub } = answer;
      const r = await json('/api/archive/submit', { id: job.id, ...sub, extractedBy: `${MODEL} (API batch)` }).catch((e) => ({ status: 'error', problems: [e.message] }));
      if (r.status === 'accepted') accepted += 1;
      else {
        await release(job.id, (r.problems || []).join('; '));
        back += 1;
      }
    }
    console.error(`${new Date().toISOString()} batch done: ${accepted} accepted, ${back} back to sessions; spent $${ledger().spentUsd.toFixed(2)}`);
    if (empty) return;
  }
}

if (MODE === 'eval') await evaluate();
else if (MODE === 'run') await runBatches();
else console.error('usage: archive-api.js eval|run [--n=30] [--batch=150] [--budget=12]');
