# Desktop app (Tauri 2)

TandemCAD is a local desktop app. Decisions (Joey, 2026-11-08): Tauri shell, files stay where they are, no database server, no hosted storage, mobile shelved.

## Pieces

| Piece | Where | Notes |
| --- | --- | --- |
| Viewer | `src/` | Same Three.js viewer; `src/desktop.ts` is the only Tauri-aware file. |
| Native side | `src-tauri/src/lib.rs` | read file, sidecar load/save, STEP converter, file watcher. |
| STEP converter | `tools/step2glb/` | Run as a subprocess. Release builds bundle it as the `step2glb` sidecar (`src-tauri/binaries/step2glb-<target-triple>[.exe]`, built with PyInstaller). Dev falls back to `python tools/step2glb/step2glb.py` (`TANDEM_PYTHON`, `TANDEM_STEP2GLB` override). Results are cached in the app cache dir by STEP hash + converter version. |
| Comments | `<opened file>.review.json` | Same schema as `ReviewDoc` (`src/comments.ts`). Written atomically next to the file, so agents and git read it directly. No database. |
| Live reload | `watch_file` command | Watches the opened file's folder (CAD programs save by replacing the file), debounces 600 ms, emits `file-changed`; the viewer re-opens the file. Pins on the old revision show as "older rev" via the existing hash check. |

## Run

```bash
npm install
pip install -r tools/step2glb/requirements.txt
npm run desktop        # tauri dev
npm run tauri build    # installer
```

Needs Rust and the Tauri prerequisites (WebView2 on Windows, Xcode tools on macOS). Before the first build run `npm run tauri icon <1024px.png>` to generate `src-tauri/icons/`.

## Not done yet

- This scaffold has not been compiled or run: the sandbox it was written in has no WebKitGTK. First step on your PC: `npm run desktop`.
- PyInstaller build of the sidecar and CI (Windows x64, macOS arm64).
- Pin re-mapping across revisions and ghost compare of the previous revision after a live reload.
- Agent guide + MCP server over the sidecar files. Sidecar file format is the contract; the MCP server will mainly serve instructions on how to read and reply to it.
- Live loop with Fusion / SolidWorks: the app only sees what is exported, so an agent or macro has to re-export STEP/STL/3MF after each change. SolidWorks native files cannot be read without SolidWorks.
