# Handoff (2026-11-08)

v0 was built in the marengo HARDWARE project and moves here. marengo (a humanoid robot designed in SolidWorks and printed on a Bambu P2S) is the first user, but the app stays generic: no marengo paths or names in the code.

## Why it exists

Today Joey reviews each part by opening 3MFs plus all-sides picture sheets by hand, then types feedback into chat. The goal is to open a part or an assembly in the browser (PC or phone), explode, rotate and zoom it, tap any spot on any part, and leave a comment with a suggested fix that design agents can then read and act on.

## State

Everything listed under "What it does today" in [README.md](README.md) works and was checked in headless Chromium (desktop and iPhone 13 viewport): Bambu 3MF loading with part names and modifier volumes, STL, GLB, explode, section, measure, part tree, pins, resolve, deep links, revision hashes. `npm run build` is clean.

- `src/load3mf.ts`: our own 3MF reader. three's stock `3MFLoader` ignores production-extension `p:path` components, so Bambu files load empty with it.
- `src/viewer.ts`: scene, picking (tap vs drag threshold 6 px), explode (each multi-member level moves away from the model centre), section plane, measure, CSS2D pins parented to their mesh.
- `src/main.ts`: UI, comment list, composer.
- `src/comments.ts`: comment schema and a `CommentStore` interface. Only `LocalStore` (localStorage) exists so far.

Not yet tested by Joey on a real device.

## Open question for Joey: hosting and where comments live

Posted as a choice in the marengo thread, not answered yet:

1. **Static site, comments committed to the parts repo (recommended).** Cloudflare Pages behind a login gate. The app writes review JSON into the repo that holds the parts (for marengo: `jaylamping/marengo`) through the GitHub API, using a fine-grained token pasted once per device. Agents read comments with a plain `git pull`.
2. **Small server on Joey-PC over Tailscale.** It writes JSON into the local checkout and commits. Needs the PC awake.
3. **Claude artifact with a database.** Zero setup on the phone, but comments live outside git.

The part files themselves (3MF/STL/STEP in Git LFS in the parts repo) also need serving to the hosted app: either a CI step that checks out LFS and copies them in, or fetching through the GitHub API with the same token.

## Next steps

1. Settle hosting. Then add a `GitHubStore` behind `CommentStore` and decide where review JSON goes in a parts repo (suggested: `reviews/<path of reviewed file>.json`).
2. STEP to GLB converter that keeps the assembly tree and part names. `cadquery-ocp` installs from pip (checked); plan: XCAF STEP reader into `RWGltf_CafWriter`, mm in, metres Y-up out (the viewer already scales GLB back to mm). marengo's STEP exports come from SolidWorks 2026 on Joey's Windows PC.
3. Review sets: a manifest of files reviewed together, with pass/fail per file.
4. Print-check overlays (thin walls, overhangs, stray bodies) and side-by-side revision diff.
5. Phone polish: the top bar wraps to three rows on an iPhone and eats screen height.

Test data used during development: marengo's `hardware/designs/left-arm/prints/upper-arm/*.3mf` and `cad/*.stl` (Git LFS). Put copies in `public/samples/` and list them in `public/library.local.json`; both are gitignored.
