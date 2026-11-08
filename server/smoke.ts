// End-to-end check against a running stack:
//   PIMP_API_URL=http://localhost:8080 PIMP_TOKEN=<admin token> npx tsx server/smoke.ts
// Assumes the import folder is mounted (IMPORT_DIR) and contains at least one .step file.
import assert from 'node:assert/strict';
const base = process.env.PIMP_API_URL || 'http://localhost:8080';
const tok = process.env.PIMP_TOKEN || '';
const call = async (path: string, init: RequestInit = {}, t = tok) => {
  const r = await fetch(base + path, { ...init, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json', ...(init.headers as any) } });
  return r;
};
const json = async (path: string, init?: RequestInit, t?: string) => { const r = await call(path, init, t); assert.ok(r.ok, `${path} -> ${r.status} ${await r.clone().text()}`); return r.json() as Promise<any>; };

assert.equal((await call('/api/files', {}, 'wrong')).status, 401);
console.log('import', await json('/api/import', { method: 'POST' }));
const files = await json('/api/files');
const step = files.find((f: any) => /\.(step|stp)$/i.test(f.name));
assert.ok(step, 'no STEP file imported');
console.log('files', files.length, 'using', step.name, step.sha256.slice(0, 8));

const glb = await call(`/api/files/${step.sha256}/glb`);
assert.equal(glb.status, 200);
const bytes = Buffer.from(await glb.arrayBuffer());
assert.equal(bytes.subarray(0, 4).toString(), 'glTF');
const part = await call(`/api/files/${step.sha256}/glb`, { headers: { range: 'bytes=0-11' } });
assert.equal(part.status, 206);
assert.equal((await part.arrayBuffer()).byteLength, 12);
const tree = await json(`/api/files/${step.sha256}/tree`);
assert.ok(tree.tree);

// scoped tokens
const ro = (await json('/api/tokens', { method: 'POST', body: JSON.stringify({ name: 'reader', scope: 'read' }) })).token;
const agent = (await json('/api/tokens', { method: 'POST', body: JSON.stringify({ name: 'design-agent', scope: 'comment' }) })).token;
const c = { part: 'asm/plate-1', anchor: { p: [1, 2, 3], n: [0, 0, 1] }, severity: 'major', text: 'wall too thin', fix: 'add 1 mm' };
assert.equal((await call(`/api/files/${step.sha256}/comments`, { method: 'POST', body: JSON.stringify(c) }, ro)).status, 403);
const { id } = await json(`/api/files/${step.sha256}/comments`, { method: 'POST', body: JSON.stringify(c) }, agent);
await json(`/api/comments/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'fixed', note: 'done in rev B' }) }, agent);
const doc = await json(`/api/files/${step.sha256}/review`, {}, ro);
const got = doc.comments.find((x: any) => x.id === id);
assert.equal(got.status, 'fixed'); assert.equal(got.author, 'design-agent'); assert.equal(got.resolved.note, 'done in rev B');
assert.equal(got.rev, step.sha256);
const evs = await json(`/api/files/${step.sha256}/events`);
assert.ok(evs.length >= 2);

await json(`/api/files/${step.sha256}/anchors`, { method: 'PUT', body: JSON.stringify({ parts: { 'asm/plate-1': { tris: 12 } } }) }, agent);
assert.equal((await json(`/api/files/${step.sha256}/anchors`)).parts['asm/plate-1'].tris, 12);
console.log('smoke ok');
