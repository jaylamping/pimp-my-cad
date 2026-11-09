import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Hit } from './viewer';

/** What the next taps measure. */
export type MeasureKind = 'distance' | 'angle';

/** A point stored on its mesh, so a measurement follows the part when Explode moves it. */
type Anchor = { mesh: THREE.Mesh; local: THREE.Vector3; nLocal: THREE.Vector3 };

type Item = {
  kind: MeasureKind;
  a: Anchor;
  b: Anchor;
  line: THREE.Line;
  dots: THREE.Mesh[];
  label: CSS2DObject;
};

const COLOR = 0xffe14d;

/** Persistent measurements: point to point (with ΔX/Y/Z) and angle / gap between two faces. */
export class MeasureTool {
  kind: MeasureKind = 'distance';
  readonly group = new THREE.Group();
  /** World units are mm (Viewer.setModel scales every model to mm). */
  onResult: (text: string | null) => void = () => {};
  private items: Item[] = [];
  private pending: Anchor | null = null;
  private pendingDot: THREE.Mesh | null = null;
  /** Scene -> CAD axes (undoes the Z-up pivot rotation) so Δx/Δy/Δz match the CAD frame. */
  toCad = new THREE.Quaternion();
  /** Scene-size hint so markers stay readable on both a 5 mm clip and a 2 m frame. */
  markerSize = 1;

  private anchor(h: Hit): Anchor {
    const pt = h.snapped ?? h.world;
    return {
      mesh: h.mesh,
      local: h.mesh.worldToLocal(pt.clone()),
      nLocal: h.normal.clone(),
    };
  }
  private world(a: Anchor) { return a.mesh.localToWorld(a.local.clone()); }
  private worldNormal(a: Anchor) {
    return a.nLocal.clone().transformDirection(a.mesh.matrixWorld).normalize();
  }
  private distanceText(a: THREE.Vector3, b: THREE.Vector3) {
    const d = b.clone().sub(a);
    const c = d.clone().applyQuaternion(this.toCad);
    return `${f(d.length())} mm  (Δx ${f(Math.abs(c.x))} · Δy ${f(Math.abs(c.y))} · Δz ${f(Math.abs(c.z))})`;
  }
  private dot() {
    const d = new THREE.Mesh(new THREE.SphereGeometry(this.markerSize), new THREE.MeshBasicMaterial({ color: COLOR, depthTest: false }));
    d.renderOrder = 10;
    return d;
  }

  /** Switching kind drops a half-finished measurement so a point never pairs with a face. */
  setKind(k: MeasureKind) {
    if (k === this.kind) return;
    if (this.pending) this.undo();
    this.kind = k;
    this.onResult(null);
  }

  /** Feed a tap. Returns true when it completed a measurement. */
  add(hit: Hit | null): boolean {
    if (!hit) return false;
    hit.mesh.updateWorldMatrix(true, false);
    const an = this.anchor(hit);
    if (!this.pending) {
      this.pending = an;
      this.pendingDot = this.dot();
      this.pendingDot.position.copy(this.world(an));
      this.group.add(this.pendingDot);
      this.onResult(this.kind === 'angle' ? 'Tap a second face' : 'Tap a second point');
      return false;
    }
    const a = this.pending;
    this.dropPending();
    const dots = [this.dot(), this.dot()];
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: COLOR, depthTest: false }));
    line.renderOrder = 10;
    line.frustumCulled = false;
    const el = document.createElement('div');
    el.className = 'measure-label';
    const label = new CSS2DObject(el);
    const kind = this.kind;
    const item: Item = { kind, a, b: an, line, dots, label };
    this.group.add(line, label, ...dots);
    this.items.push(item);
    this.update();
    this.onResult(el.textContent);
    return true;
  }

  private anchors() {
    const out = new Set<THREE.Mesh>();
    if (this.pending) out.add(this.pending.mesh);
    for (const it of this.items) { out.add(it.a.mesh); out.add(it.b.mesh); }
    return out;
  }

  /** Re-seat every marker after parts moved. Cheap: a few vectors per measurement. */
  update() {
    // The animation loop calls this before render(); bring matrices current so markers don't lag a frame.
    if (this.pending || this.items.length) this.anchors().forEach((m) => m.updateWorldMatrix(true, false));
    if (this.pending && this.pendingDot) this.pendingDot.position.copy(this.world(this.pending));
    for (const it of this.items) {
      const a = this.world(it.a), b = this.world(it.b);
      it.dots[0].position.copy(a);
      it.dots[1].position.copy(b);
      const pos = it.line.geometry.attributes.position as THREE.BufferAttribute;
      pos.setXYZ(0, a.x, a.y, a.z); pos.setXYZ(1, b.x, b.y, b.z);
      pos.needsUpdate = true;
      it.label.position.copy(a).add(b).multiplyScalar(0.5);
      const t = it.kind === 'angle' ? angleText(a, b, this.worldNormal(it.a), this.worldNormal(it.b)) : this.distanceText(a, b);
      if (it.label.element.textContent !== t) it.label.element.textContent = t;
    }
  }

  /** Remove the newest measurement (or the half-finished one). */
  undo() {
    if (this.pending) {
      this.dropPending();
      this.onResult(null);
      return;
    }
    const it = this.items.pop();
    if (it) this.dispose(it);
    const last = this.items[this.items.length - 1];
    this.onResult(last ? last.label.element.textContent : null);
  }

  /** Forget a half-finished measurement (leaving measure mode, Esc, switching kind). */
  cancelPending() {
    if (!this.pending) return;
    this.dropPending();
    this.onResult(null);
  }

  private dropPending() {
    if (this.pendingDot) this.disposeDot(this.pendingDot);
    this.pending = null; this.pendingDot = null;
  }

  private disposeDot(d: THREE.Mesh) {
    this.group.remove(d);
    d.geometry.dispose();
    (d.material as THREE.Material).dispose();
  }

  clear() {
    this.dropPending();
    for (const it of this.items) this.dispose(it);
    this.items = [];
    this.onResult(null);
  }

  get count() { return this.items.length; }

  private dispose(it: Item) {
    this.group.remove(it.line, it.label);
    it.label.element.remove();
    it.line.geometry.dispose();
    (it.line.material as THREE.Material).dispose();
    for (const d of it.dots) this.disposeDot(d);
  }
}

const f = (v: number) => v.toFixed(2);

function angleText(a: THREE.Vector3, b: THREE.Vector3, na: THREE.Vector3, nb: THREE.Vector3) {
  const ang = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(na.dot(nb), -1, 1)));
  // Faces facing each other (or the same way) are parallel when the angle is ~0 or ~180.
  if (ang < 0.5 || ang > 179.5) {
    const gap = Math.abs(b.clone().sub(a).dot(na));
    return `parallel faces · gap ${f(gap)} mm`;
  }
  return `${ang.toFixed(1)}° between faces (${(180 - ang).toFixed(1)}° supplementary)`;
}
