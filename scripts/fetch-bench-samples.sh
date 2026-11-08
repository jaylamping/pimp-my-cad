#!/usr/bin/env bash
# Downloads test meshes for the GPU print-check bench (bench.html) into public/samples/ (gitignored)
# and writes public/samples/bench.json. Defaults to marengo's upper-arm print package, including
# two older revisions of upper_arm.stl for the revision-distance check.
#
#   scripts/fetch-bench-samples.sh [owner/repo]
#
# Files are fetched from GitHub's LFS media endpoint, so no git-lfs install or clone is needed.
set -euo pipefail
REPO="${1:-jaylamping/marengo}"
DIR="hardware/designs/left-arm/prints/upper-arm/cad"
OUT="$(cd "$(dirname "$0")/.." && pwd)/public/samples"
mkdir -p "$OUT"
get() { # <ref> <path> <outfile>
  echo "  $3"
  curl -fsSL -o "$OUT/$3" "https://media.githubusercontent.com/media/$REPO/$1/$2"
}
echo "Fetching from $REPO into $OUT"
for f in carrier cover p2_l05 upper_arm; do get main "$DIR/$f.stl" "$f.stl"; done
# Older upper_arm revisions: e036254 (neck spikes fix, close to current) and 0c1a074 (coarse
# export from the first gate review, a much bigger change).
get e036254 "$DIR/upper_arm.stl" "upper_arm@e036254.stl"
get 0c1a074 "$DIR/upper_arm.stl" "upper_arm@0c1a074.stl"
cat > "$OUT/bench.json" <<JSON
{
  "meshes": [
    { "name": "upper_arm", "url": "/samples/upper_arm.stl",
      "revisions": [
        { "name": "upper_arm @ e036254", "url": "/samples/upper_arm@e036254.stl" },
        { "name": "upper_arm @ 0c1a074", "url": "/samples/upper_arm@0c1a074.stl" }
      ] },
    { "name": "p2_l05", "url": "/samples/p2_l05.stl", "revisions": [] },
    { "name": "cover", "url": "/samples/cover.stl", "revisions": [] },
    { "name": "carrier", "url": "/samples/carrier.stl", "revisions": [] }
  ]
}
JSON
echo "Wrote $OUT/bench.json"
