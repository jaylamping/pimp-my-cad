// 3MF loader that understands Bambu Studio projects: production-extension
// components (p:path into 3D/Objects/*.model), build-item transforms, and the
// part names / modifier flags kept in Metadata/model_settings.config.
// three's stock 3MFLoader ignores p:path, so Bambu files load empty with it.
import * as THREE from 'three';
import { unzipSync, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js';

type MeshData = { positions: Float32Array; indices: Uint32Array };
type Component = { path: string; objectId: string; transform: THREE.Matrix4 };
type ObjectDef = { id: string; type: string; mesh?: MeshData; components: Component[] };

const NS_P = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';

function parseTransform(s: string | null): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  if (!s) return m;
  const v = s.trim().split(/\s+/).map(Number);
  if (v.length !== 12) return m;
  // 3MF stores a 4x3 row-major affine: m00 m01 m02 m10 m11 m12 m20 m21 m22 tx ty tz
  // with row vectors (p' = p * M), so the 3x3 block is the transpose of three's column form.
  m.set(v[0], v[3], v[6], v[9], v[1], v[4], v[7], v[10], v[2], v[5], v[8], v[11], 0, 0, 0, 1);
  return m;
}

function parseModel(xml: string, path: string, into: Map<string, ObjectDef>) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const objects = doc.getElementsByTagName('object');
  for (const o of Array.from(objects)) {
    const id = o.getAttribute('id')!;
    const def: ObjectDef = { id, type: o.getAttribute('type') || 'model', components: [] };
    const meshEl = o.getElementsByTagName('mesh')[0];
    if (meshEl) {
      const vs = meshEl.getElementsByTagName('vertex');
      const ts = meshEl.getElementsByTagName('triangle');
      const positions = new Float32Array(vs.length * 3);
      for (let i = 0; i < vs.length; i++) {
        const v = vs[i];
        positions[i * 3] = +v.getAttribute('x')!;
        positions[i * 3 + 1] = +v.getAttribute('y')!;
        positions[i * 3 + 2] = +v.getAttribute('z')!;
      }
      const indices = new Uint32Array(ts.length * 3);
      for (let i = 0; i < ts.length; i++) {
        const t = ts[i];
        indices[i * 3] = +t.getAttribute('v1')!;
        indices[i * 3 + 1] = +t.getAttribute('v2')!;
        indices[i * 3 + 2] = +t.getAttribute('v3')!;
      }
      def.mesh = { positions, indices };
    }
    for (const c of Array.from(o.getElementsByTagName('component'))) {
      const p = c.getAttributeNS(NS_P, 'path') || c.getAttribute('p:path') || path;
      def.components.push({ path: p.replace(/^\//, ''), objectId: c.getAttribute('objectid')!, transform: parseTransform(c.getAttribute('transform')) });
    }
    into.set(`${path}#${id}`, def);
  }
  return doc;
}

type PartMeta = { name?: string; subtype?: string; settings: Record<string, string> };
type ObjMeta = { name?: string; parts: Map<string, PartMeta> };

function parseSettings(xml: string): Map<string, ObjMeta> {
  const out = new Map<string, ObjMeta>();
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  for (const o of Array.from(doc.getElementsByTagName('object'))) {
    const meta: ObjMeta = { parts: new Map() };
    for (const m of Array.from(o.children)) {
      if (m.tagName === 'metadata' && m.getAttribute('key') === 'name') meta.name = m.getAttribute('value') || undefined;
      if (m.tagName === 'part') {
        const pm: PartMeta = { subtype: m.getAttribute('subtype') || undefined, settings: {} };
        for (const k of Array.from(m.getElementsByTagName('metadata'))) {
          const key = k.getAttribute('key');
          if (!key) continue;
          if (key === 'name') pm.name = k.getAttribute('value') || undefined;
          else if (!/^(matrix|source_)/.test(key)) pm.settings[key] = k.getAttribute('value') || '';
        }
        meta.parts.set(m.getAttribute('id')!, pm);
      }
    }
    out.set(o.getAttribute('id')!, meta);
  }
  return out;
}

/** `recenter: false` keeps the file's own coordinates (needed to compare two revisions of one part). */
export function load3MF(buf: ArrayBuffer, fileName: string, opts: { recenter?: boolean } = {}): THREE.Group {
  const zip = unzipSync(new Uint8Array(buf));
  const defs = new Map<string, ObjectDef>();
  const rootPath = Object.keys(zip).find((k) => /^3D\/[^/]+\.model$/i.test(k)) || '3D/3dmodel.model';
  for (const k of Object.keys(zip)) if (k.endsWith('.model') && k !== rootPath) parseModel(strFromU8(zip[k]), k, defs);
  const rootDoc = parseModel(strFromU8(zip[rootPath]), rootPath, defs);
  const settings = zip['Metadata/model_settings.config'] ? parseSettings(strFromU8(zip['Metadata/model_settings.config'])) : new Map();

  const group = new THREE.Group();
  group.name = fileName;
  const geomCache = new Map<string, THREE.BufferGeometry>();
  const geometry = (key: string, d: MeshData) => {
    let g = geomCache.get(key);
    if (!g) {
      g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
      g.setIndex(new THREE.BufferAttribute(d.indices, 1));
      g.computeVertexNormals();
      geomCache.set(key, g);
    }
    return g;
  };

  const items = Array.from(rootDoc.getElementsByTagName('item'));
  items.forEach((item, idx) => {
    const objId = item.getAttribute('objectid')!;
    const root = defs.get(`${rootPath}#${objId}`);
    if (!root) return;
    const meta = settings.get(objId);
    const objName = meta?.name || `object_${objId}`;
    const objGroup = new THREE.Group();
    objGroup.name = items.length > 1 && items.filter((i) => i.getAttribute('objectid') === objId).length > 1 ? `${objName}_${idx}` : objName;
    objGroup.applyMatrix4(parseTransform(item.getAttribute('transform')));
    group.add(objGroup);

    const addMesh = (def: ObjectDef, key: string, m: THREE.Matrix4, partId: string, objType: string) => {
      const pm = meta?.parts.get(partId);
      const modifier = objType === 'other' || (pm?.subtype && pm.subtype !== 'normal_part');
      const mesh = new THREE.Mesh(geometry(key, def.mesh!));
      mesh.name = pm?.name || `${objName}_part${partId}`;
      mesh.applyMatrix4(m);
      mesh.userData.kind = modifier ? 'modifier' : 'part';
      if (pm?.subtype) mesh.userData.subtype = pm.subtype;
      if (pm && Object.keys(pm.settings).length) mesh.userData.settings = pm.settings;
      objGroup.add(mesh);
    };

    if (root.mesh) addMesh(root, `${rootPath}#${objId}`, new THREE.Matrix4(), objId, root.type);
    for (const c of root.components) {
      const key = `${c.path}#${c.objectId}`;
      const def = defs.get(key);
      if (def?.mesh) addMesh(def, key, c.transform, c.objectId, def.type);
    }
  });

  if (opts.recenter === false) return group;
  // Bed coordinates are Z-up and centred at (128,128); re-centre on the bed origin.
  const box = new THREE.Box3().setFromObject(group);
  const c = box.getCenter(new THREE.Vector3());
  for (const ch of group.children) ch.position.sub(new THREE.Vector3(c.x, c.y, box.min.z));
  return group;
}
