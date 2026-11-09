import * as THREE from 'three';

/**
 * Flat triangle soup in world space (mm, Y up: the viewer's frame after its pivot rotation and
 * mm scaling). Every print check is computed per *sample*; samples are the corners of the
 * triangles, so a result array maps 1:1 onto each display mesh's vertices. Each sample carries
 * its triangle's face normal, because CAD meshes are flat-shaded and averaged normals at sharp
 * edges would cast wall-thickness rays in meaningless directions.
 *
 * Degenerate triangles stay in the soup (so indices keep lining up with vertices) and are marked
 * in `valid`.
 */
export type Soup = {
  id: number;
  triCount: number;
  /** 9 floats per triangle: a, b, c. */
  tris: Float32Array;
  /** 3 floats per sample; corner pulled 2 % toward the centroid so rays don't graze edges. */
  samples: Float32Array;
  /** 3 floats per sample: the face normal. */
  normals: Float32Array;
  valid: Uint8Array; // per triangle
  sampleCount: number;
  bounds: THREE.Box3;
  /** Per mesh: first sample and sample count. */
  ranges: { mesh: THREE.Mesh; start: number; count: number }[];
};

let nextId = 1;

/** Overlay bookkeeping lives here, not in `mesh.userData`: imported glTF extras fill userData. */
export const sources = new WeakMap<THREE.Mesh, THREE.BufferGeometry>();

const queryCache = new WeakMap<Soup, Float32Array>();
/** Finite, non-degenerate triangles only: what the BVHs are built from. */
export function queryTris(s: Soup): Float32Array {
  let q = queryCache.get(s);
  if (!q) {
    const keep: number[] = [];
    for (let t = 0; t < s.triCount; t++) {
      if (!s.valid[t]) continue;
      let ok = true;
      for (let k = 0; k < 9; k++) if (!Number.isFinite(s.tris[t * 9 + k])) { ok = false; break; }
      if (ok) keep.push(t);
    }
    q = new Float32Array(keep.length * 9);
    keep.forEach((t, i) => q!.set(s.tris.subarray(t * 9, t * 9 + 9), i * 9));
    queryCache.set(s, q);
  }
  return q;
}

/** `origin` is the viewer's pivot offset: removed so a re-exported revision lines up with its baseline. */
export function buildSoup(meshes: THREE.Mesh[], origin = new THREE.Vector3(), includeHidden = false): Soup {
  const parts: { mesh: THREE.Mesh; pos: Float32Array; flip: boolean }[] = [];
  let total = 0;
  const v = new THREE.Vector3();
  for (const mesh of meshes) {
    if ((!includeHidden && !mesh.visible) || mesh.userData.kind === 'modifier') continue;
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) throw new Error('Print checks do not support instanced meshes yet');
    mesh.updateWorldMatrix(true, false);
    const g = sources.get(mesh) ?? mesh.geometry;
    const pos = g.getAttribute('position');
    const idx = g.index;
    const n = idx ? idx.count : pos.count;
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(mesh.matrixWorld).sub(origin);
      out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
    }
    parts.push({ mesh, pos: out, flip: mesh.matrixWorld.determinant() < 0 });
    total += n;
  }
  const triCount = Math.floor(total / 3);
  const tris = new Float32Array(triCount * 9);
  const samples = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 9);
  const valid = new Uint8Array(triCount);
  const ranges: Soup['ranges'] = [];
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  let t = 0;
  for (const { mesh, pos, flip } of parts) {
    const start = t * 3;
    for (let k = 0; k + 8 < pos.length; k += 9, t++) {
      const o = t * 9;
      tris.set(pos.subarray(k, k + 9), o);
      if (flip) { // mirrored instance: world winding is reversed, restore outward orientation for queries
        tris.set(pos.subarray(k + 6, k + 9), o + 3); tris.set(pos.subarray(k + 3, k + 6), o + 6);
      }
      e1.set(pos[k + 3] - pos[k], pos[k + 4] - pos[k + 1], pos[k + 5] - pos[k + 2]);
      e2.set(pos[k + 6] - pos[k], pos[k + 7] - pos[k + 1], pos[k + 8] - pos[k + 2]);
      n.crossVectors(e1, e2);
      const ok = n.lengthSq() > 1e-14;
      valid[t] = ok ? 1 : 0;
      if (ok) n.normalize(); else n.set(0, 1, 0);
      if (flip) n.negate();
      const cx = (pos[k] + pos[k + 3] + pos[k + 6]) / 3;
      const cy = (pos[k + 1] + pos[k + 4] + pos[k + 7]) / 3;
      const cz = (pos[k + 2] + pos[k + 5] + pos[k + 8]) / 3;
      for (let c = 0; c < 3; c++) {
        samples[o + c * 3] = pos[k + c * 3] * 0.98 + cx * 0.02;
        samples[o + c * 3 + 1] = pos[k + c * 3 + 1] * 0.98 + cy * 0.02;
        samples[o + c * 3 + 2] = pos[k + c * 3 + 2] * 0.98 + cz * 0.02;
        normals[o + c * 3] = n.x; normals[o + c * 3 + 1] = n.y; normals[o + c * 3 + 2] = n.z;
      }
    }
    ranges.push({ mesh, start, count: t * 3 - start });
  }
  const bounds = new THREE.Box3();
  for (let i = 0; i < tris.length; i += 3) bounds.expandByPoint(v.set(tris[i], tris[i + 1], tris[i + 2]));
  return { id: nextId++, triCount, tris, samples, normals, valid, sampleCount: triCount * 3, bounds, ranges };
}

/** Packs xyz triples into xyzw (WGSL storage arrays of vec3 have a 16-byte stride). */
export function toVec4(a: Float32Array): Float32Array {
  const n = a.length / 3;
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { out[i * 4] = a[i * 3]; out[i * 4 + 1] = a[i * 3 + 1]; out[i * 4 + 2] = a[i * 3 + 2]; }
  return out;
}
