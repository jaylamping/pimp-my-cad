import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export type Mode = 'select' | 'pin' | 'measure';
export type Hit = { mesh: THREE.Mesh; part: string; local: THREE.Vector3; normal: THREE.Vector3; world: THREE.Vector3 };

const PALETTE = [0xd9d9d4, 0x4fb3bf, 0xf08c3a, 0x9b7fd1, 0x7fbf6a, 0xd9b44a, 0x5d8fd8, 0xd66a7e];

export function partPath(o: THREE.Object3D, root: THREE.Object3D): string {
  const names: string[] = [];
  for (let n: THREE.Object3D | null = o; n && n !== root; n = n.parent) names.unshift(n.name || n.type);
  return names.join('/');
}

export class Viewer {
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  labels: CSS2DRenderer;
  controls: OrbitControls;
  model: THREE.Group | null = null;
  meshes: THREE.Mesh[] = [];
  mode: Mode = 'select';
  selected: THREE.Mesh | null = null;
  onPick: (h: Hit | null) => void = () => {};
  onMeasure: (mm: number | null) => void = () => {};
  private pivot = new THREE.Group(); // holds the model, rotated so CAD Z-up shows upright
  private explodeBase = new Map<THREE.Object3D, { pos: THREE.Vector3; dir: THREE.Vector3 }>();
  private section = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
  private sectionOn = false;
  private measurePts: THREE.Vector3[] = [];
  private measureObj = new THREE.Group();
  private grid: THREE.GridHelper;
  size = 100;

  constructor(private el: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.localClippingEnabled = true;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    el.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'labels';
    el.appendChild(this.labels.domElement);

    this.scene.background = new THREE.Color(0x1d2024);
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(1, 2, 1.5);
    this.scene.add(key, new THREE.HemisphereLight(0xffffff, 0x334455, 0.6));

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 10000);
    this.camera.position.set(200, 160, 220);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.screenSpacePanning = true;

    this.grid = new THREE.GridHelper(400, 40, 0x3a4048, 0x2a2f35);
    this.scene.add(this.grid, this.pivot, this.measureObj);

    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    this.bindPointer();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.labels.render(this.scene, this.camera);
    });
  }

  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
  }

  setModel(root: THREE.Group, upAxis: 'y' | 'z') {
    if (this.model) this.pivot.remove(this.model);
    this.clearMeasure();
    this.selected = null;
    this.model = root;
    this.pivot.rotation.set(upAxis === 'z' ? -Math.PI / 2 : 0, 0, 0);
    this.pivot.add(root);
    this.meshes = [];
    let i = 0;
    const creased = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const modifier = m.userData.kind === 'modifier';
      // CAD meshes share vertices across sharp edges; split normals at >30 deg so edges read crisp
      if (!m.userData.creased) {
        const g = m.geometry;
        if (!creased.has(g)) creased.set(g, toCreasedNormals(g, THREE.MathUtils.degToRad(30)));
        m.geometry = creased.get(g)!;
        m.userData.creased = true;
      }
      m.material = new THREE.MeshStandardMaterial({
        color: modifier ? 0xff5050 : PALETTE[i++ % PALETTE.length],
        metalness: 0.05, roughness: 0.55, side: THREE.DoubleSide,
        transparent: modifier, opacity: modifier ? 0.25 : 1, depthWrite: !modifier,
        clippingPlanes: [this.section], clipShadows: true,
      });
      m.userData.baseColor = (m.material as THREE.MeshStandardMaterial).color.getHex();
      m.userData.part = partPath(m, root);
      this.meshes.push(m);
    });
    // glTF in metres -> show in mm so all tools read in mm
    const box0 = new THREE.Box3().setFromObject(root);
    if (upAxis === 'y' && box0.getSize(new THREE.Vector3()).length() < 5) root.scale.setScalar(1000);
    this.pivot.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.pivot);
    this.pivot.position.y -= box.min.y; // sit on the grid
    this.pivot.updateMatrixWorld(true);
    this.computeExplode();
    this.setSection(null, 0);
    this.fit();
  }

  /** Offset the viewer applies to seat the model on the grid; print checks subtract it. */
  frameOffset(): THREE.Vector3 { return this.pivot.position.clone(); }

  private bbox() { return new THREE.Box3().setFromObject(this.pivot); }

  fit(dir = new THREE.Vector3(1, 0.8, 1.1)) {
    const box = this.bbox();
    const c = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length() / 2 || 50;
    this.size = r * 2;
    // fit the narrower of the two fields of view, so portrait phones don't crop the sides
    const vHalf = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const half = Math.min(vHalf, Math.atan(Math.tan(vHalf) * this.camera.aspect));
    const dist = r / Math.sin(half) * 1.05;
    this.camera.position.copy(c).add(dir.clone().normalize().multiplyScalar(dist));
    this.camera.near = dist / 100; this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(c);
    this.grid.scale.setScalar(Math.max(1, (r * 4) / 400));
  }

  view(name: string) {
    const d: Record<string, [number, number, number]> = {
      front: [0, 0, 1], back: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0], top: [0, 1, 0.0001], bottom: [0, -1, 0.0001], iso: [1, 0.8, 1.1],
    };
    this.fit(new THREE.Vector3(...d[name]));
  }

  focus(world: THREE.Vector3) {
    const off = this.camera.position.clone().sub(this.controls.target);
    this.controls.target.copy(world);
    this.camera.position.copy(world).add(off.multiplyScalar(0.6));
  }

  // ---------- explode ----------
  // Explode every level that has more than one member: parts inside an object,
  // objects in a plate, sub-assemblies in an assembly. Each member moves away
  // from the centre of its own level, so a sub-assembly first moves out as a
  // unit and its parts then spread around it.
  private computeExplode() {
    this.explodeBase.clear();
    if (!this.model) return;
    const movers: { m: THREE.Object3D; center: THREE.Vector3 }[] = [];
    const visit = (o: THREE.Object3D) => {
      const kids = o.children.filter((k) => k.type !== 'Object2D' && !(k as any).isCSS2DObject);
      if (kids.length > 1) {
        const center = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
        for (const m of kids) movers.push({ m, center });
      }
      for (const k of kids) visit(k);
    };
    visit(this.model);
    for (const { m, center } of movers) {
      const c = new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3());
      const dirWorld = c.sub(center);
      if (dirWorld.lengthSq() < 1e-6) dirWorld.set(0, 1, 0).multiplyScalar(0.001);
      const inv = new THREE.Matrix4().copy(m.parent!.matrixWorld).invert();
      const dirLocal = dirWorld.clone().transformDirection(inv).multiplyScalar(dirWorld.length() / m.parent!.getWorldScale(new THREE.Vector3()).x);
      this.explodeBase.set(m, { pos: m.position.clone(), dir: dirLocal });
    }
  }

  setExplode(f: number) {
    for (const [o, b] of this.explodeBase) o.position.copy(b.pos).addScaledVector(b.dir, f);
  }

  // ---------- section ----------
  setSection(axis: 'x' | 'y' | 'z' | null, t: number, flip = false) {
    this.sectionOn = !!axis;
    if (!axis) { this.section.set(new THREE.Vector3(0, -1, 0), 1e9); return; }
    const box = this.bbox();
    const n = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0).multiplyScalar(flip ? 1 : -1);
    const lo = box.min[axis], hi = box.max[axis];
    const at = lo + (hi - lo) * t;
    this.section.setFromNormalAndCoplanarPoint(n, new THREE.Vector3().setComponent('xyz'.indexOf(axis), at));
  }

  // ---------- visibility / selection ----------
  setVisible(mesh: THREE.Mesh, v: boolean) { mesh.visible = v; }
  isolate(mesh: THREE.Mesh | null) { for (const m of this.meshes) m.visible = !mesh || m === mesh; }
  showModifiers(v: boolean) { for (const m of this.meshes) if (m.userData.kind === 'modifier') m.visible = v; }

  select(mesh: THREE.Mesh | null) {
    if (this.selected) (this.selected.material as THREE.MeshStandardMaterial).emissive.setHex(0x000000);
    this.selected = mesh;
    if (mesh) (mesh.material as THREE.MeshStandardMaterial).emissive.setHex(0x553300);
  }

  // ---------- picking ----------
  private ray = new THREE.Raycaster();
  raycast(ev: PointerEvent): Hit | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const hits = this.ray.intersectObjects(this.meshes.filter((m) => m.visible), false)
      .filter((h) => !this.sectionOn || this.section.distanceToPoint(h.point) >= 0)
      .filter((h) => (h.object as THREE.Mesh).userData.kind !== 'modifier' || this.meshes.every((m) => m.userData.kind === 'modifier' || !m.visible));
    const h = hits[0];
    if (!h) return null;
    const mesh = h.object as THREE.Mesh;
    const local = mesh.worldToLocal(h.point.clone());
    const normal = h.face ? h.face.normal.clone() : new THREE.Vector3(0, 0, 1);
    return { mesh, part: mesh.userData.part, local, normal, world: h.point.clone() };
  }

  private bindPointer() {
    const el = this.renderer.domElement;
    let down: { x: number; y: number; t: number } | null = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    el.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 6) return; // that was an orbit/pan, not a tap
      const hit = this.raycast(e);
      if (this.mode === 'measure') return this.addMeasure(hit);
      this.onPick(hit);
    });
  }

  // ---------- measure ----------
  private addMeasure(hit: Hit | null) {
    if (!hit) return;
    if (this.measurePts.length >= 2) this.clearMeasure();
    this.measurePts.push(hit.world);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(this.size * 0.006), new THREE.MeshBasicMaterial({ color: 0xffe14d, depthTest: false }));
    dot.renderOrder = 10;
    dot.position.copy(hit.world);
    this.measureObj.add(dot);
    if (this.measurePts.length === 2) {
      const [a, b] = this.measurePts;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: 0xffe14d, depthTest: false }));
      line.renderOrder = 10;
      this.measureObj.add(line);
      const mm = a.distanceTo(b); // setModel scales every model so world units are mm
      const div = document.createElement('div');
      div.className = 'measure-label';
      div.textContent = `${mm.toFixed(2)} mm`;
      const lbl = new CSS2DObject(div);
      lbl.position.copy(a).add(b).multiplyScalar(0.5);
      this.measureObj.add(lbl);
      this.onMeasure(mm);
    }
  }
  clearMeasure() {
    this.measurePts = [];
    for (const c of [...this.measureObj.children]) { this.measureObj.remove(c); if ((c as any).element) (c as any).element.remove(); }
    this.onMeasure(null);
  }

  // ---------- pins ----------
  private pins = new Map<string, CSS2DObject>();
  clearPins() { for (const p of this.pins.values()) { p.parent?.remove(p); p.element.remove(); } this.pins.clear(); }
  addPin(id: string, label: string, part: string, local: [number, number, number], cls: string, onClick: () => void): boolean {
    const mesh = this.meshes.find((m) => m.userData.part === part);
    if (!mesh) return false;
    const el = document.createElement('button');
    el.className = `pin ${cls}`;
    el.textContent = label;
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    const obj = new CSS2DObject(el);
    obj.position.set(...local);
    mesh.add(obj);
    this.pins.set(id, obj);
    return true;
  }
  pinWorld(id: string): THREE.Vector3 | null {
    const p = this.pins.get(id);
    return p ? p.getWorldPosition(new THREE.Vector3()) : null;
  }
  highlightPin(id: string | null) { for (const [k, p] of this.pins) p.element.classList.toggle('active', k === id); }

  screenshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}
