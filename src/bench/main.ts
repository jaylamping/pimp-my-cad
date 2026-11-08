import './bench.css';
import * as THREE from 'three';
import { loadMesh, subdivide, prepare, strideSamples, type Prepared } from './mesh';
import { buildThreadedBVH, type ThreadedBVH } from './bvh';
import { bvhFor, overhangCPU, wallCPU, distanceCPU, WALL_MAX } from './cpu';
import { GpuJsRunner, sharedDevice, type GpuJsMode } from './gpujs';
import { TslRunner } from './tsl';
import { WebGPURenderer } from 'three/webgpu';
import { HeatView, legend, thresholds, type Workload } from './view';

// ---------------------------------------------------------------------------------------------
// Engines and result rows

type EngineId = 'cpu' | 'gpujs-webgl2' | 'gpujs-webgpu' | 'gpujs-webasm' | 'gpujs-cpu' | 'tsl';
const ENGINES: { id: EngineId; label: string; short: string; on: boolean }[] = [
  { id: 'cpu', label: 'CPU: three-mesh-bvh (reference)', short: 'CPU three-mesh-bvh', on: true },
  { id: 'gpujs-webgl2', label: 'gpu.js: WebGL2', short: 'gpu.js WebGL2', on: true },
  { id: 'gpujs-webgpu', label: 'gpu.js: WebGPU', short: 'gpu.js WebGPU', on: true },
  { id: 'gpujs-webasm', label: 'gpu.js: wasm SIMD + threads', short: 'gpu.js wasm', on: true },
  { id: 'gpujs-cpu', label: 'gpu.js: cpu (plain JS)', short: 'gpu.js cpu', on: false },
  { id: 'tsl', label: 'three: TSL compute (+ three-mesh-bvh WGSL)', short: 'three TSL', on: true },
];
const WORKLOADS: { id: Workload; label: string }[] = [
  { id: 'overhang', label: 'Overhang map' },
  { id: 'wall', label: 'Wall thickness (ray per sample)' },
  { id: 'distance', label: 'Distance to older revision' },
];
type Algo = 'direct' | 'bvh' | 'brute';

type Row = {
  workload: Workload; engine: EngineId; algo: Algo; k: number;
  samples: number; tris: number;
  coldMs?: number; warmMs?: number; gpuMs?: number | null; prepMs?: number;
  maxErr?: number; p99Err?: number; okPct?: number; signPct?: number;
  ranOn?: string; error?: string;
  /** which part / older revision / size this row was measured on (also what the JSON export records) */
  part?: string; rev?: string; meshKey?: string;
  values?: Float32Array; // only for full-sample rows, so they can be painted
};

const rows: Row[] = [];
/** Names come from file names, so they are escaped before going into innerHTML. */
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** Every row is stamped with the mesh it was measured on, so it can't be painted onto another one. */
const pushRow = (r: Row) => { if (current) { r.part = current.B.name; r.rev = current.A?.name; r.meshKey = current.key; } rows.push(r); };
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);

// ---------------------------------------------------------------------------------------------
// UI setup

let view: HeatView;
let tsl: TslRunner;
type Rev = { name: string; url: string; fileName?: string };
let library: { name: string; url: string; fileName?: string; revisions: Rev[] }[] = [];
let current: { key: string; B: Prepared; A: Prepared | null } | null = null;
let shown: Row | null = null;

function engineChecks() {
  $('engines').innerHTML = ENGINES.map((e) => `<label><input type="checkbox" data-engine="${e.id}" ${e.on ? 'checked' : ''}/> ${e.label} <i id="avail-${e.id}"></i></label>`).join('');
  $('workloads').innerHTML = WORKLOADS.map((w) => `<label><input type="checkbox" data-workload="${w.id}" checked/> ${w.label}</label>`).join('');
}
const selectedEngines = () => ENGINES.filter((e) => ($(`engines`).querySelector(`[data-engine="${e.id}"]`) as HTMLInputElement).checked).map((e) => e.id);
const selectedWorkloads = () => WORKLOADS.filter((w) => ($(`workloads`).querySelector(`[data-workload="${w.id}"]`) as HTMLInputElement).checked).map((w) => w.id);

async function loadLibrary() {
  try {
    library = (await (await fetch('/samples/bench.json')).json()).meshes;
  } catch {
    library = [];
    status('No sample meshes yet: run `npm run bench:samples`, or use Open part… below.');
  }
  fillParts();
  if (params.get('mesh')) $<HTMLSelectElement>('mesh').value = String(Math.max(0, library.findIndex((m) => m.name === params.get('mesh'))));
  $<HTMLSelectElement>('mesh').onchange = () => { fillRevisions(); void ensureLoaded(); };
  fillRevisions();
}
function fillParts(select?: number) {
  const sel = $<HTMLSelectElement>('mesh');
  sel.innerHTML = library.length ? library.map((m, i) => `<option value="${i}">${esc(m.name)}</option>`).join('') : '<option value="-1">(none: open a part)</option>';
  if (select != null) sel.value = String(select);
}
/** Files picked from disk. Blob URLs keep them in the browser; nothing is uploaded. */
async function openFiles(files: FileList | null, asRevision: boolean) {
  if (!files?.length) return;
  if (asRevision) {
    const m = library[+$<HTMLSelectElement>('mesh').value];
    if (!m) { status('Open a part first, then its older revision.'); return; }
    const f = files[0];
    m.revisions.push({ name: f.name, url: URL.createObjectURL(f), fileName: f.name });
    fillRevisions();
    $<HTMLSelectElement>('rev').value = String(m.revisions.length - 1);
  } else {
    for (const f of Array.from(files)) library.push({ name: f.name.replace(/\.[^.]+$/, ''), url: URL.createObjectURL(f), fileName: f.name, revisions: [] });
    fillParts(library.length - 1);
    fillRevisions();
  }
  await ensureLoaded();
}
function fillRevisions() {
  const m = library[+$<HTMLSelectElement>('mesh').value];
  const revs = m?.revisions ?? [];
  $<HTMLSelectElement>('rev').innerHTML = revs.length
    ? revs.map((r, i) => `<option value="${i}">${esc(r.name)}</option>`).join('')
    : '<option value="-1">same part, shifted 0.3 mm in Z (no revisions listed)</option>';
}

/** Frees everything tied to the current mesh: TSL buffers + BVH, gpu.js runners and kernels. */
function releaseGpu() {
  tsl?.dispose();
  for (const g of gpujs.values()) g.destroy();
  gpujs.clear();
}

function status(s: string) { $('status').textContent = s; }
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------------------------
// Mesh preparation

async function ensureLoaded(): Promise<{ B: Prepared; A: Prepared | null }> {
  const m = library[+$<HTMLSelectElement>('mesh').value];
  if (!m) throw new Error('No part loaded. Run `npm run bench:samples` or use Open part…');
  const k = +$<HTMLSelectElement>('k').value;
  const ri = +$<HTMLSelectElement>('rev').value;
  const key = `${m.url}|${ri}|${k}`;
  if (current?.key === key) return current;
  releaseGpu(); // the previous part / size is about to be replaced: free its buffers, kernels and results
  status(`Loading ${m.name}…`);
  const B = prepare(subdivide(await loadMesh(m.url, m.fileName), k), m.name);
  let A: Prepared | null = null;
  if (ri >= 0 && m.revisions[ri]) {
    A = prepare(subdivide(await loadMesh(m.revisions[ri].url, m.revisions[ri].fileName), k), m.revisions[ri].name);
  } else {
    // no older revision: compare against the same part nudged 0.3 mm up, so the check still has
    // something to measure (every sample should read about -0.3 mm)
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(B.tris.slice(), 3));
    g.translate(0, 0, 0.3);
    A = prepare(g, `${m.name} +0.3 mm Z`);
  }
  current = { key, B, A };
  for (const r of rows) if (r.meshKey !== key) delete r.values; // other parts' results can no longer be painted
  view.show(B);
  view.paint(B, null, null);
  shown = null;
  status(`${m.name}: ${B.triCount.toLocaleString()} triangles, ${B.sampleCount.toLocaleString()} samples (k=${k})`);
  return current;
}

// ---------------------------------------------------------------------------------------------
// Measurement

function median(a: number[]) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

async function measure(fn: () => Promise<Float32Array>, runs: number, gpuTimed: boolean): Promise<{ v: Float32Array; cold: number; warm: number; gpu: number | null }> {
  let t = performance.now();
  let v = await fn();
  const cold = performance.now() - t;
  const warm: number[] = [];
  let gpu: number | null = null;
  // a cold run over ~8 s means warm runs would only repeat the pain
  for (let r = 0; r < runs && cold < 8000; r++) {
    await tick();
    t = performance.now();
    v = await fn();
    warm.push(performance.now() - t);
    gpu = gpuTimed ? (tsl?.lastGpuMs ?? null) : null; // timestamp queries only exist for three's dispatches
  }
  return { v, cold, warm: warm.length ? median(warm) : cold, gpu };
}

function compare(row: Row, v: Float32Array, ref: Float32Array, idx?: Uint32Array, signed = false) {
  const n = v.length;
  const errs = new Float32Array(n);
  let ok = 0, sign = 0;
  for (let i = 0; i < n; i++) {
    const r = ref[idx ? idx[i] : i];
    const e = Math.abs(v[i] - r); // signed distance is compared signed: a +5 mm vs -5 mm flip is a 10 mm error
    errs[i] = Number.isFinite(e) ? e : 1e9;
    if (errs[i] <= 0.01) ok++;
    if (signed && (Math.abs(r) < 1e-3 || Math.sign(v[i]) === Math.sign(r))) sign++;
  }
  errs.sort();
  row.maxErr = errs[n - 1];
  row.p99Err = errs[Math.min(n - 1, Math.floor(n * 0.99))];
  row.okPct = (100 * ok) / n;
  if (signed) row.signPct = (100 * sign) / n;
}

type Ctx = {
  B: Prepared; A: Prepared | null; k: number; runs: number; bruteCap: number; brute: boolean;
  refs: Partial<Record<Workload, Float32Array>>;
  sub: ReturnType<typeof strideSamples>;
  tbvhB?: ThreadedBVH; tbvhA?: ThreadedBVH; tbvhMs: { B: number; A: number };
  bvhError?: string;
};

const gpujs = new Map<GpuJsMode, GpuJsRunner>();
const getGpuJs = (m: GpuJsMode) => { let r = gpujs.get(m); if (!r) { r = new GpuJsRunner(m); gpujs.set(m, r); } return r; };

async function runRow(ctx: Ctx, row: Row, fn: () => Promise<Float32Array>, ref: Float32Array, idx?: Uint32Array) {
  pushRow(row);
  renderTable();
  status(`${row.workload} · ${row.engine} · ${row.algo} · ${row.samples.toLocaleString()} samples…`);
  await tick();
  try {
    const m = await measure(fn, ctx.runs, row.engine === 'tsl');
    row.coldMs = m.cold; row.warmMs = m.warm; row.gpuMs = m.gpu;
    compare(row, m.v, ref, idx, row.workload === 'distance');
    if (!idx) row.values = m.v;
  } catch (e) {
    row.error = String((e as Error)?.message ?? e).slice(0, 300);
    console.error(e);
  }
  renderTable();
}

async function runEngine(ctx: Ctx, engine: EngineId, workloads: Workload[]) {
  const { B, A, k, sub } = ctx;
  const base = (w: Workload, algo: Algo, samples: number, tris: number): Row => ({ workload: w, engine, algo, k, samples, tris });
  const S = B.sampleCount;

  if (engine === 'cpu') return; // reference rows are added while computing the references

  if (engine.startsWith('gpujs-')) {
    const mode = engine.slice(6) as GpuJsMode;
    if (!(await GpuJsRunner.available(mode))) { pushRow({ ...base('overhang', 'direct', S, 0), error: `${mode} not available in this browser` }); renderTable(); return; }
    if (ctx.bvhError) { pushRow({ ...base(workloads.includes('wall') ? 'wall' : 'distance', 'bvh', S, B.triCount), error: ctx.bvhError }); renderTable(); return; }
    const r = getGpuJs(mode);
    const done = (row: Row) => { row.ranOn = r.ranOn(); renderTable(); };
    for (const w of workloads) {
      if (w === 'overhang') {
        const row = base(w, 'direct', S, B.triCount);
        await runRow(ctx, row, () => r.overhang(B.samples, B.normals, B.bounds.min.z), ctx.refs.overhang!); done(row);
      }
      if (w === 'wall') {
        const row = { ...base(w, 'bvh', S, B.triCount), prepMs: ctx.tbvhMs.B };
        await runRow(ctx, row, () => r.wallBVH(B.samples, B.normals, ctx.tbvhB!, WALL_MAX), ctx.refs.wall!); done(row);
        if (ctx.brute) {
          const rb = base(w, 'brute', sub.idx.length, B.triCount);
          await runRow(ctx, rb, () => r.wallBrute(sub.samples, sub.normals, B.tris, WALL_MAX), ctx.refs.wall!, sub.idx); done(rb);
        }
      }
      if (w === 'distance' && A) {
        const row = { ...base(w, 'bvh', S, A.triCount), prepMs: ctx.tbvhMs.A };
        await runRow(ctx, row, () => r.distBVH(B.samples, ctx.tbvhA!), ctx.refs.distance!); done(row);
        if (ctx.brute) {
          const rb = base(w, 'brute', sub.idx.length, A.triCount);
          await runRow(ctx, rb, () => r.distBrute(sub.samples, A.tris), ctx.refs.distance!, sub.idx); done(rb);
        }
      }
    }
    return;
  }

  if (engine === 'tsl') {
    const gpuOnly = (w: Workload, algo: Algo, n: number, tris: number) => {
      if (tsl.isWebGPU) return false;
      pushRow({ ...base(w, algo, n, tris), error: 'needs WebGPU (TSL on the WebGL2 fallback can only read its own element, no gathers / raw WGSL)' });
      renderTable();
      return true;
    };
    const tag = current!.key;
    for (const w of workloads) {
      if (w === 'overhang') {
        await runRow(ctx, base(w, 'direct', S, B.triCount), () => tsl.overhang(B, tag, B.samples, B.normals), ctx.refs.overhang!);
      }
      if (w === 'wall') {
        if (!gpuOnly(w, 'bvh', S, B.triCount)) {
          const prep = tsl.bvh(B).ms;
          await runRow(ctx, { ...base(w, 'bvh', S, B.triCount), prepMs: prep }, () => tsl.wallBVH(B, tag, B.samples, B.normals, WALL_MAX), ctx.refs.wall!);
        }
        if (ctx.brute && !gpuOnly(w, 'brute', sub.idx.length, B.triCount)) {
          await runRow(ctx, base(w, 'brute', sub.idx.length, B.triCount), () => tsl.wallBrute(B, tag + ':sub', sub.samples, sub.normals, WALL_MAX), ctx.refs.wall!, sub.idx);
        }
      }
      if (w === 'distance' && A) {
        if (!gpuOnly(w, 'bvh', S, A.triCount)) {
          const prep = tsl.bvh(A).ms;
          await runRow(ctx, { ...base(w, 'bvh', S, A.triCount), prepMs: prep }, () => tsl.distBVH(A, tag, B.samples), ctx.refs.distance!);
        }
        if (ctx.brute && !gpuOnly(w, 'brute', sub.idx.length, A.triCount)) {
          await runRow(ctx, base(w, 'brute', sub.idx.length, A.triCount), () => tsl.distBrute(A, tag + ':sub', sub.samples), ctx.refs.distance!, sub.idx);
        }
      }
    }
  }
}

/** One full pass at the current settings. */
async function runAll(opts: { sweepK?: number } = {}): Promise<void> {
  if (opts.sweepK) $<HTMLSelectElement>('k').value = String(opts.sweepK);
  const { B, A } = await ensureLoaded();
  const k = +$<HTMLSelectElement>('k').value;
  const workloads = selectedWorkloads();
  const engines = selectedEngines();
  const clamp = (v: number, lo: number, hi: number, d: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
  const runs = clamp(+$<HTMLInputElement>('runs').value, 1, 10, 3);
  const bruteCap = clamp(+$<HTMLInputElement>('bruteCap').value, 64, 200_000, 4096);
  for (const r of rows) delete r.values; // keep full result arrays for the newest run only
  shown = null;
  const ctx: Ctx = {
    B, A, k, runs, bruteCap,
    brute: $<HTMLInputElement>('brute').checked && !opts.sweepK,
    refs: {}, sub: strideSamples(B, bruteCap), tbvhMs: { B: 0, A: 0 },
  };

  // ground truth on the CPU; timed, and shown as the "cpu" engine's rows
  status('CPU reference (three-mesh-bvh)…');
  await tick();
  const cpuRow = (w: Workload, algo: Algo, tris: number, ms: number, prepMs: number, v: Float32Array): Row =>
    ({ workload: w, engine: 'cpu', algo, k, samples: B.sampleCount, tris, coldMs: ms, warmMs: ms, prepMs, maxErr: 0, p99Err: 0, okPct: 100, values: v, ranOn: 'main thread' });
  const time = <T>(f: () => T): [T, number] => { const t = performance.now(); const v = f(); return [v, performance.now() - t]; };
  if (workloads.includes('overhang')) {
    const [v, ms] = time(() => overhangCPU(B));
    ctx.refs.overhang = v;
    if (engines.includes('cpu')) pushRow(cpuRow('overhang', 'direct', B.triCount, ms, 0, v));
  }
  if (workloads.includes('wall')) {
    const [bvh, prep] = time(() => bvhFor(B));
    const [v, ms] = time(() => wallCPU(B, bvh));
    ctx.refs.wall = v;
    if (engines.includes('cpu')) pushRow(cpuRow('wall', 'bvh', B.triCount, ms, prep, v));
  }
  if (workloads.includes('distance') && A) {
    const [bvh, prep] = time(() => bvhFor(A));
    const [v, ms] = time(() => distanceCPU(bvh, B.samples));
    ctx.refs.distance = v;
    if (engines.includes('cpu')) pushRow(cpuRow('distance', 'bvh', A.triCount, ms, prep, v));
  }
  renderTable();

  if (engines.some((e) => e.startsWith('gpujs-'))) {
    // the gpu.js BVH can refuse a mesh (too many triangles for float32 addressing, too deep): that
    // becomes an error row for the gpu.js engines instead of aborting the whole run
    try {
      if (workloads.includes('wall')) { const [b, ms] = time(() => buildThreadedBVH(B.tris)); ctx.tbvhB = b; ctx.tbvhMs.B = ms; }
      if (workloads.includes('distance') && A) { const [b, ms] = time(() => buildThreadedBVH(A.tris)); ctx.tbvhA = b; ctx.tbvhMs.A = ms; }
    } catch (e) { ctx.bvhError = String((e as Error).message ?? e); }
  }

  for (const e of engines) await runEngine(ctx, e, workloads);
  if (!shown) { const r = rows.find((x) => x.values && x.workload === workloads[workloads.length - 1]); if (r) paintRow(r); }
  status(`Done: ${B.name}, k=${k}, ${B.sampleCount.toLocaleString()} samples.`);
}

/**
 * "How far can we push it": k = 1, 2, 3, 4, 6 (up to 36x the triangles and samples). BVH paths
 * only. An engine drops out after its first error or a cold run over 15 s. k=8 is not offered:
 * it needed over 10 GB of browser memory and exceeds gpu.js's float32 array addressing.
 */
async function sweep() {
  const ks = [1, 2, 3, 4, 6];
  const dropped = new Set<EngineId>();
  const all = selectedEngines();
  const k0 = $<HTMLSelectElement>('k').value;
  const setEngines = (on: EngineId[]) => { for (const e of ENGINES) ($('engines').querySelector(`[data-engine="${e.id}"]`) as HTMLInputElement).checked = on.includes(e.id); };
  try {
    for (const k of ks) {
      const live = all.filter((e) => !dropped.has(e));
      if (!live.length) break;
      setEngines(live); // temporarily narrow the engine checkboxes to the survivors
      const before = rows.length;
      await runAll({ sweepK: k });
      for (const r of rows.slice(before)) {
        // CPU-bound engines (wasm, plain JS) are cut off above 2M samples: they scale linearly and
        // their working memory is what ran away at k=8
        if (r.error || (r.coldMs ?? 0) > 15000 || (['gpujs-webasm', 'gpujs-cpu'].includes(r.engine) && r.samples > 2_000_000)) dropped.add(r.engine);
      }
      await tick();
    }
  } finally {
    setEngines(all);
    $<HTMLSelectElement>('k').value = k0;
    shown = null;
    current = null; // drop the big meshes, then show the small one again
    releaseGpu();
    await ensureLoaded();
  }
}

// ---------------------------------------------------------------------------------------------
// Results table + painting

const fmt = (v: number | undefined | null, d = 1) => (v == null || !Number.isFinite(v) ? '' : v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(d));
const label = (id: EngineId) => ENGINES.find((e) => e.id === id)!.short;

function renderTable() {
  const body = rows.map((r, i) => {
    const thr = r.warmMs ? (r.samples / r.warmMs / 1000) : 0; // M samples / s
    const err = r.error ? `<td colspan="6" class="err">${esc(r.error)}</td>` : `
      <td>${fmt(r.coldMs, 0)}</td><td><b>${fmt(r.warmMs, 1)}</b></td><td>${fmt(r.gpuMs ?? undefined, 1)}</td>
      <td>${thr ? thr.toFixed(thr < 1 ? 3 : 1) : ''}</td><td>${fmt(r.maxErr, 4)}</td>
      <td>${r.okPct != null ? r.okPct.toFixed(r.okPct > 99.9 && r.okPct < 100 ? 2 : 1) + '%' : ''}${r.signPct != null ? ` <small>sign ${r.signPct.toFixed(1)}%</small>` : ''}</td>`;
    return `<tr data-i="${i}" class="${r.values ? 'paintable' : ''} ${shown === r ? 'shown' : ''}">
      <td>${r.workload}</td><td>${label(r.engine)}${r.ranOn && r.engine.startsWith('gpujs-') && !r.engine.endsWith(r.ranOn) ? ` <small class="warn">(fell back to ${r.ranOn})</small>` : ''}</td><td>${r.algo}</td><td>${r.k}</td>
      <td>${r.samples.toLocaleString()}</td><td>${r.tris.toLocaleString()}</td><td>${fmt(r.prepMs, 0)}</td>${err}</tr>`;
  }).join('');
  $('rows').innerHTML = body;
}

function paintRow(r: Row) {
  if (!current || !r.values) return;
  if (r.meshKey !== current.key) { status(`That result was measured on ${r.part} (k=${r.k}); load the same part and size to paint it.`); return; }
  shown = r;
  view.paint(current.B, r.workload, r.values);
  const lg = legend(r.workload);
  $('legend').innerHTML = `<div class="bar" style="background:${lg.gradient}"></div><div class="ticks">${lg.ticks.map((t) => `<span>${t}</span>`).join('')}</div>
    <div class="cap">${r.workload} · ${label(r.engine)} · ${r.algo}</div>`;
  renderTable();
}

async function environment() {
  const env: Record<string, unknown> = {
    ua: navigator.userAgent, viewport: `${innerWidth}x${innerHeight}@${devicePixelRatio}`,
    cores: navigator.hardwareConcurrency, crossOriginIsolated, displayBackend: view.backendName, computeBackend: tsl.isWebGPU ? 'WebGPU' : 'WebGL2',
  };
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    env.webgl = ext ? gl!.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl ? 'webgl2 (renderer hidden)' : 'none';
  } catch { env.webgl = 'error'; }
  // read the adapter info off three's own device rather than requesting another adapter
  const dev = (tsl.renderer.backend as unknown as { device?: { adapterInfo?: Record<string, string> } }).device;
  const info = dev?.adapterInfo;
  env.webgpu = tsl.isWebGPU
    ? (info ? [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' / ') || 'adapter (no info)' : 'adapter')
    : ('gpu' in navigator ? 'API present, no adapter' : 'none');
  return env;
}

function resultsJSON(env: Record<string, unknown>) {
  return JSON.stringify({
    date: new Date().toISOString(), env, thresholds,
    rows: rows.map(({ values, ...r }) => { void values; return r; }),
  }, null, 1);
}

// ---------------------------------------------------------------------------------------------
// Boot

async function main() {
  engineChecks();
  const forceWebGL = params.has('webgl') || !('gpu' in navigator);
  const dsel = $<HTMLSelectElement>('display');
  dsel.value = params.get('display') === 'webgl' || params.has('webgl') ? 'webgl' : 'auto';
  // the renderer is created once at startup, so switching reloads the page with ?display=...
  dsel.onchange = () => { const q = new URLSearchParams(location.search); q.delete('webgl'); q.delete('auto'); if (dsel.value === 'webgl') q.set('display', 'webgl'); else q.delete('display'); location.search = q.toString(); };
  let device: GPUDevice | undefined;
  if (!forceWebGL && !params.has('separate-devices')) {
    try { device = await sharedDevice(); } catch (e) { console.warn('shared device failed', e); }
  }
  // Display and compute use separate three renderers on the same device: the compute one never
  // touches a canvas, so ?display=webgl can show results through WebGL while TSL still computes
  // on WebGPU (headless Chromium's software WebGPU can't present to a canvas).
  view = new HeatView($('view'), forceWebGL || params.get('display') === 'webgl', device);
  await view.init();
  let computeRenderer = view.renderer;
  if (!forceWebGL) {
    computeRenderer = new WebGPURenderer({ device, trackTimestamp: true } as never);
    await computeRenderer.init();
  }
  tsl = new TslRunner(computeRenderer);
  const env = await environment();
  $('env').textContent = `display: ${env.displayBackend} · compute: ${env.computeBackend} · WebGPU: ${env.webgpu} · WebGL: ${env.webgl} · cores: ${env.cores} · isolated: ${env.crossOriginIsolated}`;
  for (const e of ENGINES) {
    if (!e.id.startsWith('gpujs-')) continue;
    const ok = await GpuJsRunner.available(e.id.slice(6) as GpuJsMode);
    $(`avail-${e.id}`).textContent = ok ? '' : '(not available)';
  }
  if (!tsl.isWebGPU) $('avail-tsl').textContent = '(WebGL2 fallback: overhang only)';
  await loadLibrary();
  if (params.get('k')) $<HTMLSelectElement>('k').value = params.get('k')!;
  if (params.get('rev')) $<HTMLSelectElement>('rev').value = params.get('rev')!;
  if (params.get('engines')) {
    const want = params.get('engines')!.split(',');
    for (const e of ENGINES) ($('engines').querySelector(`[data-engine="${e.id}"]`) as HTMLInputElement).checked = want.includes(e.id);
  }
  if (params.get('runs')) $<HTMLInputElement>('runs').value = params.get('runs')!;
  if (params.get('brute') === '0') $<HTMLInputElement>('brute').checked = false;

  let running = false;
  const busy = async (f: () => Promise<void>) => {
    if (running) return;
    running = true;
    document.body.classList.add('busy');
    view.pause();
    try { await f(); } catch (e) { status(`Error: ${(e as Error).message}`); console.error(e); }
    view.resume();
    document.body.classList.remove('busy');
    running = false;
  };
  $<HTMLInputElement>('openPart').onchange = (e) => busy(() => openFiles((e.target as HTMLInputElement).files, false));
  $<HTMLInputElement>('openRev').onchange = (e) => busy(() => openFiles((e.target as HTMLInputElement).files, true));
  $('run').onclick = () => busy(() => runAll());
  $('sweep').onclick = () => busy(sweep);
  $('clear').onclick = () => { rows.length = 0; shown = null; if (current) view.paint(current.B, null, null); $('legend').innerHTML = ''; renderTable(); };
  $('copy').onclick = async () => {
    const json = resultsJSON(env);
    try { await navigator.clipboard.writeText(json); status('Results JSON copied.'); } catch { status('Clipboard blocked; results JSON is in the console.'); }
    console.log(json);
  };
  $('download').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([resultsJSON(env)], { type: 'application/json' }));
    a.download = `bench-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };
  $('rows').onclick = (ev) => {
    const tr = (ev.target as HTMLElement).closest('tr');
    const r = tr ? rows[+tr.dataset.i!] : null;
    if (r?.values) paintRow(r);
  };
  for (const id of ['thinWall', 'overhangDeg', 'distRange'] as const) {
    $<HTMLInputElement>(id).oninput = () => {
      thresholds.thinWall = +$<HTMLInputElement>('thinWall').value;
      thresholds.overhang = +$<HTMLInputElement>('overhangDeg').value;
      thresholds.distRange = +$<HTMLInputElement>('distRange').value;
      if (shown) paintRow(shown);
    };
  }

  if (library.length) await busy(() => ensureLoaded().then(() => undefined));

  // ?auto=1 runs once (or ?auto=sweep) and exposes the JSON for scripted runs
  const auto = params.get('auto');
  if (auto) {
    await busy(auto === 'sweep' ? sweep : () => runAll());
    (window as unknown as { __bench: string }).__bench = resultsJSON(env);
  }
}

void main().catch((e) => { status(`Startup failed: ${(e as Error).message}`); console.error(e); });
