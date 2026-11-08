import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type pg from 'pg';
import type { BlobStore } from './blobs';
import { keys } from './blobs';
import { convertStep, converterVersion } from './convert';
import type { Vault } from './crypto';
import { hashToken } from './db';
import { fold, type EventRow } from './review';
import { ulid } from './ulid';

type Scope = 'read' | 'comment' | 'admin';
const rank: Record<Scope, number> = { read: 0, comment: 1, admin: 2 };
type Env = { Variables: { ws: string; actor: string; scope: Scope } };

export interface Deps { db: pg.Pool; blobs: BlobStore; vault: Vault }
const SHA = /^[0-9a-f]{64}$/;
const MAX_UPLOAD = 512 * 1024 * 1024;

export async function storeFile(d: Deps, ws: string, bytes: Buffer, name: string, path?: string) {
  const sha = createHash('sha256').update(bytes).digest('hex');
  const key = keys.source(ws, sha);
  if (!(await d.blobs.has(key))) await d.blobs.put(key, bytes);
  await d.db.query(
    `insert into files (workspace_id, sha256, name, path, size) values ($1,$2,$3,$4,$5)
     on conflict (workspace_id, sha256) do update set name = excluded.name, path = coalesce(excluded.path, files.path)`,
    [ws, sha, name, path ?? null, bytes.length]);
  return { sha256: sha, name, size: bytes.length };
}

async function wrappedKey(d: Deps, ws: string): Promise<Buffer> {
  return (await d.db.query('select wrapped_key from workspaces where id=$1', [ws])).rows[0].wrapped_key;
}

export function createApp(d: Deps, rescan?: () => Promise<unknown>) {
  const app = new Hono<Env>();

  app.get('/health', (c) => c.text('ok'));

  // Bearer token, hashed at rest. Agents use scoped tokens (read / comment / admin).
  app.use('/api/*', async (c, next) => {
    const t = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1] ?? c.req.query('token');
    if (!t) return c.json({ error: 'missing bearer token' }, 401);
    const r = await d.db.query(
      `select workspace_id, name, scope from api_tokens
       where token_hash=$1 and revoked_at is null and (expires_at is null or expires_at > now())`, [hashToken(t)]);
    if (!r.rows[0]) return c.json({ error: 'invalid token' }, 401);
    c.set('ws', r.rows[0].workspace_id); c.set('actor', r.rows[0].name); c.set('scope', r.rows[0].scope);
    await next();
  });
  const need = (s: Scope) => async (c: any, next: any) =>
    rank[c.get('scope') as Scope] >= rank[s] ? next() : c.json({ error: `needs ${s} scope` }, 403);

  // ---- files
  app.get('/api/files', need('read'), async (c) => {
    const r = await d.db.query(
      `select sha256, name, path, size, created_at from files where workspace_id=$1 order by coalesce(path,name)`, [c.get('ws')]);
    return c.json(r.rows);
  });

  app.post('/api/files', need('admin'), async (c) => {
    const buf = Buffer.from(await c.req.arrayBuffer());
    if (!buf.length || buf.length > MAX_UPLOAD) return c.json({ error: 'empty or too large' }, 400);
    return c.json(await storeFile(d, c.get('ws'), buf, c.req.query('name') || 'upload', c.req.query('path')));
  });

  const blobResponse = async (c: any, key: string, type: string) => {
    const m = /^bytes=(\d+)-(\d*)$/.exec(c.req.header('range') ?? '');
    const o = await d.blobs.get(key, m ? { start: +m[1], end: m[2] ? +m[2] : undefined } : undefined);
    if (!o) return c.json({ error: 'not found' }, 404);
    const h: Record<string, string> = { 'content-type': o.contentType && o.contentType !== 'binary/octet-stream' ? o.contentType : type, 'accept-ranges': 'bytes', 'content-length': String(o.size) };
    if (m) h['content-range'] = `bytes ${m[1]}-${m[2] || o.total - 1}/${o.total}`;
    return new Response(Readable.toWeb(o.body) as ReadableStream, { status: m ? 206 : 200, headers: h });
  };
  const known = async (c: any) => {
    const sha = c.req.param('sha');
    if (!SHA.test(sha)) return null;
    const r = await d.db.query('select name from files where workspace_id=$1 and sha256=$2', [c.get('ws'), sha]);
    return r.rows[0] ? { sha, name: r.rows[0].name as string } : null;
  };

  app.get('/api/files/:sha/raw', need('read'), async (c) => {
    const f = await known(c);
    return f ? blobResponse(c, keys.source(c.get('ws'), f.sha), 'application/octet-stream') : c.json({ error: 'unknown file' }, 404);
  });

  // STEP -> GLB, converted once per source hash + converter version, then served from the store.
  const inflight = new Map<string, Promise<void>>();
  const ensureGlb = async (ws: string, sha: string, name: string) => {
    const gk = keys.glb(ws, sha, converterVersion);
    if (await d.blobs.has(gk)) return gk;
    const id = `${ws}/${sha}`;
    if (!inflight.has(id)) {
      inflight.set(id, (async () => {
        const src = await d.blobs.get(keys.source(ws, sha));
        if (!src) throw new Error('source missing from store');
        const chunks: Buffer[] = [];
        for await (const ch of src.body) chunks.push(ch as Buffer);
        const { glb, tree } = await convertStep(Buffer.concat(chunks), name);
        await d.blobs.put(keys.tree(ws, sha, converterVersion), tree, 'application/json');
        await d.blobs.put(gk, glb, 'model/gltf-binary');
      })().finally(() => inflight.delete(id)));
    }
    await inflight.get(id);
    return gk;
  };
  app.get('/api/files/:sha/glb', need('read'), async (c) => {
    const f = await known(c);
    if (!f) return c.json({ error: 'unknown file' }, 404);
    if (!/\.(step|stp)$/i.test(f.name)) return c.json({ error: 'not a STEP file' }, 400);
    try { return blobResponse(c, await ensureGlb(c.get('ws'), f.sha, f.name), 'model/gltf-binary'); }
    catch (e) { return c.json({ error: (e as Error).message }, 500); }
  });
  app.get('/api/files/:sha/tree', need('read'), async (c) => {
    const f = await known(c);
    if (!f) return c.json({ error: 'unknown file' }, 404);
    try { await ensureGlb(c.get('ws'), f.sha, f.name); } catch (e) { return c.json({ error: (e as Error).message }, 500); }
    return blobResponse(c, keys.tree(c.get('ws'), f.sha, converterVersion), 'application/json');
  });

  // ---- anchors: small encrypted record per file revision (part tree, fingerprints, frame)
  app.get('/api/files/:sha/anchors', need('read'), async (c) => {
    const f = await known(c);
    if (!f) return c.json({ error: 'unknown file' }, 404);
    const r = await d.db.query('select body from anchors where workspace_id=$1 and file_sha=$2', [c.get('ws'), f.sha]);
    if (!r.rows[0]) return c.json({ error: 'none yet' }, 404);
    return c.json(d.vault.decryptJson(await wrappedKey(d, c.get('ws')), r.rows[0].body));
  });
  app.put('/api/files/:sha/anchors', need('comment'), async (c) => {
    const f = await known(c);
    if (!f) return c.json({ error: 'unknown file' }, 404);
    const body = await c.req.json();
    const enc = d.vault.encryptJson(await wrappedKey(d, c.get('ws')), body);
    await d.db.query(
      `insert into anchors (workspace_id, file_sha, body) values ($1,$2,$3)
       on conflict (workspace_id, file_sha) do update set body=excluded.body, updated_at=now()`, [c.get('ws'), f.sha, enc]);
    return c.json({ ok: true });
  });

  // ---- comments (events)
  const events = async (ws: string, sha: string, after?: string): Promise<EventRow[]> => {
    const key = await wrappedKey(d, ws);
    const r = await d.db.query(
      `select id, type, actor, comment_id, created_at, payload from events
       where workspace_id=$1 and file_sha=$2 and id > $3 order by id`, [ws, sha, after ?? '']);
    return r.rows.map((x) => ({ ...x, payload: d.vault.decryptJson(key, x.payload) }));
  };

  // Folded view, the same ReviewDoc the viewer uses.
  app.get('/api/files/:sha/review', need('read'), async (c) => {
    const f = await known(c);
    if (!f) return c.json({ error: 'unknown file' }, 404);
    return c.json(fold(f.name, await events(c.get('ws'), f.sha)));
  });
  // Raw events, for export, sync and backup. ?after=<ulid> for incremental reads.
  app.get('/api/files/:sha/events', need('read'), async (c) => {
    const f = await known(c);
    if (!f) return c.json({ error: 'unknown file' }, 404);
    return c.json(await events(c.get('ws'), f.sha, c.req.query('after')));
  });

  const append = async (ws: string, actor: string, sha: string, commentId: string, type: string, payload: unknown) => {
    const id = ulid();
    await d.db.query(
      `insert into events (id, workspace_id, file_sha, comment_id, type, actor, payload) values ($1,$2,$3,$4,$5,$6,$7)`,
      [id, ws, sha, commentId, type, actor, d.vault.encryptJson(await wrappedKey(d, ws), payload)]);
    return id;
  };

  app.post('/api/files/:sha/comments', need('comment'), async (c) => {
    const f = await known(c);
    if (!f) return c.json({ error: 'unknown file' }, 404);
    const b = await c.req.json();
    const sev = ['blocker', 'major', 'minor', 'note'];
    if (typeof b.part !== 'string' || typeof b.text !== 'string' || !sev.includes(b.severity)
      || !Array.isArray(b.anchor?.p) || !Array.isArray(b.anchor?.n)) return c.json({ error: 'need part, anchor {p,n}, severity, text' }, 400);
    const id = ulid(); // the comment id is also the id of its first event's ULID family
    await append(c.get('ws'), c.get('actor'), f.sha, id, 'comment.add', {
      part: b.part, anchor: b.anchor, severity: b.severity, text: b.text, fix: b.fix,
      rev: f.sha, created: new Date().toISOString(),
    });
    return c.json({ id }, 201);
  });

  const commentFile = async (c: any, id: string) => {
    const r = await d.db.query(
      `select file_sha from events where workspace_id=$1 and comment_id=$2 and type='comment.add'`, [c.get('ws'), id]);
    return r.rows[0]?.file_sha as string | undefined;
  };
  app.patch('/api/comments/:id', need('comment'), async (c) => {
    const sha = await commentFile(c, c.req.param('id'));
    if (!sha) return c.json({ error: 'unknown comment' }, 404);
    const b = await c.req.json();
    if (b.status !== undefined) {
      if (!['open', 'fixed', 'wontfix'].includes(b.status)) return c.json({ error: 'bad status' }, 400);
      await append(c.get('ws'), c.get('actor'), sha, c.req.param('id'), 'comment.status', { status: b.status, note: b.note, rev: b.rev });
    }
    const edit: Record<string, unknown> = {};
    for (const k of ['severity', 'text', 'fix']) if (b[k] !== undefined) edit[k] = b[k];
    if (Object.keys(edit).length) await append(c.get('ws'), c.get('actor'), sha, c.req.param('id'), 'comment.edit', edit);
    return c.json({ ok: true });
  });

  app.post('/api/import', need('admin'), async (c) =>
    rescan ? c.json(await rescan()) : c.json({ error: 'IMPORT_DIR is not set' }, 400));

  // ---- tokens (admin)
  app.post('/api/tokens', need('admin'), async (c) => {
    const b = await c.req.json();
    if (!['read', 'comment', 'admin'].includes(b.scope) || !b.name) return c.json({ error: 'need name and scope' }, 400);
    const token = 'pmc_' + createHash('sha256').update(ulid() + Math.random()).digest('hex').slice(0, 40);
    await d.db.query(
      `insert into api_tokens (token_hash, workspace_id, name, scope, expires_at) values ($1,$2,$3,$4,$5)`,
      [hashToken(token), c.get('ws'), b.name, b.scope, b.expiresAt ?? null]);
    return c.json({ token }, 201); // shown once
  });

  return app;
}
