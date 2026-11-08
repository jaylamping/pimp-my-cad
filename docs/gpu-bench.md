# GPU print-check bench: gpu.js vs three.js WebGPU (TSL)

Spike for roadmap item 4 (print-check overlays). `bench.html` runs three checks on a mesh with every engine, compares each result to a three-mesh-bvh CPU reference, and paints the heatmap on the part.

| check | per-sample work |
| --- | --- |
| Overhang map | one `asin` of the face normal, no gathers |
| Wall thickness | ray from each triangle corner along the inward face normal, first hit within 20 mm |
| Revision distance | signed closest-point distance from each sample of the new revision to the old revision |

Samples are the corners of the non-indexed triangles (pulled 2 % toward the centroid), so results map 1:1 onto vertex colours. "Push it" subdivides every triangle k² times (k up to 8, so 64x the samples and triangles).

## Run it

```bash
npm install
npm run bench:samples   # fetches marengo's upper-arm STLs + two older upper_arm revisions (no git-lfs needed)
npm run bench           # http://localhost:5173/bench.html
npm run bench:https     # self-signed HTTPS, needed for WebGPU on a phone over a LAN IP
```

Engines: CPU three-mesh-bvh (reference), gpu.js on WebGL2 / WebGPU / wasm SIMD+threads / plain cpu, and three's WebGPU renderer running TSL compute plus three-mesh-bvh's WGSL BVH (`BVHComputeData`). `?display=webgl` renders through WebGL while compute stays on WebGPU. The page is cross-origin isolated (see `vite.config.ts`) so gpu.js's wasm threads work. "Copy JSON" / "Download" export every row with the environment, so device runs can be pasted back.

## What this session could and could not measure

The sandbox has no GPU: Chromium runs WebGPU and WebGL on SwiftShader (software Vulkan on 4 CPU cores). The iPhone run used Playwright's iPhone 15 viewport and user agent on the same software stack, so it checks layout and the phone code path, **not iPhone GPU speed**. Absolute timings below are therefore not predictive. Real WebGL2/WebGPU numbers on Joey's PC and iPhone are the open item.

Upper arm, k=1 (144k samples, 48k triangles), software GPU, ms warm:

| check | CPU bvh | gpu.js webgl2 | gpu.js webgpu | gpu.js wasm | three TSL |
| --- | --- | --- | --- | --- | --- |
| overhang | 4.5 | 5.4 | 8.6 | 4.5 | 12.4 |
| wall thickness (BVH) | 557 | 1,102 | 599 | 176 | 896 |
| revision distance (BVH) | 698 | 2,875 | 1,720 | 357 | 1,501 |

The k=8 sweep did not finish inside the sandbox's time limit, so there is no scaling data yet.

## Findings that do not depend on hardware

- **Correctness.** All engines match the CPU reference: max error 0.0015 to 0.0032 mm on wall thickness and distance (float32 vs float64), overhang exact. Distance sign agrees on 98 to 100 % of samples (the rest sit within 1 µm of the surface, where the sign is noise).
- **gpu.js kernel limits shape the code.** No local arrays means no stack, so its BVH is a stackless "skip link" tree traversed in fixed child order, and every closest-point query needs a greedy first descent to get a pruning bound (that change cut WebGL2 distance from 16 s to 3 s). three-mesh-bvh's WGSL path orders children and uses a real stack. Loops need `loopMaxIterations` set to the node count, and kernels must be passed as source strings so a minifier cannot break gpu.js's parser.
- **gpu.js kernels are portable, which is its real strength.** One source ran unchanged on WebGL2, WebGPU, wasm and cpu, and `ranOn()` confirms which backend actually executed (it can silently fall back to cpu). The wasm SIMD+threads backend beat both GPU backends on this software stack, and on a real iPhone it is the likely fallback path if WebGPU is unavailable.
- **three TSL is better for the render path.** Results can stay in a storage buffer and drive vertex colours with no readback, and TSL gives GPU timestamp queries (`gpu ms` column). Its WebGL2 fallback only runs overhang; gather-style kernels and raw WGSL need real WebGPU.
- **The two libraries fight over the WebGPU device.** On Chromium's software adapter, requesting a second device dropped the first (`Instance dropped`, `createBuffer failed`). `sharedDevice()` in `src/bench/gpujs.ts` creates one device and injects it into both libraries. gpu.js's `GPU.isWebGPUAvailable()` also requests an adapter, so the bench avoids calling it. gpu.js probes WebGL2 once and caches the answer, so it must run before other contexts exist.
- **three-mesh-bvh WebGPU API is marked unstable** and needs three r185+. It worked on three 0.187 here.

## Decision input

Not enough to pick a winner yet: that needs the real-GPU numbers and the k sweep. The hardware-independent evidence says: TSL + three-mesh-bvh for the production overlays (shared device with the renderer, ordered BVH traversal, no readback), and gpu.js as a portable fallback or for kernels that do not need a BVH.
