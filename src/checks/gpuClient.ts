import { soupData, type Soup } from './soup';
import type { GpuRequest, GpuResponse } from './gpu.worker';

/**
 * Main-thread handle to the GPU worker (`gpu.worker.ts`). Same surface the checks use
 * (`fits`, `wall`, `distance`, `forget`), but every heavy step runs off the UI thread.
 */
export class GpuClient {
  private pending = new Map<number, { resolve: (v: Float32Array) => void; reject: (e: Error) => void }>();
  private nextReq = 1;
  private sentBaselines = new Set<number>();

  private constructor(private worker: Worker, private maxBinding: number) {
    worker.onmessage = (e: MessageEvent<GpuResponse>) => {
      const m = e.data;
      if (m.op === 'init') return;
      const p = this.pending.get(m.req);
      if (!p) return;
      this.pending.delete(m.req);
      if (m.op === 'done') p.resolve(m.out); else p.reject(new Error(m.message));
    };
    worker.onerror = (e) => this.fail(new Error(e.message || 'GPU worker crashed'));
  }

  /** Null when the webview has no usable WebGPU (in a worker or otherwise). */
  static async create(): Promise<GpuClient | null> {
    if (typeof Worker === 'undefined') return null;
    let worker: Worker;
    try { worker = new Worker(new URL('./gpu.worker.ts', import.meta.url), { type: 'module' }); }
    catch (e) { console.warn('GPU worker unavailable', e); return null; }
    const res = await new Promise<{ ok: boolean; maxBinding: number }>((resolve) => {
      worker.onmessage = (e: MessageEvent<GpuResponse>) => e.data.op === 'init' && resolve(e.data);
      worker.onerror = () => resolve({ ok: false, maxBinding: 0 });
      worker.postMessage({ op: 'init' } satisfies GpuRequest);
    });
    if (!res.ok) { worker.terminate(); return null; }
    return new GpuClient(worker, res.maxBinding);
  }

  private fail(err: Error) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private call(msg: (req: number) => GpuRequest): Promise<Float32Array> {
    const req = this.nextReq++;
    return new Promise((resolve, reject) => {
      this.pending.set(req, { resolve, reject });
      this.worker.postMessage(msg(req));
    });
  }

  fits(sampleCount: number): boolean {
    return sampleCount * 16 <= this.maxBinding && sampleCount < 3 * 5_000_000; // vertex ids travel as f32
  }

  wall(s: Soup) { return this.call((req) => ({ op: 'wall', req, soup: soupData(s) })); }

  distance(s: Soup, baseline: Soup) {
    const first = !this.sentBaselines.has(baseline.id);
    this.sentBaselines.add(baseline.id);
    return this.call((req) => ({ op: 'distance', req, soup: soupData(s), baseline: first ? soupData(baseline) : null, baselineId: baseline.id }));
  }

  /** Drops a baseline that was replaced. */
  forget(id: number) {
    this.sentBaselines.delete(id);
    this.worker.postMessage({ op: 'forget', id } satisfies GpuRequest);
  }
}
