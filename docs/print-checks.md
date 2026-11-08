# Print-check overlays

Left panel, **Print checks**: Off, Overhang, Wall thickness, Distance to baseline. Each result is one value per display vertex, painted as vertex colours with a legend; thresholds (overhang limit, thin-wall limit, distance range) recolour instantly without recomputing.

| Check | Engine | Notes |
|---|---|---|
| Overhang | CPU (~1.5 ms) | Degrees past vertical on down-facing faces. Faces within 0.2 mm of the lowest point count as bed contact. Y is up in the viewer. |
| Wall thickness | GPU | Ray from each corner along the inward face normal, first hit within 20 mm. Grey = ray escaped (open mesh or thicker than 20 mm). |
| Distance to baseline | GPU | Signed closest-point distance from the current model to the baseline surface. Red = material added, blue = removed. |

**Engine.** `src/checks/gpu.ts` runs three TSL compute plus three-mesh-bvh's WGSL BVH on its own `WebGPURenderer` that is never attached to the page, so the viewer stays on `WebGLRenderer` and only the per-vertex result is read back. The spike (PR #2, `docs/gpu-bench.md`) measured this ~1.7x faster than gpu.js WebGPU at 4.7M samples and 50-400x faster than CPU. It is loaded with a dynamic import, so the WebGPU build of three is not in the main bundle. Without real WebGPU (BVH queries need it) it falls back to three-mesh-bvh on the CPU, chunked so the UI stays responsive.
three-mesh-bvh's WebGPU API is marked unstable; pin versions when upgrading three.

**Baseline.** "Set baseline" snapshots the model on screen. On the desktop app, when the opened file is re-exported and live-reloads, the previous revision becomes the baseline automatically. Run checks with Explode at 0: the checks use the current world positions.

**Outlier filter.** Wall thickness: about 0.0004 % of samples (edge-grazing rays) come back 10-20 mm off on every engine. A flat triangle has one thickness, so a corner that differs from the median of its triangle's three corners by more than 5 mm is replaced by that median (`filterWallOutliers` in `src/checks/cpu.ts`). The count is shown next to the timing.

**Agents / debugging.** `window.pmcChecks` is the `PrintChecks` instance (`run('wall')`, `captureBaseline()`, `clear()`).
