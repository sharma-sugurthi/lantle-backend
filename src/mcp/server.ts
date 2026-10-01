#!/usr/bin/env node
/**
 * Lantle MCP server: lets Claude, ChatGPT and other MCP clients look up tools, alternatives and comparisons from the
 * directory. Stdio transport, no credentials; it calls the public /api/v1 endpoints.
 *
 *   LANTLE_API_BASE=https://api.lantle.ai node dist/mcp/server.js
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const base = (process.env.LANTLE_API_BASE ?? 'https://api.lantle.ai').replace(/\/$/, '');

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${base}${path}`, { headers: { accept: 'application/json', 'user-agent': 'lantle-mcp/1.0' } });
  if (!res.ok) throw new Error(`Lantle API ${res.status} for ${path}`);
  return res.json();
}
const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });

const server = new McpServer({ name: 'lantle', version: '1.0.0' });

server.registerTool('lantle_find_tools', {
  title: 'Find business software tools',
  description: 'Search the Lantle directory of reviewed AI and business software. Filter by free-text query, vertical (e.g. finance, marketing, developer), category and pricing model (Free, Freemium, Paid, Enterprise). Results are in editorial order; paid placement never affects it.',
  inputSchema: { q: z.string().optional(), vertical: z.string().optional(), category: z.string().optional(), pricing: z.enum(['Free', 'Freemium', 'Paid', 'Enterprise']).optional(), limit: z.number().int().min(1).max(50).optional() },
}, async (args) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) if (v != null && v !== '') p.set(k, String(v));
  if (!p.has('limit')) p.set('limit', '20');
  return text(await get(`/api/v1/tools?${p}`));
});

server.registerTool('lantle_tool_details', {
  title: 'Tool details',
  description: 'Full structured facts for one tool by slug: pricing, starting price, free plan, trial, platforms, integrations, pros, cons, best for, verdict line, review URL and when the data was last checked against the vendor.',
  inputSchema: { slug: z.string() },
}, async ({ slug }) => text(await get(`/api/v1/tools/${encodeURIComponent(slug)}`)));

server.registerTool('lantle_alternatives', {
  title: 'Alternatives to a tool',
  description: 'Same-category alternatives to a tool, in editorial order, with the URL of the alternatives page.',
  inputSchema: { slug: z.string() },
}, async ({ slug }) => text(await get(`/api/v1/tools/${encodeURIComponent(slug)}/alternatives`)));

server.registerTool('lantle_compare', {
  title: 'Compare two tools',
  description: 'Side-by-side facts for two tools plus the editorial verdict when one exists, and the URL of the comparison page.',
  inputSchema: { a: z.string(), b: z.string() },
}, async ({ a, b }) => text(await get(`/api/v1/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`)));

server.registerTool('lantle_deals', {
  title: 'Current deals',
  description: 'Discount codes and offers that listed vendors have attached to their tools, with the page where each applies.',
  inputSchema: {},
}, async () => text(await get('/api/v1/deals')));

const transport = new StdioServerTransport();
await server.connect(transport);
