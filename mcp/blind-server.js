#!/usr/bin/env node
/**
 * Blind-judgement MCP server (backtest). Serves anonymised tasks from the
 * backend (lib/backtest/blind.js) and records the answers. Sessions using it
 * get no other tools: nothing that could reveal the real names or dates.
 * Instructions: mcp/blind/INSTRUCTIONS.md. Runner: mcp/scripts/blind-run.sh.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { json, ok, toolOn } from './lib/backend.js';

const here = dirname(fileURLToPath(import.meta.url));
const server = new McpServer({ name: 'stock-blind', version: '1.0.0' });
const tool = toolOn(server);

tool(
  'blind_instructions',
  { title: 'Instructions', description: 'How to answer blind tasks. Read this first.', inputSchema: {} },
  async () => ok(readFileSync(join(here, 'blind', 'INSTRUCTIONS.md'), 'utf8'))
);

tool(
  'blind_next',
  {
    title: 'Next task',
    description: 'The next blind task: its kind, the question, and the anonymised input. Returns {empty:true} when there are none.',
    inputSchema: { kinds: z.array(z.enum(['news', 'stocks', 'leak-news', 'leak-stocks'])).optional() }
  },
  async ({ kinds }) => ok(await json('/api/backtest/blind/next', { kinds }))
);

tool(
  'blind_submit',
  {
    title: 'Submit the answer',
    description:
      'Answer the task. news: { riskLevel 1-5, direction rising|stable|easing, pakistanWeight 0.10-0.40, reasoning, recognised }. stocks: { picks: [{ code, weight }] (1-15, weights sum to 1, each <= 0.15), reasoning, recognised }. leak-news: { country, year, month, confidence }. leak-stocks: { guesses: [{ code, company, confidence }], year, confidence }.',
    inputSchema: {
      id: z.string(),
      answer: z.object({
        riskLevel: z.number().int().min(1).max(5).optional(),
        direction: z.enum(['rising', 'stable', 'easing']).optional(),
        pakistanWeight: z.number().optional(),
        picks: z.array(z.object({ code: z.string(), weight: z.number() })).optional(),
        reasoning: z.string().optional(),
        recognised: z.boolean().optional().describe('true if you believe you recognised the real country, period or companies'),
        country: z.string().optional(),
        year: z.union([z.string(), z.number()]).optional(),
        month: z.union([z.string(), z.number()]).optional(),
        guesses: z.array(z.object({ code: z.string(), company: z.string(), confidence: z.string().optional() })).optional(),
        confidence: z.string().optional()
      })
    }
  },
  async ({ id, answer }) => ok(await json('/api/backtest/blind/submit', { id, answer }))
);

await server.connect(new StdioServerTransport());
