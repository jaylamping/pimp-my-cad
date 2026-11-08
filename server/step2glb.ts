// Vite plugin: POST /api/step2glb?name=<file.step> with the STEP bytes, get a GLB back.
//
// Runs tools/step2glb/step2glb.py (OpenCascade via cadquery-ocp) on the machine
// that serves the app, so a phone on the same Wi-Fi can open a full SolidWorks
// assembly without doing any CAD work itself. Results are cached by the STEP's
// SHA-256, so re-opening the same revision is instant.
//
// Python: set PIMP_PYTHON to the interpreter that has cadquery-ocp installed,
// otherwise "python3" (or "python" on Windows) from PATH.
import type { Plugin, Connect } from 'vite';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, '../tools/step2glb/step2glb.py');
const cacheDir = resolve(here, '../node_modules/.cache/step2glb');
const python = process.env.PIMP_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
// a new converter version gets a fresh cache
const scriptHash = createHash('sha256').update(readFileSync(script)).digest('hex').slice(0, 12);
const MAX_BYTES = 512 * 1024 * 1024;

const inflight = new Map<string, Promise<string>>();

function readBody(req: Connect.IncomingMessage): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const parts: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > MAX_BYTES) { fail(new Error('file too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => ok(Buffer.concat(parts)));
    req.on('error', fail);
  });
}

function run(args: string[]): Promise<void> {
  return new Promise((ok, fail) => {
    const p = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => fail(new Error(`could not start ${python}: ${e.message}. Install Python 3 and "pip install -r tools/step2glb/requirements.txt", or set PIMP_PYTHON.`)));
    p.on('close', (code) => (code === 0 ? ok() : fail(new Error(err.trim().split('\n').slice(-6).join('\n') || `exit ${code}`))));
  });
}

async function convert(step: Buffer, name: string): Promise<string> {
  const sha = createHash('sha256').update(step).digest('hex');
  // the source file name ends up in the GLB, so keep the real one (minus path tricks)
  const safe = name.replace(/[^\w.\- ()]/g, '_').replace(/^\.+/, '') || 'model.step';
  const dir = join(cacheDir, `${sha}-${scriptHash}`);
  const out = join(dir, safe.replace(/\.(step|stp)$/i, '') + '.glb');
  if (existsSync(out)) return out;
  if (!inflight.has(out)) {
    inflight.set(out, (async () => {
      await mkdir(dir, { recursive: true });
      const src = join(dir, safe);
      await writeFile(src, step);
      await run([script, src, '-o', out, '--tree', '--quiet']);
      return out;
    })().finally(() => inflight.delete(out)));
  }
  return inflight.get(out)!;
}

const middleware: Connect.NextHandleFunction = async (req, res, next) => {
  const url = new URL(req.url || '', 'http://local');
  if (!url.pathname.endsWith('/api/step2glb')) return next();
  if (req.method !== 'POST') { res.statusCode = 405; res.end('POST a STEP file'); return; }
  const t0 = Date.now();
  try {
    const name = url.searchParams.get('name') || 'model.step';
    const glb = await readFile(await convert(await readBody(req), name));
    res.setHeader('content-type', 'model/gltf-binary');
    res.setHeader('x-convert-ms', String(Date.now() - t0));
    res.end(glb);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end((e as Error).message);
  }
};

export function step2glb(): Plugin {
  return {
    name: 'pimp-my-cad:step2glb',
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}
