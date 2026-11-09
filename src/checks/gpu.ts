// Loaded lazily (dynamic import) so the WebGPU build of three stays out of the main bundle.
import * as THREE from 'three';
import { WebGPURenderer, StorageBufferAttribute } from 'three/webgpu';
import { Fn, storage, instanceIndex, float, wgslFn } from 'three/tsl';
import { BVHComputeData } from 'three-mesh-bvh/webgpu';
import { toVec4, queryTris, type Soup } from './soup';
import { WALL_MAX } from './cpu';
import { buildPseudo, signAt, type Pseudo } from './pseudo';

/**
 * GPU wall thickness and distance-to-baseline: three TSL compute + three-mesh-bvh's WGSL BVH
 * (benchmarked in the GPU bench spike: ~1.7x faster than gpu.js WebGPU at 4.7M samples, 50-400x
 * faster than the CPU). Runs on its own WebGPURenderer that is never attached to the page, so
 * the viewer can stay on WebGLRenderer; only the per-vertex result is read back.
 * three-mesh-bvh's WebGPU API is marked unstable (needs three r185+).
 */
type Buf = { attr: StorageBufferAttribute; node: any };
const buf = (data: Float32Array, itemSize: number, type: string): Buf => {
  const attr = new StorageBufferAttribute(data, itemSize);
  return { attr, node: (storage as any)(attr, type, data.length / itemSize) };
};

export class GpuChecks {
  private constructor(private renderer: WebGPURenderer) {}
  private bvhs = new Map<number, BVHComputeData>();

  /** Returns null when this webview has no real WebGPU (BVH queries need it). */
  static async create(): Promise<GpuChecks | null> {
    if (!('gpu' in navigator)) return null;
    let renderer: WebGPURenderer | undefined;
    try {
      renderer = new WebGPURenderer({ antialias: false } as never);
      await renderer.init();
      if (!(renderer.backend as any).isWebGPUBackend) { renderer.dispose(); return null; }
      return new GpuChecks(renderer);
    } catch (e) {
      try { renderer?.dispose(); } catch { /* partial init */ }
      console.warn('WebGPU unavailable for print checks', e);
      return null;
    }
  }

  private bvh(s: Soup): BVHComputeData {
    let d = this.bvhs.get(s.id);
    if (!d) {
      const g = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(queryTris(s), 3));
      d = new BVHComputeData(new THREE.Mesh(g), { attributes: { position: 'vec4f' } });
      d.update();
      this.bvhs.set(s.id, d);
    }
    return d;
  }

  /** Drops the BVH of a soup that is no longer used (e.g. a replaced baseline). */
  forget(id: number) {
    (this.bvhs.get(id) as unknown as { dispose?(): void } | undefined)?.dispose?.();
    this.bvhs.delete(id);
    this.pseudos.delete(id);
  }

  /** False when the sample buffers would exceed the device's storage-binding limit (or its BVH is too big). */
  fits(sampleCount: number): boolean {
    const limit = (this.renderer.backend as any).device?.limits?.maxStorageBufferBindingSize ?? 128 * 1024 * 1024;
    return sampleCount * 16 <= limit && sampleCount < 3 * 5_000_000; // vertex ids travel as f32
  }

  private async run(n: number, inputs: Buf[], kernel: (out: any) => any, itemSize = 1): Promise<Float32Array> {
    const out = itemSize === 1 ? buf(new Float32Array(n), 1, 'float') : buf(new Float32Array(n * itemSize), itemSize, 'vec4');
    let k: any;
    const backend = this.renderer.backend as unknown as { destroyAttribute?: (a: unknown) => void };
    try {
      k = kernel(out.node).compute(n);
      await this.renderer.computeAsync(k);
      const ab = await this.renderer.getArrayBufferAsync(out.attr);
      return new Float32Array(ab.slice(0, n * 4 * itemSize));
    } finally {
      try { k?.dispose?.(); } catch { /* already gone */ }
      for (const b of [out, ...inputs]) { try { backend.destroyAttribute?.(b.attr); } catch { /* already gone */ } }
    }
  }

  wall(s: Soup): Promise<Float32Array> {
    const data = this.bvh(s);
    const smp = buf(toVec4(s.samples), 4, 'vec4');
    const nrm = buf(toVec4(s.normals), 4, 'vec4');
    const cast = wgslFn(/* wgsl */ `
      fn wallCast( o: vec3f, d: vec3f, maxDist: f32 ) -> f32 {
        var hit: IntersectionResult;
        let ray = Ray( o, d, maxDist );
        let didHit = bvh_RaycastFirstHit( ray, &hit );
        return select( maxDist, min( hit.dist, maxDist ), didHit );
      }`, [(data.fns as any).raycastFirstHit]);
    return this.run(s.sampleCount, [smp, nrm], (out) => Fn(() => {
      const d = nrm.node.element(instanceIndex).xyz.negate().toVar();
      const o = smp.node.element(instanceIndex).xyz.add(d.mul(0.001));
      out.element(instanceIndex).assign(cast({ o, d, maxDist: float(WALL_MAX) }));
    })());
  }

  private pseudos = new Map<number, Pseudo>();

  /**
   * Signed distance from `s`'s samples to `baseline`'s surface (+ = outside it). The shader returns
   * the closest feature (unsigned distance, vertex index, barycentrics); the sign comes from the
   * baseline's angle-weighted pseudonormals on the CPU, which is robust at sharp edges and vertices.
   */
  async distance(s: Soup, baseline: Soup): Promise<Float32Array> {
    const data = this.bvh(baseline);
    let ps = this.pseudos.get(baseline.id);
    if (!ps) this.pseudos.set(baseline.id, (ps = buildPseudo(queryTris(baseline))));
    const smp = buf(toVec4(s.samples), 4, 'vec4');
    const query = wgslFn(/* wgsl */ `
      fn distQuery( p: vec3f ) -> vec4f {
        var r: PointQueryResult;
        bvh_ClosestPointToPoint( p, &r );
        return vec4f( sqrt( r.distanceSq ), f32( r.faceIndices.x ), r.barycoord.y, r.barycoord.z );
      }`, [(data.fns as any).closestPointToPoint]);
    const raw = await this.run(s.sampleCount, [smp], (out) => Fn(() => {
      out.element(instanceIndex).assign(query({ p: smp.node.element(instanceIndex).xyz }));
    })(), 4);
    const out = new Float32Array(s.sampleCount);
    for (let i = 0; i < s.sampleCount; i++) {
      const d = raw[i * 4], t = Math.floor(raw[i * 4 + 1] / 3), u = raw[i * 4 + 2], v = raw[i * 4 + 3];
      out[i] = signAt(ps, t, 1 - u - v, u, v, s.samples[i * 3], s.samples[i * 3 + 1], s.samples[i * 3 + 2]) * d;
    }
    return out;
  }
}
