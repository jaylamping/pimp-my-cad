// Import a read-only CAD folder into the store by hash. The originals are never touched.
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { storeFile, type Deps } from './app';

const EXT = /\.(step|stp|3mf|stl|glb|gltf)$/i;

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && EXT.test(e.name)) yield p;
  }
}

export async function importDir(d: Deps, ws: string, root: string) {
  const known = new Map(
    (await d.db.query('select path, size from files where workspace_id=$1 and path is not null', [ws])).rows.map((r) => [r.path, Number(r.size)]));
  let imported = 0, skipped = 0;
  for await (const p of walk(root)) {
    const rel = relative(root, p).split(sep).join('/');
    const bytes = await readFile(p);
    if (known.get(rel) === bytes.length) { skipped++; continue; } // cheap re-scan; hash check still dedupes on change
    await storeFile(d, ws, bytes, p.split(sep).pop()!, rel);
    imported++;
  }
  return { imported, skipped };
}
