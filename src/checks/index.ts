import * as THREE from 'three';
import { buildSoup, type Soup } from './soup';
import * as cpu from './cpu';
import { colour, legend, thresholds, type Check } from './colors';
import type { GpuChecks } from './gpu';
import type { Viewer } from '../viewer';

export { thresholds, legend, type Check };

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
  onBaseline: (label: string | null) => void = () => {};

  constructor(private viewer: Viewer) {}

  /** The model was replaced: drop everything tied to the old meshes (keeps the baseline). */
  reset() { this.soup = null; this.cache.clear(); this.active = null; }

  hasBaseline() { return !!this.baseline; }

  /** Snapshot of the current model as "the older revision" the distance check compares against. */
  captureBaseline(label = 'current model') {
    if (this.baseline) this.gpu?.forget(this.baseline.id);
    this.baseline = buildSoup(this.viewer.meshes, this.viewer.frameOffset());
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
    const soup = (this.soup = buildSoup(this.viewer.meshes, this.viewer.frameOffset()));
    if (!soup.sampleCount) throw new Error('Nothing visible to check');
    let engine: Report['engine'] = 'cpu';
    let values: Float32Array;
    let outliers = 0;
    if (kind === 'overhang') values = cpu.overhang(soup);
    else {
      if (kind === 'distance' && !this.baseline) throw new Error('Set a baseline revision first');
      const gpu = await this.engine();
      engine = gpu ? 'webgpu' : 'cpu';
      if (kind === 'wall') {
        values = gpu ? await gpu.wall(soup) : await cpu.wall(soup, cpu.bvhFor(soup), progress);
        outliers = cpu.filterWallOutliers(values);
      } else {
        values = gpu ? await gpu.distance(soup, this.baseline!) : await cpu.distance(soup, cpu.bvhFor(this.baseline!), progress);
      }
      // degenerate triangles get a neutral value
      for (let t = 0; t < soup.triCount; t++) if (!soup.valid[t]) values.fill(kind === 'wall' ? cpu.WALL_MAX : 0, t * 3, t * 3 + 3);
    }
    this.cache.set(kind, { soupId: soup.id, values });
    this.active = kind;
    this.paint(kind, values);
    const ms = Math.round(performance.now() - t0);
    const text = `${kind === 'overhang' ? 'Overhang' : kind === 'wall' ? 'Wall thickness' : 'Distance'}: ${soup.sampleCount.toLocaleString("en-US")} samples · ${engine === 'webgpu' ? 'GPU' : 'CPU'} · ${ms} ms`
      + (outliers ? ` · ${outliers} outlier${outliers > 1 ? 's' : ''} filtered` : '');
    return { ms, samples: soup.sampleCount, engine, outliers, text };
  }

  /** Re-colour with the current thresholds, without recomputing. */
  repaint() {
    const c = this.active && this.cache.get(this.active);
    if (c && this.active) this.paint(this.active, c.values);
  }

  private paint(kind: Check, values: Float32Array) {
    const soup = this.soup!;
    const c = new THREE.Color();
    for (const r of soup.ranges) {
      const m = r.mesh;
      if (!m.userData.checkSource) {
        // per-instance, non-indexed copy so shared geometry can hold different colours
        const src = m.geometry;
        m.userData.checkSource = src;
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
    for (const m of this.viewer.meshes) {
      const src = m.userData.checkSource as THREE.BufferGeometry | undefined;
      if (!src) continue;
      m.geometry.dispose();
      m.geometry = src;
      delete m.userData.checkSource;
      const mat = m.material as THREE.MeshStandardMaterial;
      mat.vertexColors = false; mat.color.setHex(m.userData.baseColor); mat.needsUpdate = true;
    }
    this.active = null;
  }
}
