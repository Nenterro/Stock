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
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { json, ok, toolOn, localPage } from './lib/backend.js';

const here = dirname(fileURLToPath(import.meta.url));
const server = new McpServer({ name: 'stock-statements', version: '1.0.0' });
const tool = toolOn(server);

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
