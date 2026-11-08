"""End-to-end check: build a nested STEP assembly the way SolidWorks exports one
(named instances, a sub-assembly used twice, a part used several times,
duplicate instance names), convert it, and check the GLB tree.

  python -m pytest tools/step2glb      (or)      python tools/step2glb/test_step2glb.py
"""
import json
import os
import struct
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import step2glb  # noqa: E402

from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.gp import gp_Trsf, gp_Vec, gp_Ax1, gp_Pnt, gp_Dir
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_AsIs
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.TopLoc import TopLoc_Location
from OCP.XCAFDoc import XCAFDoc_DocumentTool


def make_step(path):
    doc = TDocStd_Document(TCollection_ExtendedString("XmlXCAF"))
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())

    def name(label, n):
        TDataStd_Name.Set_s(label, TCollection_ExtendedString(n))

    def loc(x=0, y=0, z=0, rot_z_deg=0):
        t = gp_Trsf()
        if rot_z_deg:
            t.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), np.radians(rot_z_deg))
        t2 = gp_Trsf()
        t2.SetTranslation(gp_Vec(x, y, z))
        return TopLoc_Location(t2.Multiplied(t))

    plate = st.AddShape(BRepPrimAPI_MakeBox(100, 60, 5).Shape(), False)
    name(plate, "base_plate")
    bolt = st.AddShape(BRepPrimAPI_MakeCylinder(2, 12).Shape(), False)
    name(bolt, "M4x12 bolt")
    bracket = st.AddShape(BRepPrimAPI_MakeBox(20, 10, 30).Shape(), False)
    name(bracket, "bracket")

    sub = st.NewShape()
    name(sub, "bracket_assy")
    c = st.AddComponent(sub, bracket, loc())
    name(c, "bracket-1")
    for i, x in enumerate((5, 15)):
        c = st.AddComponent(sub, bolt, loc(x, 5, 30))
        name(c, "M4x12 bolt")  # same instance name twice: converter must disambiguate

    top = st.NewShape()
    name(top, "test_rig")
    c = st.AddComponent(top, plate, loc())
    name(c, "base_plate-1")
    c = st.AddComponent(top, sub, loc(10, 10, 5))
    name(c, "bracket_assy-1")
    c = st.AddComponent(top, sub, loc(90, 50, 5, rot_z_deg=180))
    name(c, "bracket_assy-2")
    st.UpdateAssemblies()

    w = STEPCAFControl_Writer()
    w.SetNameMode(True)
    w.Transfer(doc, STEPControl_AsIs)
    assert w.Write(path) == 1


def read_glb(path):
    b = open(path, "rb").read()
    magic, ver, total = struct.unpack_from("<III", b, 0)
    assert magic == 0x46546C67 and ver == 2 and total == len(b)
    jl, jt = struct.unpack_from("<II", b, 12)
    assert jt == 0x4E4F534A
    return json.loads(b[20:20 + jl])


def paths(gltf):
    out = {}

    def walk(i, prefix):
        n = gltf["nodes"][i]
        p = f"{prefix}/{n['name']}" if prefix else n["name"]
        out[p] = n
        for c in n.get("children", []):
            walk(c, p)

    for r in gltf["scenes"][0]["nodes"]:
        walk(r, "")
    return out


def test_assembly_tree():
    with tempfile.TemporaryDirectory() as d:
        src, out = os.path.join(d, "rig.step"), os.path.join(d, "rig.glb")
        make_step(src)
        r = step2glb.convert(src, out, tree=os.path.join(d, "rig.parts.json"))
        g = read_glb(out)
        p = paths(g)

        assert r["parts"] == 7  # plate + 2 x (bracket + 2 bolts)
        assert r["meshes"] == 3  # plate, bracket, bolt each meshed once
        assert len(g["meshes"]) == 3

        expected = {
            "test_rig",
            "test_rig/base_plate-1",
            "test_rig/bracket_assy-1",
            "test_rig/bracket_assy-1/bracket-1",
            "test_rig/bracket_assy-1/M4x12 bolt",
            "test_rig/bracket_assy-1/M4x12 bolt (2)",
            "test_rig/bracket_assy-2",
            "test_rig/bracket_assy-2/bracket-1",
            "test_rig/bracket_assy-2/M4x12 bolt",
            "test_rig/bracket_assy-2/M4x12 bolt (2)",
        }
        assert set(p) == expected, sorted(p)

        # instances share meshes
        assert p["test_rig/bracket_assy-1/bracket-1"]["mesh"] == p["test_rig/bracket_assy-2/bracket-1"]["mesh"]
        bolt = p["test_rig/bracket_assy-1/M4x12 bolt"]
        assert bolt["extras"]["part"] == "M4x12 bolt"

        # placements: second bolt is translated (15, 5, 30) inside the sub-assembly
        m = np.array(p["test_rig/bracket_assy-1/M4x12 bolt (2)"]["matrix"]).reshape(4, 4).T
        assert np.allclose(m[:3, 3], [15, 5, 30])
        m2 = np.array(p["test_rig/bracket_assy-2"]["matrix"]).reshape(4, 4).T
        assert np.allclose(m2[:3, 3], [90, 50, 5]) and np.allclose(m2[0, 0], -1)

        # meshes stay in millimetres; root converts to metres, Y up
        acc = g["accessors"][g["meshes"][p["test_rig/base_plate-1"]["mesh"]]["primitives"][0]["attributes"]["POSITION"]]
        assert np.allclose(acc["max"], [100, 60, 5], atol=1e-3)
        root = np.array(p["test_rig"]["matrix"]).reshape(4, 4).T
        assert np.allclose(root @ [0, 0, 1, 0], [0, 0.001, 0, 0])  # +Z (mm) -> +Y (m)

        src_meta = g["asset"]["extras"]["source"]
        assert src_meta["file"] == "rig.step" and len(src_meta["sha256"]) == 64

        tree = json.load(open(os.path.join(d, "rig.parts.json")))
        assert tree["tree"]["children"][1]["path"] == "test_rig/bracket_assy-1"


if __name__ == "__main__":
    test_assembly_tree()
    print("ok")
