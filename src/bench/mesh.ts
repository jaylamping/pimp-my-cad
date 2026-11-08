import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { load3MF } from '../load3mf';

/**
 * Flat, renderer-agnostic mesh data shared by every backend.
 *
 * Every print check is computed per *sample*, and samples are the corners of the non-indexed
 * triangles, so a result array maps 1:1 onto the display geometry's vertex colours. Each sample
 * carries its triangle's face normal (CAD meshes are flat-shaded; averaged vertex normals at sharp
 * edges would cast wall-thickness rays in meaningless directions).
 */
export type Prepared = {
  name: string;
  triCount: number;
  /** 9 floats per triangle: a, b, c (mm, Z up). */
  tris: Float32Array;
  /** 3 floats per sample. Corner pulled 2 % toward the centroid so rays don't graze edges. */
  samples: Float32Array;
  /** 3 floats per sample: the face normal. */
  normals: Float32Array;
  sampleCount: number;
  /** Non-indexed display geometry, same vertex order as the samples. */
  geometry: THREE.BufferGeometry;
  bounds: THREE.Box3;
};

/** `fileName` matters for blob: URLs (opened files), which carry no extension to sniff the type from. */
export async function loadMesh(url: string, fileName = url): Promise<THREE.BufferGeometry> {
  const buf = await (await fetch(url)).arrayBuffer();
  return parseMesh(buf, fileName);
}

export function parseMesh(buf: ArrayBuffer, name: string): THREE.BufferGeometry {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'stl') return new STLLoader().parse(buf);
  if (ext === '3mf') {
    // Bake every part of the 3MF into one triangle soup in build-plate coordinates.
    const root = load3MF(buf, name);
    root.updateMatrixWorld(true);
    const parts: THREE.BufferGeometry[] = [];
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || m.userData.kind === 'modifier') return;
      const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(m.matrixWorld);
      parts.push(new THREE.BufferGeometry().setAttribute('position', g.getAttribute('position')));
    });
    return merge(parts);
  }
  throw new Error(`bench: unsupported mesh type ${name}`);
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const n = parts.reduce((s, g) => s + g.getAttribute('position').count, 0);
  const out = new Float32Array(n * 3);
  let o = 0;
  for (const g of parts) {
    const a = g.getAttribute('position').array as Float32Array;
    out.set(a, o);
    o += a.length;
  }
  return new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(out, 3));
}

/**
 * Splits every triangle into k² smaller ones. This is the "how far can we push it" knob: it grows
 * both the number of samples (rays / queries) and the number of triangles they test against,
 * without changing the shape, so results stay comparable across levels.
 */
export function subdivide(g: THREE.BufferGeometry, k: number): THREE.BufferGeometry {
  const src = (g.index ? g.toNonIndexed() : g).getAttribute('position').array as Float32Array;
  if (k <= 1) return new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(src), 3));
  const T = src.length / 9;
  const out = new Float32Array(T * k * k * 9);
  let o = 0;
  const P = (a: number[], b: number[], c: number[], i: number, j: number) => {
    // barycentric grid point (i, j) on a k-grid
    const u = i / k, v = j / k, w = 1 - u - v;
    return [a[0] * w + b[0] * u + c[0] * v, a[1] * w + b[1] * u + c[1] * v, a[2] * w + b[2] * u + c[2] * v];
  };
  const put = (p: number[]) => { out[o++] = p[0]; out[o++] = p[1]; out[o++] = p[2]; };
  for (let t = 0; t < T; t++) {
    const a = [src[t * 9], src[t * 9 + 1], src[t * 9 + 2]];
    const b = [src[t * 9 + 3], src[t * 9 + 4], src[t * 9 + 5]];
    const c = [src[t * 9 + 6], src[t * 9 + 7], src[t * 9 + 8]];
    for (let j = 0; j < k; j++) {
      for (let i = 0; i + j < k; i++) {
        put(P(a, b, c, i, j)); put(P(a, b, c, i + 1, j)); put(P(a, b, c, i, j + 1));
        if (i + j + 1 < k) { put(P(a, b, c, i + 1, j)); put(P(a, b, c, i + 1, j + 1)); put(P(a, b, c, i, j + 1)); }
      }
    }
  }
  return new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(out, 3));
}

/** Drops zero-area triangles (STL exports carry a few) and builds the flat arrays. */
export function prepare(g: THREE.BufferGeometry, name: string): Prepared {
  const src = (g.index ? g.toNonIndexed() : g).getAttribute('position').array as Float32Array;
  const keep: number[] = [];
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  for (let t = 0; t < src.length / 9; t++) {
    e1.set(src[t * 9 + 3] - src[t * 9], src[t * 9 + 4] - src[t * 9 + 1], src[t * 9 + 5] - src[t * 9 + 2]);
    e2.set(src[t * 9 + 6] - src[t * 9], src[t * 9 + 7] - src[t * 9 + 1], src[t * 9 + 8] - src[t * 9 + 2]);
    if (n.crossVectors(e1, e2).lengthSq() > 1e-14) keep.push(t);
  }
  const T = keep.length;
  const tris = new Float32Array(T * 9);
  const samples = new Float32Array(T * 9);
  const normals = new Float32Array(T * 9);
  keep.forEach((t, i) => {
    tris.set(src.subarray(t * 9, t * 9 + 9), i * 9);
    const ax = src[t * 9], ay = src[t * 9 + 1], az = src[t * 9 + 2];
    e1.set(src[t * 9 + 3] - ax, src[t * 9 + 4] - ay, src[t * 9 + 5] - az);
    e2.set(src[t * 9 + 6] - ax, src[t * 9 + 7] - ay, src[t * 9 + 8] - az);
    n.crossVectors(e1, e2).normalize();
    const cx = (ax + src[t * 9 + 3] + src[t * 9 + 6]) / 3;
    const cy = (ay + src[t * 9 + 4] + src[t * 9 + 7]) / 3;
    const cz = (az + src[t * 9 + 5] + src[t * 9 + 8]) / 3;
    for (let c = 0; c < 3; c++) {
      const s = i * 9 + c * 3;
      samples[s] = src[t * 9 + c * 3] * 0.98 + cx * 0.02;
      samples[s + 1] = src[t * 9 + c * 3 + 1] * 0.98 + cy * 0.02;
      samples[s + 2] = src[t * 9 + c * 3 + 2] * 0.98 + cz * 0.02;
      normals[s] = n.x; normals[s + 1] = n.y; normals[s + 2] = n.z;
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(tris.slice(), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals.slice(), 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(T * 9).fill(0.8), 3));
  geometry.computeBoundingBox();
  return { name, triCount: T, tris, samples, normals, sampleCount: T * 3, geometry, bounds: geometry.boundingBox!.clone() };
}

/** Packs xyz triples into xyzw (WGSL storage arrays of vec3 have a 16-byte stride). */
export function toVec4(a: Float32Array, w = 0): Float32Array {
  const n = a.length / 3;
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { out[i * 4] = a[i * 3]; out[i * 4 + 1] = a[i * 3 + 1]; out[i * 4 + 2] = a[i * 3 + 2]; out[i * 4 + 3] = w; }
  return out;
}

/** Takes every n-th sample, for the brute-force runs that would otherwise take minutes. */
export function strideSamples(p: Prepared, max: number): { samples: Float32Array; normals: Float32Array; idx: Uint32Array } {
  const step = Math.max(1, Math.ceil(p.sampleCount / max));
  const n = Math.ceil(p.sampleCount / step);
  const samples = new Float32Array(n * 3), normals = new Float32Array(n * 3), idx = new Uint32Array(n);
  for (let i = 0, j = 0; i < p.sampleCount; i += step, j++) {
    idx[j] = i;
    samples.set(p.samples.subarray(i * 3, i * 3 + 3), j * 3);
    normals.set(p.normals.subarray(i * 3, i * 3 + 3), j * 3);
  }
  return { samples, normals, idx };
}
