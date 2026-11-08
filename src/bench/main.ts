import './bench.css';
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
  values?: Float32Array; // only for full-sample rows, so they can be painted
};

const rows: Row[] = [];
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);

// ---------------------------------------------------------------------------------------------
// UI setup

let view: HeatView;
let tsl: TslRunner;
let library: { name: string; url: string; revisions: { name: string; url: string }[] }[] = [];
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
    status('No public/samples/bench.json. Run scripts/fetch-bench-samples.sh, or open a file.');
  }
  const sel = $<HTMLSelectElement>('mesh');
  sel.innerHTML = library.map((m, i) => `<option value="${i}">${m.name}</option>`).join('');
  if (params.get('mesh')) sel.value = String(Math.max(0, library.findIndex((m) => m.name === params.get('mesh'))));
  sel.onchange = () => { fillRevisions(); void ensureLoaded(); };
  fillRevisions();
}
function fillRevisions() {
  const m = library[+$<HTMLSelectElement>('mesh').value];
  const revs = m?.revisions ?? [];
  $<HTMLSelectElement>('rev').innerHTML = revs.length
    ? revs.map((r, i) => `<option value="${i}">${r.name}</option>`).join('')
    : '<option value="-1">same part, shifted 0.3 mm in Z (no revisions listed)</option>';
}

function status(s: string) { $('status').textContent = s; }
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------------------------
// Mesh preparation

async function ensureLoaded(): Promise<{ B: Prepared; A: Prepared | null }> {
  const m = library[+$<HTMLSelectElement>('mesh').value];
  const k = +$<HTMLSelectElement>('k').value;
  const ri = +$<HTMLSelectElement>('rev').value;
  const key = `${m.url}|${ri}|${k}`;
  if (current?.key === key) return current;
  status(`Loading ${m.name}…`);
  const B = prepare(subdivide(await loadMesh(m.url), k), m.name);
  let A: Prepared | null = null;
  if (ri >= 0 && m.revisions[ri]) {
    A = prepare(subdivide(await loadMesh(m.revisions[ri].url), k), m.revisions[ri].name);
  } else {
    // no older revision: compare against the same part nudged 0.3 mm up, so the check still has
    // something to measure (every sample should read about -0.3 mm)
    const g = subdivide(await loadMesh(m.url), k);
    g.translate(0, 0, 0.3);
    A = prepare(g, `${m.name} +0.3 mm Z`);
  }
  current = { key, B, A };
  view.show(B);
  view.paint(B, null, null);
  shown = null;
  status(`${m.name}: ${B.triCount.toLocaleString()} triangles, ${B.sampleCount.toLocaleString()} samples (k=${k})`);
  return current;
}

// ---------------------------------------------------------------------------------------------
// Measurement

function median(a: number[]) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

async function measure(fn: () => Promise<Float32Array>, runs: number): Promise<{ v: Float32Array; cold: number; warm: number; gpu: number | null }> {
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
    gpu = tsl?.lastGpuMs ?? null;
  }
  return { v, cold, warm: warm.length ? median(warm) : cold, gpu };
}

function compare(row: Row, v: Float32Array, ref: Float32Array, idx?: Uint32Array, signed = false) {
  const n = v.length;
  const errs = new Float32Array(n);
  let ok = 0, sign = 0;
  for (let i = 0; i < n; i++) {
    const r = ref[idx ? idx[i] : i];
    const e = signed ? Math.abs(Math.abs(v[i]) - Math.abs(r)) : Math.abs(v[i] - r);
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
  distSub?: Float32Array;
};

const gpujs = new Map<GpuJsMode, GpuJsRunner>();
const getGpuJs = (m: GpuJsMode) => { let r = gpujs.get(m); if (!r) { r = new GpuJsRunner(m); gpujs.set(m, r); } return r; };

async function runRow(ctx: Ctx, row: Row, fn: () => Promise<Float32Array>, ref: Float32Array, idx?: Uint32Array) {
  rows.push(row);
  renderTable();
  status(`${row.workload} · ${row.engine} · ${row.algo} · ${row.samples.toLocaleString()} samples…`);
  await tick();
  try {
    const m = await measure(fn, ctx.runs);
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
    if (!(await GpuJsRunner.available(mode))) { rows.push({ ...base('overhang', 'direct', S, 0), error: `${mode} not available in this browser` }); renderTable(); return; }
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
      rows.push({ ...base(w, algo, n, tris), error: 'needs WebGPU (TSL on the WebGL2 fallback can only read its own element, no gathers / raw WGSL)' });
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
  const ctx: Ctx = {
    B, A, k, runs: +$<HTMLInputElement>('runs').value, bruteCap: +$<HTMLInputElement>('bruteCap').value,
    brute: $<HTMLInputElement>('brute').checked && !opts.sweepK,
    refs: {}, sub: strideSamples(B, +$<HTMLInputElement>('bruteCap').value), tbvhMs: { B: 0, A: 0 },
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
    if (engines.includes('cpu')) rows.push(cpuRow('overhang', 'direct', B.triCount, ms, 0, v));
  }
  if (workloads.includes('wall')) {
    const [bvh, prep] = time(() => bvhFor(B));
    const [v, ms] = time(() => wallCPU(B, bvh));
    ctx.refs.wall = v;
    if (engines.includes('cpu')) rows.push(cpuRow('wall', 'bvh', B.triCount, ms, prep, v));
  }
  if (workloads.includes('distance') && A) {
    const [bvh, prep] = time(() => bvhFor(A));
    const [v, ms] = time(() => distanceCPU(bvh, B.samples));
    ctx.refs.distance = v;
    if (engines.includes('cpu')) rows.push(cpuRow('distance', 'bvh', A.triCount, ms, prep, v));
  }
  renderTable();

  if (engines.some((e) => e.startsWith('gpujs-'))) {
    if (workloads.includes('wall')) { const [b, ms] = time(() => buildThreadedBVH(B.tris)); ctx.tbvhB = b; ctx.tbvhMs.B = ms; }
    if (workloads.includes('distance') && A) { const [b, ms] = time(() => buildThreadedBVH(A.tris)); ctx.tbvhA = b; ctx.tbvhMs.A = ms; }
  }

  for (const e of engines) await runEngine(ctx, e, workloads);
  if (!shown) { const r = rows.find((x) => x.values && x.workload === workloads[workloads.length - 1]); if (r) paintRow(r); }
  status(`Done: ${B.name}, k=${k}, ${B.sampleCount.toLocaleString()} samples.`);
}

/**
 * "How far can we push it": BVH paths only, k = 1, 2, 3, 4, 6, 8 (up to 64x the triangles and
 * samples). An engine drops out after its first error or a cold run over 15 s.
 */
async function sweep() {
  const ks = [1, 2, 3, 4, 6, 8];
  const dropped = new Set<EngineId>();
  const all = selectedEngines();
  for (const k of ks) {
    const live = all.filter((e) => !dropped.has(e));
    if (!live.length) break;
    // temporarily narrow the engine checkboxes to the survivors
    for (const e of ENGINES) ($('engines').querySelector(`[data-engine="${e.id}"]`) as HTMLInputElement).checked = live.includes(e.id);
    const before = rows.length;
    await runAll({ sweepK: k });
    for (const r of rows.slice(before)) if (r.error || (r.coldMs ?? 0) > 15000) dropped.add(r.engine);
  }
  for (const e of ENGINES) ($('engines').querySelector(`[data-engine="${e.id}"]`) as HTMLInputElement).checked = all.includes(e.id);
}

// ---------------------------------------------------------------------------------------------
// Results table + painting

const fmt = (v: number | undefined | null, d = 1) => (v == null || !Number.isFinite(v) ? '' : v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(d));
const label = (id: EngineId) => ENGINES.find((e) => e.id === id)!.short;

function renderTable() {
  const body = rows.map((r, i) => {
    const thr = r.warmMs ? (r.samples / r.warmMs / 1000) : 0; // M samples / s
    const err = r.error ? `<td colspan="6" class="err">${r.error}</td>` : `
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
  if (library.length) await ensureLoaded();

  const busy = async (f: () => Promise<void>) => {
    document.body.classList.add('busy');
    view.pause();
    try { await f(); } catch (e) { status(`Error: ${(e as Error).message}`); console.error(e); }
    view.resume();
    document.body.classList.remove('busy');
  };
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

  // ?auto=1 runs once (or ?auto=sweep) and exposes the JSON for scripted runs
  const auto = params.get('auto');
  if (auto) {
    await busy(auto === 'sweep' ? sweep : () => runAll());
    (window as unknown as { __bench: string }).__bench = resultsJSON(env);
  }
}

void main();
