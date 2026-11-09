import * as THREE from 'three';
import { buildSoup, sources, queryTris, type Soup } from './soup';
import * as cpu from './cpu';
import { colour, legend, thresholds, type Check } from './colors';
import type { GpuChecks } from './gpu';
import { CpuRunner } from './cpuRunner';
import type { Viewer } from '../viewer';

export { thresholds, legend, type Check };

export class CancelledError extends Error { constructor() { super('cancelled'); } }

export type Report = { ms: number; samples: number; engine: 'webgpu' | 'cpu'; outliers: number; text: string };

/**
 * Print-check overlays: overhang (always CPU, ~1.5 ms), wall thickness and distance to a baseline
 * revision (GPU via three TSL + three-mesh-bvh when the webview has WebGPU, else CPU).
 * Results are per sample = per display vertex, painted into vertex colours.
 */
export class PrintChecks {
  private gpu: GpuChecks | null | undefined; // undefined = not tried yet
  private baseline: Soup | null = null;
  private cache = new Map<Check, { soupId: number; values: Float32Array }>();
  private soup: Soup | null = null;
  active: Check | null = null;
  /** Bumped by anything that invalidates in-flight runs (new run, clear, reset, baseline change). */
  private gen = 0;
  private cpuRunner = new CpuRunner();
  onBaseline: (label: string | null) => void = () => {};

  constructor(private viewer: Viewer) {}

  /** The model was replaced: drop everything tied to the old meshes (keeps the baseline). */
  reset() { this.gen++; this.cpuRunner.cancel(); this.soup = null; this.cache.clear(); this.active = null; }

  hasBaseline() { return !!this.baseline; }

  /** Snapshot of the current model as "the older revision" the distance check compares against. */
  captureBaseline(label = 'current model', includeHidden = false) {
    const soup = buildSoup(this.viewer.meshes, this.viewer.frameOffset(), includeHidden);
    if (!queryTris(soup).length) throw new Error('Nothing to use as a baseline (no visible triangles)');
    if (this.baseline) this.gpu?.forget(this.baseline.id);
    soup.ranges = []; // numbers only: don't keep the old meshes alive
    this.baseline = soup;
    this.gen++;
    this.cpuRunner.cancel();
    this.cache.delete('distance');
    this.onBaseline(label);
  }

  private async engine(): Promise<GpuChecks | null> {
    if (this.gpu === undefined) {
      try { this.gpu = await (await import('./gpu')).GpuChecks.create(); } catch (e) { console.warn(e); this.gpu = null; }
    }
    return this.gpu;
  }

  async run(kind: Check, progress?: (f: number) => void): Promise<Report> {
    const t0 = performance.now();
    const my = ++this.gen;
    const stale = () => { if (my !== this.gen) throw new CancelledError(); };
    const soup = buildSoup(this.viewer.meshes, this.viewer.frameOffset());
    if (!queryTris(soup).length) throw new Error('Nothing visible to check');
    const baseline = this.baseline;
    await new Promise((r) => setTimeout(r, 0)); // let the UI paint "Computing…" before the heavy part
    stale();
    const prog = progress && ((f: number) => { if (my === this.gen) progress(f); });
    let engine: Report['engine'] = 'cpu';
    let values: Float32Array;
    let outliers = 0;
    if (kind === 'overhang') values = cpu.overhang(soup);
    else {
      if (kind === 'distance' && !this.baseline) throw new Error('Set a baseline revision first');
      let gpu = await this.engine();
      stale();
      if (gpu && !gpu.fits(soup.sampleCount)) gpu = null; // too big for one storage binding: CPU
      let res: Float32Array | null = null;
      if (gpu) {
        try {
          res = kind === 'wall' ? await gpu.wall(soup) : await gpu.distance(soup, baseline!);
          engine = 'webgpu';
        } catch (e) { console.warn('GPU check failed, using CPU', e); }
        if (kind === 'wall') gpu.forget(soup.id); // per-run BVH; the baseline's is kept until replaced
      }
      stale();
      if (!res) res = await this.cpuRunner.run(kind, soup, baseline, prog);
      values = res;
      if (kind === 'wall') outliers = cpu.filterWallOutliers(values);
      // degenerate triangles get a neutral value
      for (let t = 0; t < soup.triCount; t++) if (!soup.valid[t]) values.fill(kind === 'wall' ? cpu.WALL_MAX : 0, t * 3, t * 3 + 3);
    }
    stale();
    this.soup = soup;
    this.cache.set(kind, { soupId: soup.id, values });
    this.clear(); // restore meshes the previous overlay painted (e.g. ones hidden since)
    this.active = kind;
    this.paint(soup, kind, values);
    const ms = Math.round(performance.now() - t0);
    const text = `${kind === 'overhang' ? 'Overhang' : kind === 'wall' ? 'Wall thickness' : 'Distance'}: ${soup.sampleCount.toLocaleString("en-US")} samples · ${engine === 'webgpu' ? 'GPU' : 'CPU'} · ${ms} ms`
      + (outliers ? ` · ${outliers} outlier${outliers > 1 ? 's' : ''} filtered` : '');
    return { ms, samples: soup.sampleCount, engine, outliers, text };
  }

  /** Re-colour with the current thresholds, without recomputing. */
  repaint() {
    const c = this.active && this.cache.get(this.active);
    if (c && this.active && this.soup) this.paint(this.soup, this.active, c.values);
  }

  private paint(soup: Soup, kind: Check, values: Float32Array) {
    const c = new THREE.Color();
    for (const r of soup.ranges) {
      const m = r.mesh;
      if (!sources.has(m)) {
        // per-instance, non-indexed copy so shared geometry can hold different colours
        const src = m.geometry;
        sources.set(m, src);
        const g = src.index ? src.toNonIndexed() : src.clone();
        g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 3), 3));
        m.geometry = g;
        const mat = m.material as THREE.MeshStandardMaterial;
        mat.vertexColors = true; mat.color.setRGB(1, 1, 1); mat.needsUpdate = true;
      }
      const col = m.geometry.getAttribute('color') as THREE.BufferAttribute;
      const a = col.array as Float32Array;
      for (let i = 0; i < r.count; i++) {
        colour(kind, values[r.start + i], c);
        a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b;
      }
      col.needsUpdate = true;
    }
  }

  /** Back to the normal part colours. */
  clear() {
    this.gen++;
    this.cpuRunner.cancel();
    for (const m of this.viewer.meshes) {
      const src = sources.get(m);
      if (!src) continue;
      m.geometry.dispose();
      m.geometry = src;
      sources.delete(m);
      const mat = m.material as THREE.MeshStandardMaterial;
      mat.vertexColors = false; mat.color.setHex(m.userData.baseColor); mat.needsUpdate = true;
    }
    this.active = null;
  }
}
