# Viewer tools: explode, section, measure

All three work in millimetres and in the CAD frame (Z-up files are turned upright by the viewer, but axis labels and Δ values still read in CAD axes).

## Explode
- **Radial** moves every part away from the centre of its own level (sub-assemblies first, then their parts).
- **Along X / Y / Z** spreads parts along one CAD axis only, in proportion to where each part sits on it.
- Measurements follow the parts while they move.

## Section
- Pick an axis and drag the slider; a translucent plane shows where the cut is, and the panel reads the cut position in mm ("Cut at 30.0 of 50.0 mm").
- Flip keeps the other side. Picking ignores the clipped half.
- Known limit: the cut is open (no filled cap), so you see the inside faces of the parts.

## Measure (key `M`)
- **Distance**: tap two points. Taps snap to a nearby triangle corner (within 14 px). The label shows the distance and ΔX/ΔY/ΔZ.
- **Face angle**: tap two faces. Shows the angle between them, or the gap in mm when they are parallel.
- Measurements stay until **Clear** or Esc; `Z` / **Undo** removes the newest. They are anchored to the part, so they stay with it under Explode.
- Code: `src/measure.ts`. Snapping and picking live in `Viewer.raycast`.
