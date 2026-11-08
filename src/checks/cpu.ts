import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { Soup } from './soup';
import { buildPseudo, signAt } from './pseudo';

/** Rays that travel further than this report WALL_MAX (open mesh or very thick). */
export const WALL_MAX = 20; // mm
/** Faces this close to the lowest point sit on the bed; they are not overhangs. */
export const BED_EPS = 0.2; // mm

export function bvhFromTris(tris: Float32Array): MeshBVH {
  return new MeshBVH(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(tris, 3)));
}

/** Degrees past vertical for down-facing faces: 0 = wall or up-facing, 90 = flat ceiling. Y is up. */
export function overhang(s: Soup): Float32Array {
  const out = new Float32Array(s.sampleCount);
  const minY = s.bounds.min.y + BED_EPS;
  for (let i = 0; i < s.sampleCount; i++) {
    out[i] = !s.valid[(i / 3) | 0] || s.samples[i * 3 + 1] < minY
      ? 0
      : (Math.asin(Math.max(0, Math.min(1, -s.normals[i * 3 + 1]))) * 180) / Math.PI;
  }
  return out;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** CPU fallback for wall thickness (no WebGPU). Yields to the UI between chunks. */
export async function wall(s: Pick<Soup, 'samples' | 'normals' | 'valid' | 'sampleCount'>, queryTrisArr: Float32Array, progress?: (f: number) => void): Promise<Float32Array> {
  const bvh = bvhFromTris(queryTrisArr);
  const out = new Float32Array(s.sampleCount);
  const ray = new THREE.Ray();
  let last = performance.now();
  for (let i = 0; i < s.sampleCount; i++) {
    if (!s.valid[(i / 3) | 0]) { out[i] = WALL_MAX; continue; }
    const nx = s.normals[i * 3], ny = s.normals[i * 3 + 1], nz = s.normals[i * 3 + 2];
    ray.origin.set(s.samples[i * 3] - nx * 1e-3, s.samples[i * 3 + 1] - ny * 1e-3, s.samples[i * 3 + 2] - nz * 1e-3);
    ray.direction.set(-nx, -ny, -nz);
    const hit = bvh.raycastFirst(ray, THREE.DoubleSide, 0, WALL_MAX);
    out[i] = hit ? Math.min(hit.distance, WALL_MAX) : WALL_MAX;
    if ((i & 1023) === 0 && performance.now() - last > 40) { progress?.(i / s.sampleCount); await tick(); last = performance.now(); }
  }
  return out;
}

/** CPU fallback: signed distance from `s`'s samples to the baseline surface (+ = outside it). */
export async function distance(s: Pick<Soup, 'samples' | 'sampleCount'>, baseTris: Float32Array, progress?: (f: number) => void): Promise<Float32Array> {
  const bvhA = bvhFromTris(baseTris);
  const ps = buildPseudo(baseTris);
  const out = new Float32Array(s.sampleCount);
  const p = new THREE.Vector3();
  const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const tri = new THREE.Triangle(), bc = new THREE.Vector3();
  const pos = bvhA.geometry.getAttribute('position');
  const idx = bvhA.geometry.index!;
  let last = performance.now();
  for (let i = 0; i < s.sampleCount; i++) {
    p.set(s.samples[i * 3], s.samples[i * 3 + 1], s.samples[i * 3 + 2]);
    if (!bvhA.closestPointToPoint(p, target)) { out[i] = 0; continue; }
    const f = target.faceIndex;
    const a = idx.getX(f * 3), b = idx.getX(f * 3 + 1), c = idx.getX(f * 3 + 2);
    tri.setFromAttributeAndIndices(pos, a, b, c);
    tri.getBarycoord(target.point, bc);
    // the BVH reorders triangles but keeps their vertices, so a/3 is the original triangle
    out[i] = signAt(ps, Math.floor(a / 3), bc.x, bc.y, bc.z, p.x, p.y, p.z) * target.distance;
    if ((i & 1023) === 0 && performance.now() - last > 40) { progress?.(i / s.sampleCount); await tick(); last = performance.now(); }
  }
  return out;
}

/**
 * Wall-thickness outlier filter. A ray from a corner that grazes an edge or slips through a
 * crack reports a distance far *larger* than the other two corners of the same triangle (the
 * bench found ~0.0004 % of samples 10-20 mm off, on every engine). Corners that read more than
 * `tol` above the median of their triangle are clamped to it. Corners that read *lower* are never
 * touched: a flat face can genuinely vary in thickness, and a thin spot must not be hidden.
 */
export function filterWallOutliers(values: Float32Array, tol = 5): number {
  let fixed = 0;
  for (let t = 0; t + 2 < values.length; t += 3) {
    const a = values[t], b = values[t + 1], c = values[t + 2];
    const med = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
    for (let k = 0; k < 3; k++) {
      if (values[t + k] - med > tol) { values[t + k] = med; fixed++; }
    }
  }
  return fixed;
}
