#!/usr/bin/env node
/**
 * News-digest MCP server.
 *
 * Used by the nightly headless Claude Code run (mcp/scripts/news-digest.sh):
 * it hands over the articles collected since the last digest and stores the
 * result (article tags, the daily brief, risk-register updates). Instructions
 * are in mcp/news/DIGEST.md. Like the statements server it needs only the
 * stock-api write token.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { json, ok, toolOn } from './lib/backend.js';

const here = dirname(fileURLToPath(import.meta.url));
const server = new McpServer({ name: 'stock-news', version: '1.0.0' });
const tool = toolOn(server);

// The batch handed out, so untagged articles in it can be marked as read.
let batchIds = [];
let batchDate = null;

tool(
  'news_instructions',
  { title: 'Digest instructions', description: 'How to tag the articles, write the brief and maintain the risk register. Read this first.', inputSchema: {} },
  async () => ok(readFileSync(join(here, 'news', 'DIGEST.md'), 'utf8'))
);

tool(
  'news_batch',
  {
    title: 'Articles to digest',
    description:
      'The articles collected since the last digest (newest first, at most 400), with the tracked symbols (holdings, watchlist, targets), the previous brief and the open risks. One line per article: id | source | time (UTC) | title | summary.',
    inputSchema: {}
  },
  async () => {
    const b = await json('/api/news/digest/next', {});
    batchIds = b.articles.map((a) => a.id);
    batchDate = b.date;
    const lines = b.articles.map((a) => {
      const src = a.alsoIn?.length ? `${a.source} (+${a.alsoIn.join(', ')})` : a.source;
      return `${a.id} | ${src} | ${a.published.slice(0, 16).replace('T', ' ')} | ${a.title}${a.summary ? ` | ${a.summary.slice(0, 280)}` : ''}`;
    });
    const header = {
      date: b.date,
      articles: b.count,
      olderSkipped: b.skippedOlder || undefined,
      since: b.since,
      tracked: b.tracked,
      previousBrief: b.previousBrief,
      openRisks: b.openRisks
    };
    return ok(`${JSON.stringify(header, null, 1)}\n\nARTICLES\n${lines.join('\n')}`);
  }
);

const list = z.array(z.string()).optional();
tool(
  'news_submit',
  {
    title: 'Submit the digest',
    description:
      'Store the digest: tags for the articles that matter (the rest of the batch counts as importance 0), the daily brief, and risk-register updates (new risks, and changes to existing ones by id). Call once, after news_batch.',
    inputSchema: {
      tags: z
        .array(
          z.object({
            id: z.string(),
            importance: z.number().int().min(0).max(3),
            themes: z.array(z.string()),
            markets: z.array(z.string()),
            sectors: list,
            symbols: list,
            note: z.string().optional().describe('one line: why it matters, if not obvious')
          })
        )
        .describe('only articles with importance >= 1'),
      brief: z.object({
        headline: z.string(),
        summary: z.string(),
        sections: z.array(
          z.object({
            theme: z.string(),
            title: z.string(),
            points: z.array(z.object({ text: z.string(), articles: z.array(z.string()) }))
          })
        ),
        portfolio: z.string().describe('what today\'s news means for the tracked symbols and the policy sleeves; say so plainly when nothing does')
      }),
      risks: z
        .array(
          z.object({
            id: z.string().optional().describe('existing risk id to update; omit for a new risk'),
            title: z.string().optional(),
            theme: z.string().optional(),
            markets: list,
            sectors: list,
            symbols: list,
            severity: z.number().int().min(1).max(5).optional(),
            direction: z.enum(['rising', 'stable', 'easing']).optional(),
            status: z.enum(['active', 'resolved']).optional(),
            summary: z.string().optional(),
            watch: z.string().optional().describe('what would raise or lower it'),
            change: z.string().optional().describe('what changed today, if anything'),
            evidence: list
          })
        )
        .default([])
    }
  },
  async (a) => {
    if (!batchIds.length) throw new Error('call news_batch first');
    const r = await json('/api/news/digest/submit', { ...a, date: batchDate, batchIds, extractedBy: process.env.EXTRACTOR_NAME || 'claude' });
    batchIds = [];
    return ok(r);
  }
);

await server.connect(new StdioServerTransport());
