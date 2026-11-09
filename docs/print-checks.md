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

**Outlier filter.** Wall thickness: about 0.0004 % of samples (edge-grazing rays) come back 10-20 mm too *large* on every engine. A corner reading more than 5 mm above the median of its triangle's three corners is clamped to that median (`filterWallOutliers` in `src/checks/cpu.ts`). Low readings are never touched, so a genuinely thin spot is never hidden (a flat face can vary in thickness). The count is shown next to the timing.

**Distance sign.** The closest point's sign comes from angle-weighted pseudonormals of the baseline (`src/checks/pseudo.ts`): the face normal inside a face, the edge normal on an edge, the vertex pseudonormal on a vertex. That is robust at sharp edges and tips. On the GPU the shader returns the closest feature (unsigned distance, vertex id, barycentrics) and the sign pass runs on the CPU. Open or non-manifold baselines fall back to the adjacent face normals there, so their sign is only as good as the mesh.

**Threading.** The CPU fallback runs in a Web Worker (`cpu.worker.ts`) and is cancelled by terminating it. Extracting the triangle soup and building the GPU BVH still run on the main thread (three-mesh-bvh's WebGPU BVH is built on the renderer side), so a very large assembly can stall the UI briefly before the GPU dispatch.

**Known limits.** Instanced meshes (glTF `EXT_mesh_gpu_instancing`) are rejected with a message: per-instance results would need per-instance vertex colours. Models too big for one WebGPU storage binding fall back to the CPU. 3MF revisions are compared in their original bed coordinates (the loader's per-file recentring is undone).

**Agents / debugging.** `window.pmcChecks` is the `PrintChecks` instance (`run('wall')`, `captureBaseline()`, `clear()`).
