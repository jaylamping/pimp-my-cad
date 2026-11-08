# GPU print-check bench: gpu.js vs three.js WebGPU (TSL)

Spike for roadmap item 4 (print-check overlays). `bench.html` runs three checks on a mesh with every engine, compares each result to a three-mesh-bvh CPU reference, and paints the heatmap on the part.

| check | per-sample work |
| --- | --- |
| Overhang map | one `asin` of the face normal, no gathers |
| Wall thickness | ray from each triangle corner along the inward face normal, first hit within 20 mm |
| Revision distance | signed closest-point distance from each sample of the new revision to the old revision |

Samples are the corners of the non-indexed triangles (pulled 2 % toward the centroid), so results map 1:1 onto vertex colours. "Push it" subdivides every triangle k² times and sweeps k = 1, 2, 3, 4, 6 (36x the samples and triangles; k=8 was removed because it needs well over 10 GB of browser memory). Wasm and plain-JS engines are dropped above 2M samples.

## Run it

```bash
npm install
npm run bench:samples   # fetches marengo's upper-arm STLs + two older upper_arm revisions (plain Node, no git-lfs)
npm run bench           # http://localhost:5173/bench.html
npm run bench:https     # self-signed HTTPS, needed for WebGPU on a phone over a LAN IP
```

No samples? Use **Open part…** (STL or 3MF) and **Open older revision…** on the page; files stay in the browser.

Engines: CPU three-mesh-bvh (reference), gpu.js on WebGL2 / WebGPU / wasm SIMD+threads / plain cpu, and three's WebGPU renderer running TSL compute plus three-mesh-bvh's WGSL BVH (`BVHComputeData`). `?display=webgl` renders through WebGL while compute stays on WebGPU. The page is cross-origin isolated (see `vite.config.ts`) so gpu.js's wasm threads work. "Copy JSON" / "Download" export every row with the environment, so device runs can be pasted back.

## Results: RTX 5080, Chrome 156 on Windows (Joey, 2026-11-08)

One part (43,862 triangles at k=1), k-sweep with brute force off, warm runs in ms. A warm run is upload + compute + readback, so it is what an app would see per check. wasm is cut off above 2M samples by design.

| check | k (samples) | CPU, main thread | gpu.js WebGL2 | gpu.js WebGPU | gpu.js wasm | three TSL + BVH |
| --- | --- | --- | --- | --- | --- | --- |
| overhang | 1 (132k) | 1.5 | 3.2 | 4.0 | 3.0 | 8.1 |
| overhang | 6 (4.7M) | 36.5 | 31.9 | 46.1 | | 39.9 |
| wall thickness | 1 (132k) | 336 | 6.4 | 6.0 | 25.2 | 7.1 |
| wall thickness | 4 (2.1M) | 4,947 | 67.2 | 39.4 | 323 | 28.0 |
| wall thickness | 6 (4.7M) | 11,117 | 145 | 86.6 | | **51.8** |
| distance to older revision | 1 (132k) | 355 | 8.4 | 5.6 | 34.8 | 6.9 |
| distance to older revision | 4 (2.1M) | 7,532 | 92.7 | 39.9 | 725 | 24.5 |
| distance to older revision | 6 (4.7M) | 20,089 | 246 | 88.3 | | **50.4** |

- **Overhang is a CPU job.** One `asin` per sample takes 1.5 ms at normal size and 36 ms at 4.7M samples. The GPU never beats it because transfer costs more than the maths.
- **Wall thickness and distance are GPU jobs**: 50 to 400x faster than the CPU at scale. For a normal part both libraries answer in 6 to 8 ms.
- **The libraries separate at scale.** At k=1 they tie (6 to 7 ms). By 4.7M samples three TSL with three-mesh-bvh is 1.7x faster than gpu.js WebGPU and about 3-5x faster than gpu.js WebGL2, and the gap is still widening. three's GPU timer says the compute itself is 13 ms (wall) and 23 ms (distance) of those totals, so the rest is transfer.
- **gpu.js wasm** is a credible fallback for mid-size parts (0.3 to 0.7 s for 2M samples, 10 to 15x faster than the main-thread CPU) and far behind the GPU engines.
- **Memory.** An earlier sweep that went to k=8 (8.4M samples) took two Chrome processes past 10 GB. The sweep now frees buffers between sizes and stops at k=6.
- **Rare wall-thickness outliers.** From k=3 up, 1 to 14 of millions of samples differ from the CPU reference by 10 to 20 mm on every engine, three included (about 0.0004 % of samples; p99 error is 1e-5 mm). They are most likely rays grazing a triangle edge, where float32 on the GPU and float64 on the CPU disagree on hit or miss. I have not traced individual samples, so this is a hypothesis.
- **Distance sign** agrees on 99.8 to 99.9 % of samples at every size; the rest sit on the surface, where the sign is noise.

## What the sandbox could and could not measure

The sandbox has no GPU: Chromium runs WebGPU and WebGL on SwiftShader (software Vulkan), so its timings are not predictive. The iPhone run used Playwright's iPhone 15 viewport and user agent, so it checks layout only. Mobile is shelved for now, so iPhone numbers were not collected.

## Findings that do not depend on hardware

- **Correctness.** All engines match the CPU reference: max error 0.0015 to 0.0032 mm on wall thickness and distance (float32 vs float64), overhang exact. Distance sign agrees on 98 to 100 % of samples (the rest sit within 1 µm of the surface, where the sign is noise).
- **gpu.js kernel limits shape the code.** No local arrays means no stack, so its BVH is a stackless "skip link" tree traversed in fixed child order, and every closest-point query needs a greedy first descent to get a pruning bound (that change cut WebGL2 distance from 16 s to 3 s). three-mesh-bvh's WGSL path orders children and uses a real stack. Loops need `loopMaxIterations` set to the node count, and kernels must be passed as source strings so a minifier cannot break gpu.js's parser.
- **gpu.js kernels are portable, which is its real strength.** One source ran unchanged on WebGL2, WebGPU, wasm and cpu, and `ranOn()` confirms which backend actually executed (it can silently fall back to cpu). The wasm SIMD+threads backend beat both GPU backends on this software stack, and on a real iPhone it is the likely fallback path if WebGPU is unavailable.
- **three TSL is better for the render path.** Results can stay in a storage buffer and drive vertex colours with no readback, and TSL gives GPU timestamp queries (`gpu ms` column). Its WebGL2 fallback only runs overhang; gather-style kernels and raw WGSL need real WebGPU.
- **The two libraries fight over the WebGPU device.** On Chromium's software adapter, requesting a second device dropped the first (`Instance dropped`, `createBuffer failed`). `sharedDevice()` in `src/bench/gpujs.ts` creates one device and injects it into both libraries. gpu.js's `GPU.isWebGPUAvailable()` also requests an adapter, so the bench avoids calling it. gpu.js probes WebGL2 once and caches the answer, so it must run before other contexts exist.
- **three-mesh-bvh WebGPU API is marked unstable** and needs three r185+. It worked on three 0.187 here.

## Decision input

Recommendation: **three TSL + three-mesh-bvh for the overlays.** It ties gpu.js at normal part sizes and is fastest as parts grow, it shares the renderer's device, and results can stay on the GPU to colour the mesh without a readback. Costs: three-mesh-bvh's WebGPU API is marked unstable and needs three r185+, and BVH queries need real WebGPU (WebView2 and current Chrome/Edge have it).

gpu.js is a fine second choice, not a mistake: WebGPU backend within 2x at 4.7M samples, one kernel source for four backends. Its main advantage is the WebGL2 and wasm fallbacks for browsers without WebGPU, which matters less for a desktop app on WebView2. Run overhang on the CPU either way.
