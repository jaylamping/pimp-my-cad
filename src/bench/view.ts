import * as THREE from 'three';
import { WebGPURenderer, MeshStandardNodeMaterial } from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Prepared } from './mesh';
import { WALL_MAX } from './cpu';

export type Workload = 'overhang' | 'wall' | 'distance';

/** Settings the colour maps read; editable in the UI. */
export const thresholds = { thinWall: 1.2, overhang: 45, distRange: 0.5, distTol: 0.02 };

/**
 * Heatmap viewer on three's WebGPURenderer. The same renderer instance runs the TSL compute, so a
 * result could stay on the GPU and colour the mesh directly; the bench reads results back anyway
 * because every engine has to be compared on the CPU.
 */
export class HeatView {
  renderer: WebGPURenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(35, 1, 0.5, 5000);
  controls: OrbitControls;
  private pivot = new THREE.Group();
  private mesh: THREE.Mesh | null = null;

  constructor(private el: HTMLElement, forceWebGL: boolean, device?: GPUDevice) {
    this.renderer = new WebGPURenderer({ antialias: true, forceWebGL, trackTimestamp: true, device } as never);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    el.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x1d2024);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(1, 2, 1.5);
    const fill = new THREE.DirectionalLight(0xffffff, 0.8);
    fill.position.set(-1.5, -0.5, -1);
    this.scene.add(key, fill, new THREE.HemisphereLight(0xffffff, 0x334455, 1.2));
    this.pivot.rotation.x = -Math.PI / 2; // CAD Z-up -> three Y-up
    this.scene.add(this.pivot);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    new ResizeObserver(() => this.resize()).observe(el);
  }

  async init() {
    await this.renderer.init();
    this.resize();
    this.resume();
  }

  /** The render loop competes with compute for the GPU (and, on software adapters, the CPU), so
   *  the bench pauses it while measuring. */
  pause() { this.renderer.setAnimationLoop(null); }
  resume() { this.renderer.setAnimationLoop(() => { this.controls.update(); this.renderer.render(this.scene, this.camera); }); }

  get backendName(): string {
    return (this.renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  }

  private resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  show(p: Prepared) {
    if (this.mesh) { this.pivot.remove(this.mesh); (this.mesh.material as THREE.Material).dispose(); }
    const mat = new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.65, metalness: 0.0, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(p.geometry, mat);
    this.pivot.add(this.mesh);
    const c = p.bounds.getCenter(new THREE.Vector3());
    this.mesh.position.copy(c).negate();
    const r = p.bounds.getSize(new THREE.Vector3()).length() / 2;
    this.camera.position.set(r * 1.6, r * 1.2, r * 1.9);
    this.camera.near = r / 100; this.camera.far = r * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, 0, 0);
  }

  /** Writes per-sample values into the vertex colours. `values` may be null to reset. */
  paint(p: Prepared, w: Workload | null, values: Float32Array | null) {
    const col = p.geometry.getAttribute('color') as THREE.BufferAttribute;
    const a = col.array as Float32Array;
    const c = new THREE.Color();
    for (let i = 0; i < p.sampleCount; i++) {
      if (!w || !values) c.setRGB(0.78, 0.78, 0.76);
      else colour(w, values[i], c);
      a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b;
    }
    col.needsUpdate = true;
  }
}

const NEUTRAL = new THREE.Color(0.78, 0.78, 0.76);
const lerp3 = (stops: [number, THREE.Color][], t: number, out: THREE.Color) => {
  if (t <= stops[0][0]) return out.copy(stops[0][1]);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
      return out.copy(c0).lerp(c1, (t - t0) / (t1 - t0));
    }
  }
  return out.copy(stops[stops.length - 1][1]);
};
const RED = new THREE.Color(0xe0413a), ORANGE = new THREE.Color(0xf08c3a), YELLOW = new THREE.Color(0xe8d44d);
const GREEN = new THREE.Color(0x5fbf6a), TEAL = new THREE.Color(0x4fa3bf), BLUE = new THREE.Color(0x3b6fd8);

export function colour(w: Workload, v: number, out: THREE.Color): THREE.Color {
  const th = thresholds;
  if (w === 'wall') {
    if (v >= WALL_MAX - 1e-3) return out.copy(NEUTRAL).multiplyScalar(0.8); // ray escaped: open mesh or very thick
    return lerp3([[0, RED], [th.thinWall * 0.5, RED], [th.thinWall, YELLOW], [th.thinWall * 2, GREEN], [th.thinWall * 6, TEAL]], v, out);
  }
  if (w === 'overhang') {
    if (v <= th.overhang - 10) return out.copy(NEUTRAL);
    return lerp3([[th.overhang - 10, NEUTRAL], [th.overhang, YELLOW], [th.overhang + 15, ORANGE], [90, RED]], v, out);
  }
  if (Math.abs(v) <= th.distTol) return out.copy(NEUTRAL);
  const t = Math.min(1, Math.abs(v) / th.distRange);
  return out.copy(NEUTRAL).lerp(v > 0 ? RED : BLUE, 0.25 + 0.75 * t);
}

/** CSS gradient + tick labels for the legend. */
export function legend(w: Workload): { gradient: string; ticks: string[] } {
  const th = thresholds;
  const css = (c: THREE.Color) => `#${c.getHexString()}`;
  if (w === 'wall') return {
    gradient: `linear-gradient(90deg, ${css(RED)} 0%, ${css(RED)} 8%, ${css(YELLOW)} 17%, ${css(GREEN)} 33%, ${css(TEAL)} 100%)`,
    ticks: ['0', `${th.thinWall} mm (thin)`, `${+(th.thinWall * 2).toFixed(2)}`, `${+(th.thinWall * 6).toFixed(2)}+ mm`],
  };
  if (w === 'overhang') return {
    gradient: `linear-gradient(90deg, ${css(NEUTRAL)} 0%, ${css(NEUTRAL)} 39%, ${css(YELLOW)} 50%, ${css(ORANGE)} 67%, ${css(RED)} 100%)`,
    ticks: ['0°', `${th.overhang}°`, '90° (ceiling)'],
  };
  return {
    gradient: `linear-gradient(90deg, ${css(BLUE)} 0%, ${css(NEUTRAL)} 50%, ${css(RED)} 100%)`,
    ticks: [`−${th.distRange} mm (removed)`, '0', `+${th.distRange} mm (added)`],
  };
}
