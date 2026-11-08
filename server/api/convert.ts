// STEP -> GLB through tools/step2glb (OpenCascade). Output is stored by source hash.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config';

const script = resolve(dirname(fileURLToPath(import.meta.url)), '../../tools/step2glb/step2glb.py');
// a new converter version gets fresh derived keys
export const converterVersion = createHash('sha256').update(readFileSync(script)).digest('hex').slice(0, 12);

export async function convertStep(step: Buffer, name: string): Promise<{ glb: Buffer; tree: Buffer }> {
  const dir = await mkdtemp(join(tmpdir(), 'step2glb-'));
  try {
    const safe = name.replace(/[^\w.\- ()]/g, '_').replace(/^\.+/, '') || 'model.step';
    const src = join(dir, safe);
    const out = join(dir, safe.replace(/\.(step|stp)$/i, '') + '.glb');
    await writeFile(src, step);
    await new Promise<void>((ok, fail) => {
      const p = spawn(config.python, [script, src, '-o', out, '--tree', '--quiet'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('error', (e) => fail(new Error(`could not start ${config.python}: ${e.message}`)));
      p.on('close', (c) => (c === 0 ? ok() : fail(new Error(err.trim().split('\n').slice(-6).join('\n') || `exit ${c}`))));
    });
    return { glb: await readFile(out), tree: await readFile(out.replace(/\.glb$/, '.parts.json')) };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
