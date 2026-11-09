/**
 * Angle-weighted pseudonormals (Bærentzen & Aanæs) for robust inside/outside signs.
 *
 * The sign of a closest-point query must come from the *feature* the closest point lies on: the
 * face normal if it is inside a face, the edge pseudonormal (sum of the two adjacent face normals)
 * on an edge, the vertex pseudonormal (angle-weighted sum of incident face normals) on a vertex.
 * Using one incident face's normal instead gives the wrong sign near sharp features.
 * Vertices are welded by position, so non-indexed triangle soups work. Open edges fall back to
 * the single adjacent face normal.
 */
export type Pseudo = {
  /** 3 floats per triangle: face normal. */
  face: Float32Array;
  /** 9 floats per triangle: pseudonormal at vertex a, b, c. */
  vert: Float32Array;
  /** 9 floats per triangle: normal across edge ab, bc, ca. */
  edge: Float32Array;
  tris: Float32Array;
};

const EPS_BARY = 1e-4;

export function buildPseudo(tris: Float32Array): Pseudo {
  const T = tris.length / 9;
  const face = new Float32Array(T * 3);
  const vert = new Float32Array(T * 9);
  const edge = new Float32Array(T * 9);
  // weld
  let diag = 0;
  { const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < tris.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], tris[i + k]); mx[k] = Math.max(mx[k], tris[i + k]); }
    diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1; }
  const q = diag * 1e-6;
  const ids = new Map<string, number>();
  const vid = new Int32Array(T * 3);
  for (let i = 0; i < T * 3; i++) {
    const key = `${Math.round(tris[i * 3] / q)},${Math.round(tris[i * 3 + 1] / q)},${Math.round(tris[i * 3 + 2] / q)}`;
    let id = ids.get(key);
    if (id === undefined) { id = ids.size; ids.set(key, id); }
    vid[i] = id;
  }
  const vsum = new Float64Array(ids.size * 3);
  const esum = new Map<string, number[]>();
  const ekey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (let t = 0; t < T; t++) {
    const o = t * 9;
    const e1 = [tris[o + 3] - tris[o], tris[o + 4] - tris[o + 1], tris[o + 5] - tris[o + 2]];
    const e2 = [tris[o + 6] - tris[o], tris[o + 7] - tris[o + 1], tris[o + 8] - tris[o + 2]];
    let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    n = [n[0] / len, n[1] / len, n[2] / len];
    face.set(n, t * 3);
    for (let c = 0; c < 3; c++) {
      const p = [tris[o + c * 3], tris[o + c * 3 + 1], tris[o + c * 3 + 2]];
      const a = [tris[o + ((c + 1) % 3) * 3] - p[0], tris[o + ((c + 1) % 3) * 3 + 1] - p[1], tris[o + ((c + 1) % 3) * 3 + 2] - p[2]];
      const b = [tris[o + ((c + 2) % 3) * 3] - p[0], tris[o + ((c + 2) % 3) * 3 + 1] - p[1], tris[o + ((c + 2) % 3) * 3 + 2] - p[2]];
      const la = Math.hypot(a[0], a[1], a[2]), lb = Math.hypot(b[0], b[1], b[2]);
      const ang = Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / ((la * lb) || 1))));
      const v = vid[t * 3 + c];
      vsum[v * 3] += n[0] * ang; vsum[v * 3 + 1] += n[1] * ang; vsum[v * 3 + 2] += n[2] * ang;
      const k = ekey(vid[t * 3 + c], vid[t * 3 + (c + 1) % 3]);
      const s = esum.get(k);
      if (s) { s[0] += n[0]; s[1] += n[1]; s[2] += n[2]; } else esum.set(k, [n[0], n[1], n[2]]);
    }
  }
  const norm = (x: number, y: number, z: number, fb: number[], out: Float32Array, at: number) => {
    const l = Math.hypot(x, y, z);
    if (l < 1e-9) { out[at] = fb[0]; out[at + 1] = fb[1]; out[at + 2] = fb[2]; } else { out[at] = x / l; out[at + 1] = y / l; out[at + 2] = z / l; }
  };
  for (let t = 0; t < T; t++) {
    const fn = [face[t * 3], face[t * 3 + 1], face[t * 3 + 2]];
    for (let c = 0; c < 3; c++) {
      const v = vid[t * 3 + c];
      norm(vsum[v * 3], vsum[v * 3 + 1], vsum[v * 3 + 2], fn, vert, t * 9 + c * 3);
      const s = esum.get(ekey(vid[t * 3 + c], vid[t * 3 + (c + 1) % 3]))!;
      norm(s[0], s[1], s[2], fn, edge, t * 9 + c * 3);
    }
  }
  return { face, vert, edge, tris };
}

/**
 * +1 if the query point `p` is outside the solid, -1 inside, given the closest point as triangle
 * `t` with barycentric weights (wa, wb, wc) for its vertices a, b, c.
 */
export function signAt(ps: Pseudo, t: number, wa: number, wb: number, wc: number, px: number, py: number, pz: number): 1 | -1 {
  const o = t * 9;
  // closest point from barycentrics
  const qx = ps.tris[o] * wa + ps.tris[o + 3] * wb + ps.tris[o + 6] * wc;
  const qy = ps.tris[o + 1] * wa + ps.tris[o + 4] * wb + ps.tris[o + 7] * wc;
  const qz = ps.tris[o + 2] * wa + ps.tris[o + 5] * wb + ps.tris[o + 8] * wc;
  const a = wa > EPS_BARY, b = wb > EPS_BARY, c = wc > EPS_BARY;
  let src: Float32Array, at: number;
  if (a && b && c) { src = ps.face; at = t * 3; }
  else if (a && !b && !c) { src = ps.vert; at = o; }
  else if (!a && b && !c) { src = ps.vert; at = o + 3; }
  else if (!a && !b && c) { src = ps.vert; at = o + 6; }
  else if (a && b) { src = ps.edge; at = o; }
  else if (b && c) { src = ps.edge; at = o + 3; }
  else { src = ps.edge; at = o + 6; } // c, a
  return (px - qx) * src[at] + (py - qy) * src[at + 1] + (pz - qz) * src[at + 2] >= 0 ? 1 : -1;
}
