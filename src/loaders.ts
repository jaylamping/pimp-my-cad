import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { load3MF } from './load3mf';

// rev: revision id for comments. Defaults to the SHA-256 of the opened bytes;
// GLBs made by tools/step2glb carry the SHA-256 of their source STEP instead,
// so re-converting the same STEP (new converter, finer mesh) keeps comments current.
export type Loaded = { root: THREE.Group; upAxis: 'y' | 'z'; rev?: string; note?: string };

const STEP_GENERATOR = 'TandemCAD step2glb';

const baseName = (n: string) => n.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '');

export async function loadModel(buf: ArrayBuffer, fileName: string): Promise<Loaded> {
  const ext = fileName.toLowerCase().split('.').pop();
  if (ext === '3mf') return { root: load3MF(buf, baseName(fileName)), upAxis: 'z' };
  if (ext === 'stl') {
    const g = new STLLoader().parse(buf);
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g);
    mesh.name = baseName(fileName);
    mesh.userData.kind = 'part';
    const root = new THREE.Group();
    root.name = baseName(fileName);
    root.add(mesh);
    return { root, upAxis: 'z' };
  }
  if (ext === 'step' || ext === 'stp') {
    const glb = await convertStep(buf, fileName);
    const loaded = await loadGlb(glb, fileName);
    return { ...loaded, note: 'converted from STEP' };
  }
  if (ext === 'glb' || ext === 'gltf') return loadGlb(buf, fileName);
  throw new Error(`Unsupported file type: ${fileName}`);
}

async function loadGlb(buf: ArrayBuffer, fileName: string): Promise<Loaded> {
  const gltf = await new GLTFLoader().parseAsync(buf, '');
  const root = new THREE.Group();
  root.name = baseName(fileName);
  const asset = gltf.asset as { generator?: string; extras?: { source?: { sha256?: string } } };
  const ours = !!asset.generator?.startsWith(STEP_GENERATOR);
  gltf.scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.userData.kind ??= 'part';
    // GLTFLoader rewrites names to be unique across the whole file ("bracket-1_1")
    // and strips characters like "." and spaces. step2glb already makes names unique
    // among siblings, so restore the CAD names: part paths then read like the CAD tree.
    if (ours && typeof o.userData.name === 'string') o.name = o.userData.name;
  });
  // step2glb files: part paths start at the CAD root ("rig/bracket_assy-1/bracket-1")
  if (ours) root.add(...gltf.scene.children);
  else root.add(gltf.scene);
  // glTF is metres, Y up; the viewer scales it back to mm.
  return { root, upAxis: 'y', rev: ours ? asset.extras?.source?.sha256 : undefined };
}

// STEP needs OpenCascade, which runs in the local server (vite plugin in
// server/step2glb.ts) rather than in the browser, so phones get a light GLB.
// In the desktop app the converter is a bundled sidecar, called with the file's path.
export let nativeStepConverter: ((path: string) => Promise<ArrayBuffer>) | null = null;
export const setNativeStepConverter = (f: (path: string) => Promise<ArrayBuffer>) => { nativeStepConverter = f; };

async function convertStep(buf: ArrayBuffer, fileName: string): Promise<ArrayBuffer> {
  if (nativeStepConverter) return nativeStepConverter(fileName);
  let res: Response;
  try {
    res = await fetch(`api/step2glb?name=${encodeURIComponent(fileName.split(/[\\/]/).pop()!)}`, { method: 'POST', body: buf });
  } catch {
    throw new Error('STEP files need the local server (npm run dev). Or convert with tools/step2glb and open the GLB.');
  }
  if (res.status === 404) throw new Error('STEP files need the local server (npm run dev). Or convert with tools/step2glb and open the GLB.');
  if (!res.ok) throw new Error(`STEP conversion failed: ${(await res.text()).slice(0, 300)}`);
  return res.arrayBuffer();
}


export async function sha256(buf: ArrayBuffer): Promise<string> {
  // crypto.subtle only exists in secure contexts (https or localhost). A phone
  // opening http://<pc-ip>:5173 doesn't get it, so fall back to plain JS.
  const bytes = globalThis.crypto?.subtle
    ? new Uint8Array(await crypto.subtle.digest('SHA-256', buf))
    : sha256js(new Uint8Array(buf));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256js(data: Uint8Array): Uint8Array {
  const len = data.length;
  const padded = new Uint8Array((((len + 9 + 63) >> 6) << 6));
  padded.set(data);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(len / 0x20000000));
  dv.setUint32(padded.length - 4, (len << 3) >>> 0);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], b = W[i - 2];
      W[i] = W[i - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + W[i - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10));
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i]);
  return out;
}
