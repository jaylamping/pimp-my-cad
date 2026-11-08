import * as gpujs from 'gpu.js';

const { GPU } = gpujs;
// exported at runtime, missing from gpu.js's .d.ts
const WebGPUContext = (gpujs as unknown as { WebGPUContext: object }).WebGPUContext;
import { NODE_STRIDE, LEAF_SIZE, type ThreadedBVH } from './bvh';
import { BED_EPS } from './cpu';

/**
 * gpu.js versions of the three print checks.
 *
 * Kernels are kept as source strings, not JS functions: gpu.js parses kernel source with acorn and
 * transpiles it to GLSL / WGSL / wasm, and Vite's TypeScript transform or a production minifier
 * would otherwise rewrite that source into forms gpu.js may not accept.
 *
 * The same kernel source runs on every gpu.js backend, which is the library's main selling point,
 * so the backend is just a constructor argument here.
 */

export type GpuJsMode = 'webgl2' | 'webgpu' | 'webasm' | 'cpu';

// gpu.js probes WebGL2 support once, with a throwaway canvas, and caches the answer for the page's
// lifetime. If that first probe happens after three's renderer and the other engines have opened
// their contexts, Chromium can refuse the extra context and gpu.js reports "no WebGL2" forever.
// Probing at import time, before anything else exists, avoids that.
const WEBGL2_OK = (GPU as unknown as { isWebGL2Supported: boolean }).isWebGL2Supported;

// Möller–Trumbore, two-sided. Returns the hit distance, or -1.
const rayTri = `function rayTri(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const e1x = bx - ax; const e1y = by - ay; const e1z = bz - az;
  const e2x = cx - ax; const e2y = cy - ay; const e2z = cz - az;
  const px = dy * e2z - dz * e2y; const py = dz * e2x - dx * e2z; const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  let t = -1.0;
  if (Math.abs(det) > 1e-12) {
    const inv = 1.0 / det;
    const sx = ox - ax; const sy = oy - ay; const sz = oz - az;
    const u = (sx * px + sy * py + sz * pz) * inv;
    if (u >= 0.0 && u <= 1.0) {
      const qx = sy * e1z - sz * e1y; const qy = sz * e1x - sx * e1z; const qz = sx * e1y - sy * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v >= 0.0 && u + v <= 1.0) {
        t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      }
    }
  }
  return t;
}`;

// Slab test. Returns the entry distance (clamped to 0), or 1e30 on a miss.
const rayBox = `function rayBox(ox, oy, oz, ix, iy, iz, x0, y0, z0, x1, y1, z1) {
  const tx0 = (x0 - ox) * ix; const tx1 = (x1 - ox) * ix;
  const ty0 = (y0 - oy) * iy; const ty1 = (y1 - oy) * iy;
  const tz0 = (z0 - oz) * iz; const tz1 = (z1 - oz) * iz;
  const tmin = Math.max(Math.max(Math.min(tx0, tx1), Math.min(ty0, ty1)), Math.max(Math.min(tz0, tz1), 0.0));
  const tmax = Math.min(Math.min(Math.max(tx0, tx1), Math.max(ty0, ty1)), Math.max(tz0, tz1));
  let r = 1e30;
  if (tmax >= tmin) { r = tmin; }
  return r;
}`;

// Squared distance from p to an AABB.
const boxDist2 = `function boxDist2(px, py, pz, x0, y0, z0, x1, y1, z1) {
  const dx = Math.max(Math.max(x0 - px, px - x1), 0.0);
  const dy = Math.max(Math.max(y0 - py, py - y1), 0.0);
  const dz = Math.max(Math.max(z0 - pz, pz - z1), 0.0);
  return dx * dx + dy * dy + dz * dz;
}`;

// Ericson's closest point on triangle, single exit (gpu.js is happiest with one return).
// Returns the squared distance, negated when p is behind the face.
const triDist2 = `function triDist2(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax; const aby = by - ay; const abz = bz - az;
  const acx = cx - ax; const acy = cy - ay; const acz = cz - az;
  const apx = px - ax; const apy = py - ay; const apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  const bpx = px - bx; const bpy = py - by; const bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  const cpx = px - cx; const cpy = py - cy; const cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  const vc = d1 * d4 - d3 * d2;
  const vb = d5 * d2 - d1 * d6;
  const va = d3 * d6 - d5 * d4;
  let qx = ax; let qy = ay; let qz = az;
  let done = 0.0;
  if (d1 <= 0.0 && d2 <= 0.0) { done = 1.0; }
  if (done < 0.5 && d3 >= 0.0 && d4 <= d3) { qx = bx; qy = by; qz = bz; done = 1.0; }
  if (done < 0.5 && vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0) {
    const v = d1 / (d1 - d3); qx = ax + v * abx; qy = ay + v * aby; qz = az + v * abz; done = 1.0;
  }
  if (done < 0.5 && d6 >= 0.0 && d5 <= d6) { qx = cx; qy = cy; qz = cz; done = 1.0; }
  if (done < 0.5 && vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0) {
    const w = d2 / (d2 - d6); qx = ax + w * acx; qy = ay + w * acy; qz = az + w * acz; done = 1.0;
  }
  if (done < 0.5 && va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0) {
    const w2 = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    qx = bx + w2 * (cx - bx); qy = by + w2 * (cy - by); qz = bz + w2 * (cz - bz); done = 1.0;
  }
  if (done < 0.5) {
    const den = 1.0 / (va + vb + vc);
    const v2 = vb * den; const w3 = vc * den;
    qx = ax + abx * v2 + acx * w3; qy = ay + aby * v2 + acy * w3; qz = az + abz * v2 + acz * w3;
  }
  const ex = px - qx; const ey = py - qy; const ez = pz - qz;
  const nx = aby * acz - abz * acy; const ny = abz * acx - abx * acz; const nz = abx * acy - aby * acx;
  const dd = ex * ex + ey * ey + ez * ez;
  let r = dd;
  if (ex * nx + ey * ny + ez * nz < 0.0) { r = -dd; }
  return r;
}`;

const overhangK = `function overhang(samples, normals, minZ) {
  const i = this.thread.x;
  const nz = normals[i * 3 + 2];
  let v = 0.0;
  if (samples[i * 3 + 2] >= minZ + ${BED_EPS.toFixed(4)}) {
    v = Math.asin(Math.min(1.0, Math.max(0.0, -nz))) * 57.29577951308232;
  }
  return v;
}`;

const wallBruteK = `function wallBrute(samples, normals, tris, triCount, maxDist) {
  const i = this.thread.x;
  const dx = -normals[i * 3]; const dy = -normals[i * 3 + 1]; const dz = -normals[i * 3 + 2];
  const ox = samples[i * 3] + dx * 0.001; const oy = samples[i * 3 + 1] + dy * 0.001; const oz = samples[i * 3 + 2] + dz * 0.001;
  let best = maxDist;
  for (let t = 0; t < triCount; t++) {
    const b = t * 9;
    const d = rayTri(ox, oy, oz, dx, dy, dz, tris[b], tris[b + 1], tris[b + 2], tris[b + 3], tris[b + 4], tris[b + 5], tris[b + 6], tris[b + 7], tris[b + 8]);
    if (d > 0.0 && d < best) { best = d; }
  }
  let r = best + 0.001;
  if (r > maxDist) { r = maxDist; }
  return r;
}`;

const wallBVHK = `function wallBVH(samples, normals, nodes, tris, nodeCount, maxDist) {
  const i = this.thread.x;
  const dx = -normals[i * 3]; const dy = -normals[i * 3 + 1]; const dz = -normals[i * 3 + 2];
  const ox = samples[i * 3] + dx * 0.001; const oy = samples[i * 3 + 1] + dy * 0.001; const oz = samples[i * 3 + 2] + dz * 0.001;
  let ix = 1e12; if (Math.abs(dx) > 1e-12) { ix = 1.0 / dx; }
  let iy = 1e12; if (Math.abs(dy) > 1e-12) { iy = 1.0 / dy; }
  let iz = 1e12; if (Math.abs(dz) > 1e-12) { iz = 1.0 / dz; }
  let best = maxDist;
  let node = 0.0;
  for (let it = 0; it < nodeCount; it++) {
    if (node >= nodeCount) { break; }
    const o = node * ${NODE_STRIDE}.0;
    const tn = rayBox(ox, oy, oz, ix, iy, iz, nodes[o], nodes[o + 1], nodes[o + 2], nodes[o + 3], nodes[o + 4], nodes[o + 5]);
    if (tn < best) {
      const leaf = nodes[o + 7];
      if (leaf < 0.0) {
        node = node + 1.0;
      } else {
        const start = Math.floor(leaf / ${LEAF_SIZE}.0);
        const cnt = leaf - start * ${LEAF_SIZE}.0;
        for (let k = 0; k < ${LEAF_SIZE}; k++) {
          if (k <= cnt) {
            const b = (start + k) * 9.0;
            const d = rayTri(ox, oy, oz, dx, dy, dz, tris[b], tris[b + 1], tris[b + 2], tris[b + 3], tris[b + 4], tris[b + 5], tris[b + 6], tris[b + 7], tris[b + 8]);
            if (d > 0.0 && d < best) { best = d; }
          }
        }
        node = nodes[o + 6];
      }
    } else {
      node = nodes[o + 6];
    }
  }
  let r = best + 0.001;
  if (r > maxDist) { r = maxDist; }
  return r;
}`;

const distBruteK = `function distBrute(samples, tris, triCount) {
  const i = this.thread.x;
  const px = samples[i * 3]; const py = samples[i * 3 + 1]; const pz = samples[i * 3 + 2];
  let best = 1e30; let signed = 1e30;
  for (let t = 0; t < triCount; t++) {
    const b = t * 9;
    const sd = triDist2(px, py, pz, tris[b], tris[b + 1], tris[b + 2], tris[b + 3], tris[b + 4], tris[b + 5], tris[b + 6], tris[b + 7], tris[b + 8]);
    if (Math.abs(sd) < best) { best = Math.abs(sd); signed = sd; }
  }
  let r = Math.sqrt(best);
  if (signed < 0.0) { r = -r; }
  return r;
}`;

const distBVHK = `function distBVH(samples, nodes, tris, nodeCount) {
  const i = this.thread.x;
  const px = samples[i * 3]; const py = samples[i * 3 + 1]; const pz = samples[i * 3 + 2];
  let best = 1e30; let signed = 1e30;
  // Greedy descent first: always step into the nearer child (left = node + 1, right = left's skip)
  // and test that one leaf. It costs ~depth box tests and gives the full traversal below a tight
  // bound to prune with, which a fixed-order stackless walk otherwise lacks.
  let g = 0.0;
  for (let d = 0; d < 64; d++) {
    if (nodes[g * ${NODE_STRIDE}.0 + 7] >= 0.0) { break; }
    const l = g + 1.0;
    const r = nodes[l * ${NODE_STRIDE}.0 + 6];
    const dl = boxDist2(px, py, pz, nodes[l * ${NODE_STRIDE}.0], nodes[l * ${NODE_STRIDE}.0 + 1], nodes[l * ${NODE_STRIDE}.0 + 2], nodes[l * ${NODE_STRIDE}.0 + 3], nodes[l * ${NODE_STRIDE}.0 + 4], nodes[l * ${NODE_STRIDE}.0 + 5]);
    const dr = boxDist2(px, py, pz, nodes[r * ${NODE_STRIDE}.0], nodes[r * ${NODE_STRIDE}.0 + 1], nodes[r * ${NODE_STRIDE}.0 + 2], nodes[r * ${NODE_STRIDE}.0 + 3], nodes[r * ${NODE_STRIDE}.0 + 4], nodes[r * ${NODE_STRIDE}.0 + 5]);
    if (dl <= dr) { g = l; } else { g = r; }
  }
  const gl = nodes[g * ${NODE_STRIDE}.0 + 7];
  const gs = Math.floor(gl / ${LEAF_SIZE}.0);
  const gc = gl - gs * ${LEAF_SIZE}.0;
  for (let k = 0; k < ${LEAF_SIZE}; k++) {
    if (k <= gc) {
      const b = (gs + k) * 9.0;
      const sd = triDist2(px, py, pz, tris[b], tris[b + 1], tris[b + 2], tris[b + 3], tris[b + 4], tris[b + 5], tris[b + 6], tris[b + 7], tris[b + 8]);
      if (Math.abs(sd) < best) { best = Math.abs(sd); signed = sd; }
    }
  }
  let node = 0.0;
  for (let it = 0; it < nodeCount; it++) {
    if (node >= nodeCount) { break; }
    const o = node * ${NODE_STRIDE}.0;
    const bd = boxDist2(px, py, pz, nodes[o], nodes[o + 1], nodes[o + 2], nodes[o + 3], nodes[o + 4], nodes[o + 5]);
    if (bd < best) {
      const leaf = nodes[o + 7];
      if (leaf < 0.0) {
        node = node + 1.0;
      } else {
        const start = Math.floor(leaf / ${LEAF_SIZE}.0);
        const cnt = leaf - start * ${LEAF_SIZE}.0;
        for (let k = 0; k < ${LEAF_SIZE}; k++) {
          if (k <= cnt) {
            const b = (start + k) * 9.0;
            const sd = triDist2(px, py, pz, tris[b], tris[b + 1], tris[b + 2], tris[b + 3], tris[b + 4], tris[b + 5], tris[b + 6], tris[b + 7], tris[b + 8]);
            if (Math.abs(sd) < best) { best = Math.abs(sd); signed = sd; }
          }
        }
        node = nodes[o + 6];
      }
    } else {
      node = nodes[o + 6];
    }
  }
  let r = Math.sqrt(best);
  if (signed < 0.0) { r = -r; }
  return r;
}`;

export const KERNEL_SOURCES = { rayTri, rayBox, boxDist2, triDist2, overhangK, wallBruteK, wallBVHK, distBruteK, distBVHK };

/**
 * One GPUDevice for the whole page, shared by three's renderer and gpu.js.
 *
 * Left alone, each library requests its own adapter and device. That works on most real GPUs,
 * but Chromium's software adapter drops the first device when the second is created, and two
 * devices can't share buffers anyway. gpu.js exports its device singleton, so we create one device
 * (with the timestamp feature three uses for GPU timings, and the adapter's full buffer limits,
 * which gpu.js asks for) and hand it to both.
 */
export async function sharedDevice(): Promise<GPUDevice | undefined> {
  const gpu = (navigator as Navigator & { gpu?: GPU_ }).gpu;
  const adapter = await gpu?.requestAdapter();
  if (!adapter) return undefined;
  const features = (['timestamp-query', 'float32-filterable'] as const).filter((f) => adapter.features.has(f));
  const device = await adapter.requestDevice({
    requiredFeatures: features as unknown as GPUFeatureName[],
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });
  const ctx = { adapter, device, isLost: false };
  device.lost.then(() => { ctx.isLost = true; });
  (WebGPUContext as unknown as { acquire: () => Promise<typeof ctx> }).acquire = () => Promise.resolve(ctx);
  return device;
}
type GPU_ = { requestAdapter(): Promise<GPUAdapter | null> };

type Kernel = ((...args: unknown[]) => unknown) & { destroy?: () => void };

export class GpuJsRunner {
  gpu: InstanceType<typeof GPU>;
  private kernels = new Map<string, Kernel>();

  constructor(public mode: GpuJsMode) {
    // webasm only threads under the async contract; webgpu is always async.
    this.gpu = new GPU({ mode });
    this.gpu.addFunction(rayTri as never);
    this.gpu.addFunction(rayBox as never);
    this.gpu.addFunction(boxDist2 as never);
    this.gpu.addFunction(triDist2 as never);
  }

  static async available(mode: GpuJsMode): Promise<boolean> {
    const G = GPU as unknown as { isWebGL2Supported: boolean; isWebAssemblySupported?: boolean };
    if (mode === 'webgl2') return WEBGL2_OK && G.isWebGL2Supported;
    // Not isWebGPUAvailable(): that requests a second adapter next to three's, which some
    // implementations (Chromium's SwiftShader fallback) answer with null or by dropping the first
    // device. A missing adapter shows up as an error row when the kernel runs instead.
    if (mode === 'webgpu') return 'gpu' in navigator;
    if (mode === 'webasm') return !!G.isWebAssemblySupported;
    return true;
  }

  /** Builds (or reuses) a kernel for a given output size. The first call compiles. */
  private k(key: string, src: string, n: number, loop: number): Kernel {
    const id = `${key}:${n}:${loop}`;
    let k = this.kernels.get(id);
    if (!k) {
      k = this.gpu.createKernel(src, {
        output: [n],
        loopMaxIterations: Math.max(loop + 1, 16),
        tactic: 'precision',
        precision: 'single',
        asyncMode: this.mode === 'webasm' || this.mode === 'webgpu',
      } as never) as unknown as Kernel;
      this.kernels.set(id, k);
    }
    return k;
  }

  /** What actually ran: gpu.js silently degrades to cpu when a backend can't take a kernel. */
  ranOn(): string {
    const names: Record<string, string> = { WebGL2Kernel: 'webgl2', WebGLKernel: 'webgl', WebGPUKernel: 'webgpu', WebAssemblyKernel: 'webasm', CPUKernel: 'cpu' };
    const modes = new Set<string>();
    for (const k of this.kernels.values()) {
      const c = (k as unknown as { kernel?: { constructor?: { name?: string } } }).kernel?.constructor?.name ?? '?';
      modes.add(names[c] ?? c);
    }
    return [...modes].join('+');
  }

  /** gpu.js indexes every array with float32 arithmetic (`i * 3`, `t * 9`), exact only below 2^24. */
  private static addressable(...lengths: number[]) {
    const big = Math.max(...lengths);
    if (big >= 1 << 24) throw new Error(`gpu.js limit: array of ${big.toLocaleString()} floats exceeds float32 addressing (16.7M)`);
  }

  async overhang(samples: Float32Array, normals: Float32Array, minZ: number): Promise<Float32Array> {
    GpuJsRunner.addressable(samples.length);
    const n = samples.length / 3;
    return f32(await this.k('overhang', overhangK, n, 1)(samples, normals, minZ));
  }

  async wallBrute(samples: Float32Array, normals: Float32Array, tris: Float32Array, maxDist: number): Promise<Float32Array> {
    GpuJsRunner.addressable(samples.length, tris.length);
    const n = samples.length / 3, T = tris.length / 9;
    return f32(await this.k('wallBrute', wallBruteK, n, T)(samples, normals, tris, T, maxDist));
  }

  async wallBVH(samples: Float32Array, normals: Float32Array, bvh: ThreadedBVH, maxDist: number): Promise<Float32Array> {
    GpuJsRunner.addressable(samples.length, bvh.nodes.length, bvh.tris.length);
    const n = samples.length / 3;
    return f32(await this.k('wallBVH', wallBVHK, n, bvh.nodeCount)(samples, normals, bvh.nodes, bvh.tris, bvh.nodeCount, maxDist));
  }

  async distBrute(samples: Float32Array, tris: Float32Array): Promise<Float32Array> {
    GpuJsRunner.addressable(samples.length, tris.length);
    const n = samples.length / 3, T = tris.length / 9;
    return f32(await this.k('distBrute', distBruteK, n, T)(samples, tris, T));
  }

  async distBVH(samples: Float32Array, bvh: ThreadedBVH): Promise<Float32Array> {
    GpuJsRunner.addressable(samples.length, bvh.nodes.length, bvh.tris.length);
    const n = samples.length / 3;
    return f32(await this.k('distBVH', distBVHK, n, bvh.nodeCount)(samples, bvh.nodes, bvh.tris, bvh.nodeCount));
  }

  destroy() {
    this.kernels.clear();
    try { this.gpu.destroy(); } catch { /* some backends throw on double destroy */ }
  }
}

function f32(r: unknown): Float32Array {
  if (r instanceof Float32Array) return r;
  if (Array.isArray(r)) return Float32Array.from(r as number[]);
  if (r && typeof (r as { toArray?: unknown }).toArray === 'function') return f32((r as { toArray: () => unknown }).toArray());
  return Float32Array.from(r as ArrayLike<number>);
}
