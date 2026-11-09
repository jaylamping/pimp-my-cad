import type { Soup } from './soup';
import { queryTris } from './soup';

/** Runs the CPU fallback in a Web Worker so extraction-sized loops never block the UI. */
export class CpuRunner {
  private worker: Worker | null = null;

  /** Cancels whatever is running (its promise never settles; callers guard with a generation). */
  cancel() { this.worker?.terminate(); this.worker = null; }

  run(kind: 'wall' | 'distance', s: Soup, baseline: Soup | null, progress?: (f: number) => void): Promise<Float32Array> {
    this.cancel();
    const w = (this.worker = new Worker(new URL('./cpu.worker.ts', import.meta.url), { type: 'module' }));
    return new Promise((resolve, reject) => {
      w.onmessage = (e) => {
        if (e.data.progress !== undefined) progress?.(e.data.progress);
        else if (e.data.error) { w.terminate(); if (this.worker === w) this.worker = null; reject(new Error(e.data.error)); }
        else { w.terminate(); if (this.worker === w) this.worker = null; resolve(e.data.out); }
      };
      w.onerror = (e) => { w.terminate(); if (this.worker === w) this.worker = null; reject(new Error(e.message || 'CPU worker failed')); };
      w.postMessage({
        kind, samples: s.samples, normals: s.normals, valid: s.valid, sampleCount: s.sampleCount,
        tris: queryTris(kind === 'wall' ? s : baseline!),
      });
    });
  }
}
