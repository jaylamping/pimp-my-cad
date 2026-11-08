import * as THREE from 'three';
import { WebGPURenderer, StorageBufferAttribute } from 'three/webgpu';
import {
  Fn, storage, instanceIndex, float, uniform, If, Loop, abs, asin, clamp, cross, dot, sqrt, select, wgslFn,
} from 'three/tsl';
import { BVHComputeData } from 'three-mesh-bvh/webgpu';
import { toVec4, type Prepared } from './mesh';
import { BED_EPS } from './cpu';

/**
 * three.js WebGPU-renderer versions of the print checks.
 *
 * Three flavours, to see what each layer of the stack is good for:
 *  - pure TSL (JS-built node graphs): overhang, brute-force wall thickness;
 *  - TSL Loop calling a hand-written wgslFn: brute-force distance;
 *  - three-mesh-bvh's WGSL BVH (`BVHComputeData`, unstable API): wall thickness + distance.
 *
 * On a device without WebGPU, three's renderer falls back to WebGL2 and runs TSL compute through
 * transform feedback. The pure-TSL kernels still work there; anything with raw WGSL does not.
 */

type Buf = { attr: StorageBufferAttribute; node: any };

const buf = (data: Float32Array, itemSize: number, type: string): Buf => {
  const attr = new StorageBufferAttribute(data, itemSize);
  return { attr, node: (storage as any)(attr, type, data.length / itemSize) };
};

// Ericson closest point on triangle, signed squared distance. Same maths as the gpu.js version.
const triDist2 = wgslFn(/* wgsl */ `
fn triDist2( p: vec3f, a: vec3f, b: vec3f, c: vec3f ) -> f32 {
  let ab = b - a; let ac = c - a; let ap = p - a;
  let d1 = dot( ab, ap ); let d2 = dot( ac, ap );
  let bp = p - b; let d3 = dot( ab, bp ); let d4 = dot( ac, bp );
  let cp = p - c; let d5 = dot( ab, cp ); let d6 = dot( ac, cp );
  let vc = d1 * d4 - d3 * d2; let vb = d5 * d2 - d1 * d6; let va = d3 * d6 - d5 * d4;
  var q: vec3f;
  if ( d1 <= 0.0 && d2 <= 0.0 ) { q = a; }
  else if ( d3 >= 0.0 && d4 <= d3 ) { q = b; }
  else if ( vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 ) { q = a + ab * ( d1 / ( d1 - d3 ) ); }
  else if ( d6 >= 0.0 && d5 <= d6 ) { q = c; }
  else if ( vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 ) { q = a + ac * ( d2 / ( d2 - d6 ) ); }
  else if ( va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 ) { q = b + ( c - b ) * ( ( d4 - d3 ) / ( ( d4 - d3 ) + ( d5 - d6 ) ) ); }
  else { let den = 1.0 / ( va + vb + vc ); q = a + ab * ( vb * den ) + ac * ( vc * den ); }
  let e = p - q;
  let dd = dot( e, e );
  return select( dd, -dd, dot( e, cross( ab, ac ) ) < 0.0 );
}`);

export class TslRunner {
  /** Pure GPU time of the last dispatch, from timestamp queries, when the device supports them. */
  lastGpuMs: number | null = null;
  private jobs = new Map<string, { out: Buf; inputs: Buf[]; kernel: any }>();
  private bvhCache = new Map<Prepared, BVHComputeData>();

  constructor(public renderer: WebGPURenderer) {}

  get isWebGPU(): boolean {
    return !!(this.renderer.backend as any).isWebGPUBackend;
  }

  /** Builds GPU buffers + node graph once per (mesh, workload); later runs only re-dispatch. */
  private async run(key: string, n: number, build: () => { inputs: Buf[]; kernel: (out: any) => any }): Promise<Float32Array> {
    let job = this.jobs.get(key);
    if (!job) {
      const out = buf(new Float32Array(n), 1, 'float');
      const b = build();
      job = { out, inputs: b.inputs, kernel: b.kernel(out.node).compute(n) };
      this.jobs.set(key, job);
    } else {
      // re-upload inputs so timings include the same upload gpu.js pays on every call
      for (const i of job.inputs) i.attr.needsUpdate = true;
    }
    await this.renderer.computeAsync(job.kernel);
    const ab = await this.renderer.getArrayBufferAsync(job.out.attr);
    this.lastGpuMs = null;
    if ((this.renderer.backend as any).trackTimestamp) {
      try { this.lastGpuMs = (await this.renderer.resolveTimestampsAsync('compute' as any)) as unknown as number; } catch { /* unsupported */ }
    }
    return new Float32Array(ab.slice(0, n * 4));
  }

  overhang(p: Prepared, tag: string, samples: Float32Array, normals: Float32Array): Promise<Float32Array> {
    const n = samples.length / 3;
    return this.run(`overhang:${tag}:${n}`, n, () => {
      const s = buf(toVec4(samples), 4, 'vec4');
      const nr = buf(toVec4(normals), 4, 'vec4');
      const minZ = uniform(p.bounds.min.z + BED_EPS);
      return {
        inputs: [s, nr],
        kernel: (out) => Fn(() => {
          const z = s.node.element(instanceIndex).z;
          const nz = nr.node.element(instanceIndex).z;
          const deg = asin(clamp(nz.negate(), 0.0, 1.0)).mul(180 / Math.PI);
          out.element(instanceIndex).assign(select(z.lessThan(minZ), float(0), deg));
        })(),
      };
    });
  }

  wallBrute(p: Prepared, tag: string, samples: Float32Array, normals: Float32Array, maxDist: number): Promise<Float32Array> {
    const n = samples.length / 3;
    return this.run(`wallBrute:${tag}:${n}`, n, () => {
      const s = buf(toVec4(samples), 4, 'vec4');
      const nr = buf(toVec4(normals), 4, 'vec4');
      const tris = buf(toVec4(p.tris), 4, 'vec4');
      const triCount = uniform(p.triCount, 'int');
      return {
        inputs: [s, nr, tris],
        kernel: (out) => Fn(() => {
          const d = nr.node.element(instanceIndex).xyz.negate().toVar();
          const o = s.node.element(instanceIndex).xyz.add(d.mul(0.001)).toVar();
          const best = float(maxDist).toVar();
          Loop(triCount, ({ i }: any) => {
            const a = tris.node.element(i.mul(3)).xyz.toVar();
            const e1 = tris.node.element(i.mul(3).add(1)).xyz.sub(a).toVar();
            const e2 = tris.node.element(i.mul(3).add(2)).xyz.sub(a).toVar();
            const pv = cross(d, e2).toVar();
            const det = dot(e1, pv).toVar();
            If(abs(det).greaterThan(1e-12), () => {
              const inv = float(1).div(det).toVar();
              const sv = o.sub(a).toVar();
              const u = dot(sv, pv).mul(inv).toVar();
              const q = cross(sv, e1).toVar();
              const v = dot(d, q).mul(inv).toVar();
              const t = dot(e2, q).mul(inv).toVar();
              If(u.greaterThanEqual(0).and(u.lessThanEqual(1)).and(v.greaterThanEqual(0)).and(u.add(v).lessThanEqual(1))
                .and(t.greaterThan(0)).and(t.lessThan(best)), () => { best.assign(t); });
            });
          });
          out.element(instanceIndex).assign(best);
        })(),
      };
    });
  }

  distBrute(pA: Prepared, tag: string, samples: Float32Array): Promise<Float32Array> {
    const n = samples.length / 3;
    return this.run(`distBrute:${tag}:${n}`, n, () => {
      const s = buf(toVec4(samples), 4, 'vec4');
      const tris = buf(toVec4(pA.tris), 4, 'vec4');
      const triCount = uniform(pA.triCount, 'int');
      return {
        inputs: [s, tris],
        kernel: (out) => Fn(() => {
          const pt = s.node.element(instanceIndex).xyz.toVar();
          const best = float(1e30).toVar();
          const signed = float(1e30).toVar();
          Loop(triCount, ({ i }: any) => {
            const sd = (triDist2 as any)({
              p: pt, a: tris.node.element(i.mul(3)).xyz, b: tris.node.element(i.mul(3).add(1)).xyz, c: tris.node.element(i.mul(3).add(2)).xyz,
            }).toVar();
            If(abs(sd).lessThan(best), () => { best.assign(abs(sd)); signed.assign(sd); });
          });
          out.element(instanceIndex).assign(select(signed.lessThan(0), sqrt(best).negate(), sqrt(best)));
        })(),
      };
    });
  }

  /** three-mesh-bvh's packed BVH (CPU build + upload). Cached per mesh; returns build ms. */
  bvh(p: Prepared): { data: BVHComputeData; ms: number } {
    let data = this.bvhCache.get(p);
    let ms = 0;
    if (!data) {
      const t = performance.now();
      const g = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(p.tris, 3));
      data = new BVHComputeData(new THREE.Mesh(g), { attributes: { position: 'vec4f' } });
      data.update();
      ms = performance.now() - t;
      this.bvhCache.set(p, data);
    }
    return { data, ms };
  }

  wallBVH(p: Prepared, tag: string, samples: Float32Array, normals: Float32Array, maxDist: number): Promise<Float32Array> {
    const n = samples.length / 3;
    const { data } = this.bvh(p);
    return this.run(`wallBVH:${tag}:${n}`, n, () => {
      const s = buf(toVec4(samples), 4, 'vec4');
      const nr = buf(toVec4(normals), 4, 'vec4');
      const cast = wgslFn(/* wgsl */ `
        fn wallCast( o: vec3f, d: vec3f, maxDist: f32 ) -> f32 {
          var hit: IntersectionResult;
          let ray = Ray( o, d, maxDist );
          let didHit = bvh_RaycastFirstHit( ray, &hit );
          return select( maxDist, min( hit.dist, maxDist ), didHit );
        }`, [(data.fns as any).raycastFirstHit]);
      return {
        inputs: [s, nr],
        kernel: (out) => Fn(() => {
          const d = nr.node.element(instanceIndex).xyz.negate().toVar();
          const o = s.node.element(instanceIndex).xyz.add(d.mul(0.001));
          out.element(instanceIndex).assign(cast({ o, d, maxDist: float(maxDist) }));
        })(),
      };
    });
  }

  distBVH(pA: Prepared, tag: string, samples: Float32Array): Promise<Float32Array> {
    const n = samples.length / 3;
    const { data } = this.bvh(pA);
    return this.run(`distBVH:${tag}:${n}`, n, () => {
      const s = buf(toVec4(samples), 4, 'vec4');
      const query = wgslFn(/* wgsl */ `
        fn distQuery( p: vec3f ) -> f32 {
          var r: PointQueryResult;
          bvh_ClosestPointToPoint( p, &r );
          return select( 1.0, -1.0, r.side < 0.0 ) * sqrt( r.distanceSq );
        }`, [(data.fns as any).closestPointToPoint]);
      return {
        inputs: [s],
        kernel: (out) => Fn(() => {
          out.element(instanceIndex).assign(query({ p: s.node.element(instanceIndex).xyz }));
        })(),
      };
    });
  }

  /** Frees every GPU buffer this runner created. The sweep calls it between sizes: without it each
   *  size's buffers (hundreds of MB at k=6+) stay alive for the whole session. */
  dispose() {
    const backend = this.renderer.backend as unknown as { destroyAttribute?: (a: unknown) => void };
    for (const j of this.jobs.values()) {
      j.kernel.dispose?.();
      for (const b of [j.out, ...j.inputs]) backend.destroyAttribute?.(b.attr);
    }
    this.jobs.clear();
    for (const d of this.bvhCache.values()) (d as unknown as { dispose(): void }).dispose(); // missing from the .d.ts
    this.bvhCache.clear();
  }
}
