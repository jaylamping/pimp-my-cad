import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { Prepared } from './mesh';

/**
 * Ground truth: three-mesh-bvh on the CPU, main thread, double-checked against nothing but itself.
 * Every GPU result is compared to these arrays.
 */

export const WALL_MAX = 20; // mm; rays that travel further than this report WALL_MAX
/** Rays start this far inside the surface so they don't re-hit their own face; added back to the result. */
export const RAY_BIAS = 1e-3;
export const BED_EPS = 0.2; // mm; faces this close to the lowest Z sit on the bed, not overhangs

export function bvhFor(p: Prepared): MeshBVH {
  const g = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(p.tris, 3));
  return new MeshBVH(g);
}

/** Degrees past vertical for down-facing faces: 0 = wall or up-facing, 90 = flat ceiling. */
export function overhangCPU(p: Prepared, samples = p.samples, normals = p.normals): Float32Array {
  const n = samples.length / 3;
  const out = new Float32Array(n);
  const minZ = p.bounds.min.z;
  for (let i = 0; i < n; i++) {
    const nz = normals[i * 3 + 2];
    out[i] = samples[i * 3 + 2] < minZ + BED_EPS ? 0 : (Math.asin(Math.max(0, Math.min(1, -nz))) * 180) / Math.PI;
  }
  return out;
}

/** Distance from each sample through the material along -normal to the first surface. */
export function wallCPU(p: Prepared, bvh: MeshBVH, samples = p.samples, normals = p.normals): Float32Array {
  const n = samples.length / 3;
  const out = new Float32Array(n);
  const ray = new THREE.Ray();
  for (let i = 0; i < n; i++) {
    const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
    ray.origin.set(samples[i * 3] - nx * 1e-3, samples[i * 3 + 1] - ny * 1e-3, samples[i * 3 + 2] - nz * 1e-3);
    ray.direction.set(-nx, -ny, -nz);
    const hit = bvh.raycastFirst(ray, THREE.DoubleSide, 0, WALL_MAX);
    out[i] = hit ? Math.min(hit.distance + RAY_BIAS, WALL_MAX) : WALL_MAX; // + the inward offset the ray started with
  }
  return out;
}

/**
 * Signed distance from each sample of revision B to the surface of revision A. Positive where B
 * sits outside A (material added), negative inside (material removed).
 */
export function distanceCPU(bvhA: MeshBVH, samples: Float32Array): Float32Array {
  const n = samples.length / 3;
  const out = new Float32Array(n);
  const p = new THREE.Vector3();
  const target = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  const tri = new THREE.Triangle(), nrm = new THREE.Vector3();
  const pos = bvhA.geometry.getAttribute('position');
  const idx = bvhA.geometry.index!;
  for (let i = 0; i < n; i++) {
    p.set(samples[i * 3], samples[i * 3 + 1], samples[i * 3 + 2]);
    bvhA.closestPointToPoint(p, target);
    const f = target.faceIndex;
    tri.setFromAttributeAndIndices(pos, idx.getX(f * 3), idx.getX(f * 3 + 1), idx.getX(f * 3 + 2));
    tri.getNormal(nrm);
    const sgn = nrm.dot(p.clone().sub(target.point)) >= 0 ? 1 : -1;
    out[i] = sgn * target.distance;
  }
  return out;
}
