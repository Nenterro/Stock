#!/usr/bin/env node
/**
 * Statement-extraction MCP server.
 *
 * A small, separate server for the job that reads PSX financial-results
 * filings (see mcp/statements/EXTRACT.md). It only talks to the stock-api,
 * using the write token; it needs no PocketBase login, so it can run
 * unattended on the home server under Claude Code (`claude -p`).
 *
 * Page images: when the backend's page files are on this machine (the home
 * server), their paths are returned as they are; otherwise (anywhere else)
 * they are downloaded to a temp folder first, so the Read tool can open them.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './lib/config.js';

const here = dirname(fileURLToPath(import.meta.url));
// The backend's data dir inside the container, and where it is on the host.
const CONTAINER_DATA = '/app/data';
const HOST_DATA = process.env.STOCK_API_HOST_DATA || '';

async function call(path, body) {
  if (!config.stockApiToken) throw new Error('STOCK_API_WRITE_TOKEN is not set (mcp/.env or environment).');
  let last;
  for (const base of config.stockApiUrls) {
    try {
      const res = await fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${config.stockApiToken}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(180000)
      });
      return { base, res };
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`stock-api unreachable: ${last?.message}`);
}

async function json(path, body) {
  const { res } = await call(path, body);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status} from ${path}`);
  return data;
}

/** Make a page readable on this machine. */
async function localPage(containerPath, jobId) {
  if (HOST_DATA) {
    const p = containerPath.replace(CONTAINER_DATA, HOST_DATA);
    if (existsSync(p)) return p;
  }
  const dir = join(tmpdir(), 'stock-statements', jobId);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, basename(containerPath));
  if (existsSync(target)) return target;
  const { res } = await call(`/api/statements/page?file=${encodeURIComponent(containerPath)}`);
  if (!res.ok) throw new Error(`could not fetch page ${containerPath}: HTTP ${res.status}`);
  writeFileSync(target, Buffer.from(await res.arrayBuffer()));
  return target;
}

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 1) }] });
const fail = (m) => ({ content: [{ type: 'text', text: `Error: ${m}` }], isError: true });
const tool = (name, def, fn) =>
  server.registerTool(name, def, async (a) => {
    try {
      return await fn(a || {});
    } catch (err) {
      return fail(err.message);
    }
  });

const server = new McpServer({ name: 'stock-statements', version: '1.0.0' });

tool(
  'statements_instructions',
  { title: 'Extraction instructions', description: 'How to read a filing and what to submit. Read this before the first filing.', inputSchema: {} },
  async () => ({ content: [{ type: 'text', text: readFileSync(join(here, 'statements', 'EXTRACT.md'), 'utf8') }] })
);

tool(
  'statements_next',
  {
    title: 'Claim the next filing',
    description: 'Claim the next PSX filing to extract. Returns the company, the pages (local image paths for the Read tool, and text when the PDF has a text layer), PSX\'s own profit figures for checking, and previous captured periods. Returns {empty:true} when the queue is empty.',
    inputSchema: {}
  },
  async () => {
    const job = await json('/api/statements/next', {});
    if (job.empty) return ok({ empty: true });
    for (const p of job.pages) p.file = await localPage(p.file, job.id);
    return ok(job);
  }
);

const num = z.number().optional();
tool(
  'statements_submit',
  {
    title: 'Submit extracted figures',
    description: 'Submit the figures read from the claimed filing (see statements_instructions for every field). The backend checks the balance sheet balances and profit matches PSX; it answers accepted, or needs-review with the problems so you can re-read and resubmit.',
    inputSchema: {
      id: z.string(),
      unit: z.enum(['thousands', 'millions', 'rupees']),
      periodEnd: z.string(),
      periodMonths: z.number().int(),
      statementType: z.enum(['industrial', 'bank', 'insurance']).default('industrial'),
      basis: z.enum(['unconsolidated', 'consolidated']).default('unconsolidated'),
      balanceSheet: z.object({
        totalAssets: z.number(),
        totalEquity: z.number(),
        totalLiabilities: num,
        currentAssets: num,
        currentLiabilities: num,
        nonCurrentLiabilities: num,
        nonControllingInterest: num,
        cashAndEquivalents: num,
        shortTermInvestments: num,
        tradeReceivables: num,
        inventories: num,
        totalBorrowings: num,
        deposits: num,
        advances: num,
        investments: num
      }),
      incomeStatement: z.object({
        revenue: num,
        grossProfit: num,
        operatingProfit: num,
        financeCost: num,
        profitBeforeTax: num,
        profitAfterTax: z.number(),
        profitAttributableToOwners: num,
        periodProfitAfterTax: num,
        eps: num
      }),
      cashFlow: z.object({ operatingCashFlow: num, capex: num }).optional(),
      priorYearEndEquity: num,
      pagesUsed: z.array(z.number().int()).default([]),
      notes: z.string().optional()
    }
  },
  async (a) => ok(await json('/api/statements/submit', { ...a, extractedBy: process.env.EXTRACTOR_NAME || 'claude' }))
);

tool(
  'statements_skip',
  {
    title: 'Skip this document',
    description: 'The claimed document has no balance sheet or income statement (or can\'t be read). The backend tries the full report for the same period next, if there is one.',
    inputSchema: { id: z.string(), reason: z.string() }
  },
  async ({ id, reason }) => ok(await json('/api/statements/skip', { id, reason }))
);

tool(
  'statements_status',
  { title: 'Queue status', description: 'Counts of pending / accepted / needs-review / failed filings, with the problems for those held for review.', inputSchema: {} },
  async () => ok(await json('/api/statements'))
);

await server.connect(new StdioServerTransport());
