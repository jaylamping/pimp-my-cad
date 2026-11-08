/**
 * A "threaded" (stackless) BVH for gpu.js.
 *
 * gpu.js kernels have no local arrays, so the usual stack-based traversal is out. Instead nodes are
 * stored in depth-first order with a skip link: when a node's box is hit, go to node + 1 (its first
 * child, or the next node after a leaf); when it is missed, or after testing a leaf, jump to `skip`.
 * Traversal is a single bounded loop over an index, which every gpu.js backend can compile.
 *
 * The cost: children are always visited in the same order, so closest-hit queries prune less than
 * an ordered stack traversal (three-mesh-bvh's WGSL path does order children).
 */

export const NODE_STRIDE = 8;
export const LEAF_SIZE = 4;

export type ThreadedBVH = {
  /** NODE_STRIDE floats per node: minX minY minZ maxX maxY maxZ skip leaf. leaf = -1 for inner
   *  nodes, otherwise triStart * LEAF_SIZE + (triCount - 1). skip = nodeCount ends traversal. */
  nodes: Float32Array;
  nodeCount: number;
  /** Triangles reordered so every leaf is a contiguous range, 9 floats each. */
  tris: Float32Array;
  depth: number;
};

export function buildThreadedBVH(tris: Float32Array): ThreadedBVH {
  const T = tris.length / 9;
  if (T * LEAF_SIZE >= 1 << 24) throw new Error('bench: too many triangles for float-packed leaf ids');
  const cen = new Float32Array(T * 3);
  const bmin = new Float32Array(T * 3), bmax = new Float32Array(T * 3);
  for (let t = 0; t < T; t++) {
    for (let a = 0; a < 3; a++) {
      const x = tris[t * 9 + a], y = tris[t * 9 + 3 + a], z = tris[t * 9 + 6 + a];
      bmin[t * 3 + a] = Math.min(x, y, z);
      bmax[t * 3 + a] = Math.max(x, y, z);
      cen[t * 3 + a] = (x + y + z) / 3;
    }
  }
  const order = new Uint32Array(T);
  for (let i = 0; i < T; i++) order[i] = i;

  type N = { min: number[]; max: number[]; start: number; count: number; left?: N; right?: N };
  let depth = 0;
  const build = (start: number, count: number, d: number): N => {
    depth = Math.max(depth, d);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const cmin = [Infinity, Infinity, Infinity], cmax = [-Infinity, -Infinity, -Infinity];
    for (let i = start; i < start + count; i++) {
      const t = order[i];
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], bmin[t * 3 + a]); max[a] = Math.max(max[a], bmax[t * 3 + a]);
        cmin[a] = Math.min(cmin[a], cen[t * 3 + a]); cmax[a] = Math.max(cmax[a], cen[t * 3 + a]);
      }
    }
    const node: N = { min, max, start, count };
    if (count <= LEAF_SIZE) return node;
    // Binned SAH would build a better tree; the midpoint split keeps the spike simple and is
    // within ~20 % on CAD parts. Falls back to a median split when all centroids coincide.
    let axis = 0;
    for (let a = 1; a < 3; a++) if (cmax[a] - cmin[a] > cmax[axis] - cmin[axis]) axis = a;
    const mid = (cmin[axis] + cmax[axis]) / 2;
    let i = start, j = start + count - 1;
    while (i <= j) {
      if (cen[order[i] * 3 + axis] < mid) i++;
      else { const tmp = order[i]; order[i] = order[j]; order[j] = tmp; j--; }
    }
    let leftCount = i - start;
    if (leftCount === 0 || leftCount === count) {
      const sub = Array.from(order.subarray(start, start + count)).sort((p, q) => cen[p * 3 + axis] - cen[q * 3 + axis]);
      order.set(sub, start);
      leftCount = count >> 1;
    }
    node.left = build(start, leftCount, d + 1);
    node.right = build(start + leftCount, count - leftCount, d + 1);
    return node;
  };
  const root = build(0, T, 0);

  // flatten depth-first; a node's skip link is the first node after its subtree
  const flat: N[] = [];
  const size: number[] = [];
  const walk = (n: N): number => {
    const id = flat.length;
    flat.push(n); size.push(1);
    if (n.left && n.right) size[id] += walk(n.left) + walk(n.right);
    return size[id];
  };
  walk(root);
  const nodeCount = flat.length;
  const nodes = new Float32Array(nodeCount * NODE_STRIDE);
  flat.forEach((n, i) => {
    const o = i * NODE_STRIDE;
    nodes[o] = n.min[0]; nodes[o + 1] = n.min[1]; nodes[o + 2] = n.min[2];
    nodes[o + 3] = n.max[0]; nodes[o + 4] = n.max[1]; nodes[o + 5] = n.max[2];
    nodes[o + 6] = i + size[i]; // == nodeCount for the root and the right spine: traversal ends
    nodes[o + 7] = n.left ? -1 : n.start * LEAF_SIZE + (n.count - 1);
  });
  const out = new Float32Array(T * 9);
  for (let i = 0; i < T; i++) out.set(tris.subarray(order[i] * 9, order[i] * 9 + 9), i * 9);
  return { nodes, nodeCount, tris: out, depth };
}
