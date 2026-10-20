/**
 * Smoke test: start the MCP server over stdio exactly as Claude Code does,
 * list its tools and call the ones given on the command line.
 *
 *   node mcp/scripts/check.js                       # status + tool list
 *   node mcp/scripts/check.js get_xray '{"currency":"PKR","sections":["warnings"]}'
 *   node mcp/scripts/check.js get_xray '{}' --full   # untruncated, for piping
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [join(here, '..', 'server.js')], env: process.env });
const client = new Client({ name: 'check', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
if (!process.argv.includes('--full')) console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);

const full = process.argv.includes('--full');
const [name = 'stock_status', rawArgs = '{}'] = process.argv.slice(2).filter((a) => a !== '--full');
// Model runs can take a while; the SDK's default request timeout is 60s.
const res = await client.callTool({ name, arguments: JSON.parse(rawArgs) }, undefined, { timeout: 300000 });
const text = res.content?.map((c) => c.text).join('\n') || '';
console.log(res.isError ? `ERROR ${text}` : !full && text.length > 6000 ? `${text.slice(0, 6000)}\n... (${text.length} chars)` : text);
await client.close();
