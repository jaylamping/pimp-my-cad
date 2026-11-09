/// <reference lib="webworker" />
// Hosts GpuChecks off the main thread: BVH build + packing, compute dispatch, readback and the
// pseudonormal sign pass all happen here, so a large assembly no longer stalls the UI.
import { GpuChecks } from './gpu';
import type { SoupData } from './soup';

export type GpuRequest =
  | { op: 'init' }
  | { op: 'wall'; req: number; soup: SoupData }
  | { op: 'distance'; req: number; soup: SoupData; baseline: SoupData | null; baselineId: number }
  | { op: 'forget'; id: number };
export type GpuResponse =
  | { op: 'init'; ok: boolean; maxBinding: number }
  | { op: 'done'; req: number; out: Float32Array }
  | { op: 'error'; req: number; message: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let gpu: GpuChecks | null = null;
/** Baselines arrive once and are kept until forgotten, so re-runs don't re-upload them. */
const baselines = new Map<number, SoupData>();
let queue: Promise<unknown> = Promise.resolve(); // one job at a time: they share one device

ctx.onmessage = (e: MessageEvent<GpuRequest>) => {
  const m = e.data;
  if (m.op === 'init') {
    GpuChecks.create().then((g) => {
      gpu = g;
      ctx.postMessage({ op: 'init', ok: !!g, maxBinding: g?.maxBinding ?? 0 } satisfies GpuResponse);
    });
  } else if (m.op === 'forget') {
    baselines.delete(m.id);
    queue = queue.then(() => gpu?.forget(m.id));
  } else {
    queue = queue.then(async () => {
      try {
        if (!gpu) throw new Error('GPU not initialised');
        let out: Float32Array;
        if (m.op === 'wall') {
          out = await gpu.wall(m.soup);
          gpu.forget(m.soup.id); // per-run BVH
        } else {
          if (m.baseline) baselines.set(m.baselineId, m.baseline);
          const b = baselines.get(m.baselineId);
          if (!b) throw new Error('baseline missing in GPU worker');
          out = await gpu.distance(m.soup, b);
          gpu.forget(m.soup.id);
        }
        ctx.postMessage({ op: 'done', req: m.req, out } satisfies GpuResponse, [out.buffer]);
      } catch (err) {
        ctx.postMessage({ op: 'error', req: m.req, message: (err as Error).message ?? String(err) } satisfies GpuResponse);
      }
    });
  }
};
