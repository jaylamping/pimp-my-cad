import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { load3MF } from './load3mf';

export type Loaded = { root: THREE.Group; upAxis: 'y' | 'z' };

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
  if (ext === 'glb' || ext === 'gltf') {
    const gltf = await new GLTFLoader().parseAsync(buf, '');
    const root = new THREE.Group();
    root.name = baseName(fileName);
    root.add(gltf.scene);
    gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.userData.kind ??= 'part'; });
    // Our STEP->GLB converter writes metres with Y up (glTF convention).
    return { root, upAxis: 'y' };
  }
  throw new Error(`Unsupported file type: ${fileName}`);
}

export async function sha256(buf: ArrayBuffer): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
