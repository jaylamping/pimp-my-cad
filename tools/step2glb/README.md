# step2glb

Converts a STEP part or assembly into a GLB that keeps the CAD part tree, so the viewer can explode a full assembly part by part and comments stick to the right instance.

```bash
pip install -r tools/step2glb/requirements.txt    # cadquery-ocp (OpenCascade) + numpy
python tools/step2glb/step2glb.py arm.step              # -> arm.glb
python tools/step2glb/step2glb.py arm.step --tree       # also arm.parts.json
```

You rarely need to run it by hand: with `npm run dev` the app converts `.step` / `.stp` files itself (see [server/step2glb.ts](../../server/step2glb.ts)). Run it by hand to pre-convert files, or from another tool or agent.

## What ends up in the GLB

| CAD | GLB |
| --- | --- |
| Assembly, sub-assembly | Node with children |
| Part instance (`bracket-2`) | Node named after the instance, with a mesh |
| Same part used N times | One mesh shared by N nodes |
| Instance placement | Node matrix |
| Part / instance name, colour | Node `extras`: `{ name, part, instance, color }` |
| Source file + SHA-256 | `asset.extras.source` |

- **Names.** Nodes use the instance name from the CAD tree, falling back to the part name. Siblings with the same name get ` (2)`, ` (3)`, so a path like `arm/upper_arm-1/bracket-2` names exactly one part. `/` in a name becomes `-`.
- **Units and axes.** Meshes stay in millimetres in each part's own frame, so a pin's local coordinates are millimetres on that part. The root node scales by 0.001 and turns Z-up into Y-up, so any glTF tool sees metres, Y up.
- **Revision.** The viewer keys comments to `asset.extras.source.sha256`, the hash of the STEP, not of the GLB. Re-converting the same STEP with other settings keeps comments current; a new STEP export marks them "older rev".
- **Tessellation.** By default the chordal tolerance is 0.05 % of each part's size (clamped to 0.005 to 0.2 mm) with 0.25 rad angular tolerance. `--deflection` / `--angle` change it; `--absolute` makes `--deflection` millimetres.

## `--tree` (`<name>.parts.json`)

The part tree as plain JSON, for agents and scripts that want to map a comment's `part` path to a CAD component without opening the GLB:

```json
{
  "source": { "file": "rig.step", "sha256": "63fedd75…" },
  "glb": "rig.glb",
  "tree": {
    "path": "test_rig", "part": "test_rig",
    "children": [
      { "path": "test_rig/base_plate-1", "part": "base_plate", "instance": "base_plate-1" },
      { "path": "test_rig/bracket_assy-1", "part": "bracket_assy", "instance": "bracket_assy-1", "children": ["…"] }
    ]
  }
}
```

## SolidWorks export settings

File → Save As → STEP AP214 or AP242, from the top-level assembly: one STEP then holds the whole tree, and component instance names (`bracket-2`) come through as node names.

## Test

```bash
python tools/step2glb/test_step2glb.py
```

Builds a nested assembly (a sub-assembly used twice, a repeated part with duplicate instance names), converts it and checks names, shared meshes, placements, units and metadata.
