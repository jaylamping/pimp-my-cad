// Loaded lazily (dynamic import) so the WebGPU build of three stays out of the main bundle.
import * as THREE from 'three';
import { WebGPURenderer, StorageBufferAttribute } from 'three/webgpu';
import { Fn, storage, instanceIndex, float, wgslFn } from 'three/tsl';
import { BVHComputeData } from 'three-mesh-bvh/webgpu';
import { toVec4, type Soup } from './soup';
import { WALL_MAX } from './cpu';

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
    try {
      const renderer = new WebGPURenderer({ antialias: false } as never);
      await renderer.init();
      if (!(renderer.backend as any).isWebGPUBackend) { renderer.dispose(); return null; }
      return new GpuChecks(renderer);
    } catch (e) {
      console.warn('WebGPU unavailable for print checks', e);
      return null;
    }
  }

  private bvh(s: Soup): BVHComputeData {
    let d = this.bvhs.get(s.id);
    if (!d) {
      const g = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(s.tris, 3));
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
  }

  private async run(n: number, inputs: Buf[], kernel: (out: any) => any): Promise<Float32Array> {
    const out = buf(new Float32Array(n), 1, 'float');
    const k = kernel(out.node).compute(n);
    await this.renderer.computeAsync(k);
    const ab = await this.renderer.getArrayBufferAsync(out.attr);
    const res = new Float32Array(ab.slice(0, n * 4));
    const backend = this.renderer.backend as unknown as { destroyAttribute?: (a: unknown) => void };
    k.dispose?.();
    for (const b of [out, ...inputs]) backend.destroyAttribute?.(b.attr);
    return res;
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

  /** Signed distance from `s`'s samples to `baseline`'s surface (+ = outside it). */
  distance(s: Soup, baseline: Soup): Promise<Float32Array> {
    const data = this.bvh(baseline);
    const smp = buf(toVec4(s.samples), 4, 'vec4');
    const query = wgslFn(/* wgsl */ `
      fn distQuery( p: vec3f ) -> f32 {
        var r: PointQueryResult;
        bvh_ClosestPointToPoint( p, &r );
        return select( 1.0, -1.0, r.side < 0.0 ) * sqrt( r.distanceSq );
      }`, [(data.fns as any).closestPointToPoint]);
    return this.run(s.sampleCount, [smp], (out) => Fn(() => {
      out.element(instanceIndex).assign(query({ p: smp.node.element(instanceIndex).xyz }));
    })());
  }
}
