/// <reference lib="webworker" />
// CPU fallback for wall thickness / distance, off the main thread. One job per worker; the main
// thread terminates the worker to cancel.
import * as cpu from './cpu';

type Job = {
  kind: 'wall' | 'distance';
  samples: Float32Array; normals: Float32Array; valid: Uint8Array; sampleCount: number;
  /** Triangles the BVH is built from (wall: the model itself; distance: the baseline). */
  tris: Float32Array;
};

self.onmessage = async (e: MessageEvent<Job>) => {
  const j = e.data;
  try {
    const progress = (f: number) => (self as unknown as Worker).postMessage({ progress: f });
    const out = j.kind === 'wall' ? await cpu.wall(j, j.tris, progress) : await cpu.distance(j, j.tris, progress);
    (self as unknown as Worker).postMessage({ out }, [out.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ error: (err as Error).message });
  }
};
