#!/usr/bin/env python3
"""STEP -> GLB for TandemCAD, keeping the assembly tree.

Reads a STEP file with OpenCascade's XCAF reader (names, colours, assembly
structure, instance placements), tessellates each distinct part once, and
writes a GLB where:

  * every assembly and every part instance is a glTF node, named after the
    instance in the CAD tree (SolidWorks: "bracket-2"), falling back to the
    part name; sibling names are made unique ("bolt", "bolt (2)") so a node
    path like "arm/upper_arm-1/bracket-2" always means one thing;
  * instance placements are node transforms and repeated parts share one
    mesh, so pins stay in part-local millimetres and explode moves
    sub-assemblies as units;
  * vertices are millimetres, and the root node carries the glTF convention
    (scale 0.001, Z-up -> Y-up), so other glTF tools see metres, Y up;
  * node extras carry {name, part, instance, color}; asset.extras carries the
    source file name, its SHA-256 and converter settings, so reviews can be
    keyed by the STEP revision rather than the GLB bytes.

Usage:
  python step2glb.py model.step [-o model.glb] [--deflection 0.0005] [--angle 0.25] [--absolute]
                     [--tree model.parts.json] [--quiet]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import struct
import sys
import time
from dataclasses import dataclass, field

import numpy as np

from OCP.BRep import BRep_Tool
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.Bnd import Bnd_Box
from OCP.BRepBndLib import BRepBndLib
from OCP.IFSelect import IFSelect_RetDone
from OCP.Quantity import Quantity_Color, Quantity_TOC_sRGB
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDF import TDF_Label, TDF_Tool
from OCP.TCollection import TCollection_AsciiString

try:  # OCP 7.x
    from OCP.TDF import TDF_LabelSequence
except ImportError:  # OCP 8.x moved NCollection typedefs
    from OCP.collections import Sequence_TDF_Label as TDF_LabelSequence
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS
from OCP.XCAFDoc import XCAFDoc_ColorCurv, XCAFDoc_ColorGen, XCAFDoc_ColorSurf, XCAFDoc_DocumentTool

VERSION = "1"
GENERATOR = f"tandemcad step2glb {VERSION}"
# names some exporters give the top node; the file name says more
GENERIC_NAMES = {"", "UNNAMED", "COMPOUND", "SOLID", "SHELL", "ASSEMBLY", "NONE"}


# ---------------------------------------------------------------- STEP side

def read_step(path: str):
    doc = TDocStd_Document(TCollection_ExtendedString("XmlXCAF"))
    reader = STEPCAFControl_Reader()
    reader.SetNameMode(True)
    reader.SetColorMode(True)
    reader.SetLayerMode(False)
    if reader.ReadFile(path) != IFSelect_RetDone:
        raise SystemExit(f"step2glb: could not read {path}")
    if not reader.Transfer(doc):
        raise SystemExit(f"step2glb: could not transfer {path}")
    main = doc.Main()
    return doc, XCAFDoc_DocumentTool.ShapeTool_s(main), XCAFDoc_DocumentTool.ColorTool_s(main)


def label_name(label: TDF_Label) -> str:
    attr = TDataStd_Name()
    if label.FindAttribute(TDataStd_Name.GetID_s(), attr):
        return attr.Get().ToExtString().strip()
    return ""


def shape_color(ctool, shape):
    c = Quantity_Color()
    for kind in (XCAFDoc_ColorSurf, XCAFDoc_ColorGen, XCAFDoc_ColorCurv):
        if ctool.GetColor(shape, kind, c):
            r, g, b = c.Values(Quantity_TOC_sRGB)
            return "#%02x%02x%02x" % tuple(round(max(0.0, min(1.0, v)) * 255) for v in (r, g, b))
    return None


def trsf_matrix(loc: TopLoc_Location) -> list[float]:
    """TopLoc_Location -> glTF column-major 4x4."""
    t = loc.Transformation()
    m = [[t.Value(r, c) for c in range(1, 5)] for r in range(1, 4)] + [[0.0, 0.0, 0.0, 1.0]]
    return [m[r][c] for c in range(4) for r in range(4)]


_face = getattr(TopoDS, "Face_s", None) or TopoDS.Face  # OCP 7 vs 8


IDENTITY = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]


def tessellate(shape, deflection: float, angle: float, relative: bool):
    """Mesh a shape; returns (positions float32 Nx3, indices uint32 Mx3) in the shape's frame."""
    if relative:
        box = Bnd_Box()
        BRepBndLib.Add_s(shape, box)
        if not box.IsVoid():
            diag = box.CornerMin().Distance(box.CornerMax())
            # deflection is a fraction of the part's size, clamped to sane mm bounds
            deflection = min(max(diag * deflection, 0.005), 0.2)
    BRepMesh_IncrementalMesh(shape, deflection, False, angle, True)
    pos_chunks, idx_chunks, offset = [], [], 0
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        face = _face(exp.Current())
        exp.Next()
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face, loc)
        if tri is None:
            continue
        n = tri.NbNodes()
        tr = loc.Transformation()
        pts = np.empty((n, 3), dtype=np.float64)
        for i in range(1, n + 1):
            p = tri.Node(i).Transformed(tr)
            pts[i - 1] = (p.X(), p.Y(), p.Z())
        m = tri.NbTriangles()
        idx = np.empty((m, 3), dtype=np.int64)
        for i in range(1, m + 1):
            idx[i - 1] = tri.Triangle(i).Get()
        idx -= 1
        if face.Orientation() == TopAbs_REVERSED:
            idx = idx[:, [0, 2, 1]]
        pos_chunks.append(pts)
        idx_chunks.append(idx + offset)
        offset += n
    if not pos_chunks:
        return None
    return np.vstack(pos_chunks).astype(np.float32), np.vstack(idx_chunks).astype(np.uint32)


# ---------------------------------------------------------------- tree

@dataclass
class Node:
    name: str
    extras: dict
    matrix: list[float] = field(default_factory=lambda: list(IDENTITY))
    mesh: int | None = None
    children: list["Node"] = field(default_factory=list)


class Builder:
    def __init__(self, stool, ctool, deflection, angle, relative, log):
        self.stool, self.ctool = stool, ctool
        self.deflection, self.angle, self.relative = deflection, angle, relative
        self.log = log
        self.meshes: list[tuple[np.ndarray, np.ndarray]] = []
        self.mesh_of: dict[str, int | None] = {}  # prototype label entry -> mesh index
        self.parts = 0

    def mesh_for(self, proto: TDF_Label) -> int | None:
        entry = TCollection_AsciiString()
        TDF_Tool.Entry_s(proto, entry)
        key = entry.ToCString()
        if key not in self.mesh_of:
            shape = self.stool.GetShape_s(proto)
            # mesh in the prototype's own frame: strip its location, the node carries placement
            shape = shape.Located(TopLoc_Location())
            res = tessellate(shape, self.deflection, self.angle, self.relative)
            if res is None:
                self.mesh_of[key] = None
            else:
                self.meshes.append(res)
                self.mesh_of[key] = len(self.meshes) - 1
                self.log(f"  meshed {label_name(proto) or key}: {len(res[1])} tris")
        return self.mesh_of[key]

    def build(self, label: TDF_Label, instance: TDF_Label | None = None) -> Node:
        """label is a prototype (assembly or part); instance is the component label placing it."""
        part = label_name(label)
        inst = label_name(instance) if instance is not None else ""
        extras = {"name": inst or part or "unnamed", "part": part}
        if inst and inst != part:
            extras["instance"] = inst
        color = (instance is not None and shape_color(self.ctool, self.stool.GetShape_s(instance))) or shape_color(
            self.ctool, self.stool.GetShape_s(label))
        if color:
            extras["color"] = color
        node = Node(name=extras["name"], extras=extras)
        if instance is not None:
            node.matrix = trsf_matrix(self.stool.GetLocation_s(instance))
        else:
            loc = self.stool.GetShape_s(label).Location()
            node.matrix = trsf_matrix(loc)

        if self.stool.IsAssembly_s(label):
            comps = TDF_LabelSequence()
            self.stool.GetComponents_s(label, comps, False)
            for i in range(1, comps.Length() + 1):
                comp = comps.Value(i)
                ref = TDF_Label()
                if not self.stool.GetReferredShape_s(comp, ref):
                    continue
                node.children.append(self.build(ref, comp))
            uniquify(node.children)
        else:
            self.parts += 1
            node.mesh = self.mesh_for(label)
        return node


def clean(name: str) -> str:
    # "/" separates levels in a part path; keep everything else as the CAD tool wrote it
    return name.replace("/", "-").strip() or "unnamed"


def uniquify(nodes: list[Node]):
    seen: dict[str, int] = {}
    for n in nodes:
        base = clean(n.name)
        k = seen.get(base, 0) + 1
        seen[base] = k
        n.name = base if k == 1 else f"{base} ({k})"
        n.extras["name"] = n.name


# ---------------------------------------------------------------- GLB side

# Z-up mm -> Y-up m: rotate -90 deg about X, scale 0.001 (column-major)
ROOT_MATRIX = [0.001, 0, 0, 0, 0, 0, -0.001, 0, 0, 0.001, 0, 0, 0, 0, 0, 1.0]


def write_glb(path: str, root: Node, meshes, asset_extras: dict):
    buf = bytearray()
    views, accessors, gl_meshes = [], [], []

    def add_view(data: bytes, target: int) -> int:
        while len(buf) % 4:
            buf.append(0)
        views.append({"buffer": 0, "byteOffset": len(buf), "byteLength": len(data), "target": target})
        buf.extend(data)
        return len(views) - 1

    for pos, idx in meshes:
        pv = add_view(pos.tobytes(), 34962)
        accessors.append({"bufferView": pv, "componentType": 5126, "count": int(len(pos)), "type": "VEC3",
                          "min": pos.min(0).tolist(), "max": pos.max(0).tolist()})
        small = int(pos.shape[0]) < 65536
        iv = add_view((idx.astype(np.uint16) if small else idx).tobytes(), 34963)
        accessors.append({"bufferView": iv, "componentType": 5123 if small else 5125,
                          "count": int(idx.size), "type": "SCALAR"})
        gl_meshes.append({"primitives": [{"attributes": {"POSITION": len(accessors) - 2},
                                          "indices": len(accessors) - 1, "mode": 4}]})

    nodes = []

    def emit(n: Node) -> int:
        i = len(nodes)
        d: dict = {"name": n.name, "extras": n.extras}
        nodes.append(d)
        if n.matrix != IDENTITY:
            d["matrix"] = [round(v, 9) for v in n.matrix]
        if n.mesh is not None:
            d["mesh"] = n.mesh
        kids = [emit(c) for c in n.children]
        if kids:
            d["children"] = kids
        return i

    top = emit(root)
    gltf = {
        "asset": {"version": "2.0", "generator": GENERATOR, "extras": asset_extras},
        "scene": 0,
        "scenes": [{"name": root.name, "nodes": [top]}],
        "nodes": nodes,
    }
    if gl_meshes:
        gltf.update(meshes=gl_meshes, accessors=accessors, bufferViews=views, buffers=[{"byteLength": len(buf)}])
    js = json.dumps(gltf, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    js += b" " * (-len(js) % 4)
    while len(buf) % 4:
        buf.append(0)
    chunks = struct.pack("<II", len(js), 0x4E4F534A) + js
    if buf:
        chunks += struct.pack("<II", len(buf), 0x004E4942) + bytes(buf)
    tmp = path + ".part"
    with open(tmp, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, 12 + len(chunks)) + chunks)
    os.replace(tmp, path)  # never leave a half-written GLB behind


def tree_json(n: Node, path: str = "") -> dict:
    p = f"{path}/{n.name}" if path else n.name
    d = {"path": p, **{k: v for k, v in n.extras.items() if k != "name"}}
    if n.children:
        d["children"] = [tree_json(c, p) for c in n.children]
    return d


# ---------------------------------------------------------------- main

def convert(src: str, out: str, deflection=0.0005, angle=0.25, relative=True, tree: str | None = None,
            log=lambda s: None) -> dict:
    t0 = time.time()
    with open(src, "rb") as f:
        sha = hashlib.sha256(f.read()).hexdigest()
    stem = os.path.splitext(os.path.basename(src))[0]
    _doc, stool, ctool = read_step(src)
    b = Builder(stool, ctool, deflection, angle, relative, log)
    free = TDF_LabelSequence()
    stool.GetFreeShapes(free)
    tops = [b.build(free.Value(i)) for i in range(1, free.Length() + 1)]
    uniquify(tops)
    if len(tops) == 1 and tops[0].name.upper() in GENERIC_NAMES:
        tops[0].name = tops[0].extras["name"] = clean(stem)
    if len(tops) == 1:
        root = tops[0]
        # fold the CAD root placement into the unit/axis conversion
        root.matrix = list((np.array(ROOT_MATRIX).reshape(4, 4).T @ np.array(root.matrix).reshape(4, 4).T).T.flatten())
    else:
        root = Node(name=clean(stem), extras={"name": clean(stem), "part": stem}, matrix=list(ROOT_MATRIX), children=tops)
    asset_extras = {
        "source": {"file": os.path.basename(src), "sha256": sha},
        "units": "mm in meshes; root node scales to m",
        "upAxis": "Y (source Z-up)",
        "tessellation": {"deflection": deflection, "relative": relative, "angle": angle},
    }
    write_glb(out, root, b.meshes, asset_extras)
    if tree:
        with open(tree, "w", encoding="utf-8") as f:
            json.dump({"source": asset_extras["source"], "glb": os.path.basename(out), "tree": tree_json(root)},
                      f, indent=2, ensure_ascii=False)
    tris = int(sum(len(i) for _, i in b.meshes))
    return {"parts": b.parts, "meshes": len(b.meshes), "triangles": tris, "seconds": round(time.time() - t0, 2),
            "bytes": os.path.getsize(out), "sha256": sha}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Convert a STEP part or assembly to GLB, keeping the part tree.")
    ap.add_argument("step")
    ap.add_argument("-o", "--out", help="output .glb (default: next to the input)")
    ap.add_argument("--deflection", type=float, default=None,
                    help="chordal tolerance: fraction of each part's size (default 0.0005), or mm with --absolute")
    ap.add_argument("--absolute", action="store_true", help="treat --deflection as millimetres (default 0.05)")
    ap.add_argument("--angle", type=float, default=0.25, help="angular tolerance, radians (default 0.25)")
    ap.add_argument("--tree", nargs="?", const="", help="also write the part tree as JSON (default <out>.parts.json)")
    ap.add_argument("--json", action="store_true", help="print a JSON summary on stdout")
    ap.add_argument("-q", "--quiet", action="store_true")
    a = ap.parse_args(argv)
    out = a.out or os.path.splitext(a.step)[0] + ".glb"
    tree = None if a.tree is None else (a.tree or os.path.splitext(out)[0] + ".parts.json")
    defl = a.deflection if a.deflection is not None else (0.05 if a.absolute else 0.0005)
    log = (lambda s: None) if a.quiet or a.json else (lambda s: print(s, file=sys.stderr))
    r = convert(a.step, out, defl, a.angle, not a.absolute, tree, log)
    if a.json:
        print(json.dumps({"out": out, **r}))
    elif not a.quiet:
        print(f"{out}: {r['parts']} part instances, {r['meshes']} meshes, {r['triangles']} triangles, "
              f"{r['bytes'] / 1e6:.2f} MB in {r['seconds']} s", file=sys.stderr)


if __name__ == "__main__":
    main()
