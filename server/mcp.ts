// MCP server over stdio. Agents (Claude Code, Codex, Cursor, Gemini CLI) start it
// themselves; it talks to the pimp-my-cad API with a scoped token and never
// touches storage directly.
//   PIMP_API_URL=http://localhost:8080 PIMP_TOKEN=... npx tsx server/mcp.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const base = (process.env.PIMP_API_URL || 'http://localhost:8080').replace(/\/$/, '');
const token = process.env.PIMP_TOKEN || '';
if (!token) { console.error('Set PIMP_TOKEN to an API token'); process.exit(1); }

async function api(path: string, init: RequestInit = {}) {
  const r = await fetch(base + path, {
    ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${t}`);
  return t;
}
const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

const server = new McpServer({ name: 'pimp-my-cad', version: '0.1.0' });

server.tool('list_files', 'List the CAD files in the workspace (sha256 identifies a revision).', {},
  async () => text(await api('/api/files')));

server.tool('get_part_tree', 'Assembly part tree of a STEP file (converts on first use).', { sha256: z.string() },
  async ({ sha256 }) => text(await api(`/api/files/${sha256}/tree`)));

server.tool('list_comments', 'Review comments on a file revision: part, anchor, severity, text, suggested fix, status.',
  { sha256: z.string(), status: z.enum(['open', 'fixed', 'wontfix']).optional() },
  async ({ sha256, status }) => {
    const doc = JSON.parse(await api(`/api/files/${sha256}/review`));
    if (status) doc.comments = doc.comments.filter((c: { status: string }) => c.status === status);
    return text(JSON.stringify(doc, null, 2));
  });

server.tool('add_comment', 'Pin a comment on a part. anchor.p / anchor.n are part-local millimetres and a unit normal.',
  {
    sha256: z.string(), part: z.string(),
    anchor: z.object({ p: z.tuple([z.number(), z.number(), z.number()]), n: z.tuple([z.number(), z.number(), z.number()]) }),
    severity: z.enum(['blocker', 'major', 'minor', 'note']), text: z.string(), fix: z.string().optional(),
  },
  async ({ sha256, ...body }) => text(await api(`/api/files/${sha256}/comments`, { method: 'POST', body: JSON.stringify(body) })));

server.tool('set_comment_status', 'Mark a comment open, fixed or wontfix, with an optional note.',
  { id: z.string(), status: z.enum(['open', 'fixed', 'wontfix']), note: z.string().optional(), rev: z.string().optional() },
  async ({ id, ...body }) => text(await api(`/api/comments/${id}`, { method: 'PATCH', body: JSON.stringify(body) })));

await server.connect(new StdioServerTransport());
