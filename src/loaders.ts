import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { load3MF } from './load3mf';

// rev: revision id for comments. Defaults to the SHA-256 of the opened bytes;
// GLBs made by tools/step2glb carry the SHA-256 of their source STEP instead,
// so re-converting the same STEP (new converter, finer mesh) keeps comments current.
export type Loaded = { root: THREE.Group; upAxis: 'y' | 'z'; rev?: string; note?: string };

const STEP_GENERATOR = 'pimp-my-cad step2glb';

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
async function convertStep(buf: ArrayBuffer, fileName: string): Promise<ArrayBuffer> {
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
  const h = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
