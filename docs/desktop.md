# Desktop app (Tauri 2)

TandemCAD is a local desktop app. Decisions (Joey, 2026-11-08): Tauri shell, files stay where they are, no database server, no hosted storage, mobile shelved.

## Pieces

| Piece | Where | Notes |
| --- | --- | --- |
| Viewer | `src/` | Same Three.js viewer; `src/desktop.ts` is the only Tauri-aware file. |
| Native side | `src-tauri/src/lib.rs` | read file, review load/save/list, file + review watcher, STEP converter, file watcher. |
| STEP converter | `tools/step2glb/` | Run as a subprocess. Release builds bundle it as the `step2glb` sidecar (`src-tauri/binaries/step2glb-<target-triple>[.exe]`, built with PyInstaller). Dev falls back to `python tools/step2glb/step2glb.py` (`TANDEMCAD_PYTHON`, `TANDEMCAD_STEP2GLB` override). Results are cached in the app cache dir by STEP hash + converter version. |
| Comments | `<workspace>/.tandemcad/reviews/<model path>.json` | Schema 2 `ReviewDoc` (`src/reviewdoc.ts`): model id, path history, per-revision hashes, agent fields (claim, thread, proposal, source). Workspace = nearest folder with `.tandemcad/` or `.git`; the folder gets a `.gitignore` (`*`) and an `AGENTS.md` guide on first write. Files outside a workspace keep reviews in the app data folder. Renames re-link by content hash. Old `<file>.tandem.json` is still read once. Atomic writes; app and agents merge by comment id. No database. |
| Live reload | `watch_file` command | Watches the opened file's folder (CAD programs save by replacing the file), debounces 600 ms, emits `file-changed`; the viewer re-opens the file. Pins on the old revision show as "older rev" via the existing hash check. |

## Run

```bash
npm install
pip install -r tools/step2glb/requirements.txt
npm run desktop        # tauri dev
npm run tauri build    # dev installer, no bundled converter (see CI and the Windows installer for the real one)
```

Needs Rust and the Tauri prerequisites (WebView2 on Windows, Xcode tools on macOS). Before the first build run `npm run tauri icon <1024px.png>` to generate `src-tauri/icons/`.

## Not done yet

- This scaffold has not been compiled or run: the sandbox it was written in has no WebKitGTK. First step on your PC: `npm run desktop`.
- macOS arm64 build of the sidecar and installer (Windows x64 is built by CI).
- Pin re-mapping across revisions and ghost compare of the previous revision after a live reload.
- MCP server over the review files (the `.tandemcad/AGENTS.md` guide already ships). The review file format is the contract; the MCP server will mainly serve instructions on how to read and reply to it.
- Live loop with Fusion / SolidWorks: the app only sees what is exported, so an agent or macro has to re-export STEP/STL/3MF after each change. SolidWorks native files cannot be read without SolidWorks.

## CI and the Windows installer

- `.github/workflows/ci.yml` runs on every PR and push to `main`: frontend typecheck + build, the step2glb tests, and `cargo clippy` for the Tauri shell (on Windows).
- `.github/workflows/release.yml` builds the installer. Run it by hand from the Actions tab for a downloadable artifact, or push a `v*` tag to also attach it to a draft GitHub release.
- The installer bundles the converter as a PyInstaller exe, so users do not need Python. To build it locally: `pip install -r tools/step2glb/requirements.txt pyinstaller`, `python tools/step2glb/build_sidecar.py`, then `npm run tauri -- build --config src-tauri/tauri.release.conf.json`. The sidecar is only declared in `tauri.release.conf.json`, so `npm run desktop` keeps using your system Python.
- The installer is unsigned, so Windows SmartScreen will warn on first run.
