#!/usr/bin/env node
/**
 * Report-archive extraction MCP server (backtest data).
 *
 * The nightly headless run (mcp/scripts/extract-archive.sh) reads historical
 * PSX annual reports into point-in-time statements, one report per session,
 * following mcp/archive/EXTRACT.md. Text reports arrive as the statement
 * pages' text; scanned ones as contact sheets to pick pages from, then full
 * page images. Needs only the stock-api write token.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { json, ok, toolOn, localPage } from './lib/backend.js';

const here = dirname(fileURLToPath(import.meta.url));
const server = new McpServer({ name: 'stock-archive', version: '1.0.0' });
const tool = toolOn(server);

tool(
  'archive_instructions',
  { title: 'Extraction instructions', description: 'How to read an archived annual report and what to submit. Read this first.', inputSchema: {} },
  async () => ok(readFileSync(join(here, 'archive', 'EXTRACT.md'), 'utf8'))
);

tool(
  'archive_next',
  {
    title: 'Claim the next report',
    description:
      'Claim the next archived annual report. mode "text": the candidate statement pages\' text is included. mode "scanned": contact sheets (numbered thumbnails of every page, as image files for the Read tool) to find the statements on, then call archive_pages. Includes the company\'s neighbouring captured years for consistency. Returns {empty:true} when done.',
    inputSchema: {}
  },
  async () => {
    const job = await json('/api/archive/next', {});
    if (job.empty) return ok({ empty: true });
    for (const s of job.contactSheets || []) s.file = await localPage(s.file, job.id);
    return ok(job);
  }
);

tool(
  'archive_pages',
  {
    title: 'Render pages',
    description: 'Full-resolution images of up to 12 pages of the claimed report (page numbers as in the PDF / contact-sheet labels). Use for scanned reports, or to check a text page whose layout is garbled.',
    inputSchema: { id: z.string(), pages: z.array(z.number().int()).min(1).max(12) }
  },
  async ({ id, pages }) => {
    const r = await json('/api/archive/pages', { id, pages });
    for (const p of r.pages) p.file = await localPage(p.file, id);
    return ok(r);
  }
);

const num = z.number().optional();
tool(
  'archive_submit',
  {
    title: 'Submit extracted figures',
    description:
      'Submit the figures for the claimed report (see archive_instructions). Rejected submissions list the problems; re-read and resubmit (two corrections allowed). Accepted ones report the cross-year check against neighbouring years.',
    inputSchema: {
      id: z.string(),
      unit: z.enum(['thousands', 'millions', 'rupees']),
      periodEnd: z.string(),
      periodMonths: z.number().int().default(12),
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
        shareCapital: num,
        deposits: num,
        advances: num,
        investments: num
      }),
      incomeStatement: z.object({
        revenue: num,
        grossProfit: num,
        operatingProfit: num,
        financeCost: num,
        otherIncome: num,
        profitBeforeTax: num,
        profitAfterTax: z.number(),
        profitAttributableToOwners: num,
        eps: num
      }),
      cashFlow: z.object({ operatingCashFlow: num, capex: num, dividendsPaid: num }).optional(),
      priorYear: z
        .object({ totalAssets: num, totalEquity: num, totalLiabilities: num, nonControllingInterest: num, profitAfterTax: num, revenue: num })
        .optional()
        .describe('the comparative column: previous year end balance sheet totals and previous year profit'),
      sharesOutstanding: num.describe('number of ordinary shares at period end (not thousands)'),
      faceValue: num.describe('par value per share, usually 10'),
      islamicFinancing: num.describe('part of totalBorrowings that is Islamic (musharaka, sukuk, ijarah, diminishing musharaka), when the statements label it'),
      interestIncome: num.describe('interest / markup income from conventional deposits and investments, when shown'),
      pagesUsed: z.array(z.number().int()).default([]),
      notes: z.string().optional()
    }
  },
  async (a) => ok(await json('/api/archive/submit', { ...a, extractedBy: process.env.EXTRACTOR_NAME || 'claude' }))
);

tool(
  'archive_skip',
  {
    title: 'Skip this report',
    description: 'The document is not an annual report with primary statements (e.g. a notice, a wrong file, unreadable). Give the reason.',
    inputSchema: { id: z.string(), reason: z.string() }
  },
  async ({ id, reason }) => ok(await json('/api/archive/skip', { id, reason }))
);

tool(
  'archive_status',
  { title: 'Archive status', description: 'Queue counts, text vs scanned, cross-year mismatches, held and failed reports.', inputSchema: {} },
  async () => ok(await json('/api/archive/status'))
);

await server.connect(new StdioServerTransport());
