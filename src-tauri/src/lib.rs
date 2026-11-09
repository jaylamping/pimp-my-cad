// Native side of TandemCAD: local files, the STEP converter sidecar, the
// metadata file next to each opened file, and a file watcher for live reload.
//
// Comments live in `<file>.tandem.json` beside the opened file (same schema as
// `ReviewDoc` in src/comments.ts), so agents and git can read them directly.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::Duration,
};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{ipc::Response, AppHandle, Emitter, Manager, State};

type Res<T> = Result<T, String>;
fn err<E: std::fmt::Display>(e: E) -> String { e.to_string() }

fn sidecar_path(file: &str) -> PathBuf { PathBuf::from(format!("{file}.tandem.json")) }

/// Raw bytes of any file (a Response avoids JSON-encoding large buffers).
#[tauri::command]
fn read_file(path: String) -> Res<Response> {
    Ok(Response::new(fs::read(&path).map_err(err)?))
}

#[tauri::command]
fn load_sidecar(file: String) -> Res<Option<String>> {
    let p = sidecar_path(&file);
    if !p.exists() { return Ok(None); }
    fs::read_to_string(p).map(Some).map_err(err)
}

/// Write via temp file + rename so an agent never reads a half-written file.
#[tauri::command]
fn save_sidecar(file: String, json: String) -> Res<()> {
    let p = sidecar_path(&file);
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, json).map_err(err)?;
    fs::rename(&tmp, &p).map_err(err)
}

/// Converter: the bundled `step2glb` sidecar next to the app binary if present,
/// else `python tools/step2glb/step2glb.py` (dev; set TANDEMCAD_PYTHON / TANDEMCAD_STEP2GLB).
fn converter() -> (Command, String) {
    if let Ok(exe) = std::env::current_exe() {
        let name = if cfg!(windows) { "step2glb.exe" } else { "step2glb" };
        if let Some(dir) = exe.parent() {
            let p = dir.join(name);
            if p.exists() { return (Command::new(&p), p.to_string_lossy().into()); }
        }
    }
    let script = std::env::var("TANDEMCAD_STEP2GLB")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../tools/step2glb/step2glb.py").into());
    let py = std::env::var("TANDEMCAD_PYTHON").unwrap_or_else(|_| if cfg!(windows) { "python".into() } else { "python3".into() });
    let mut c = Command::new(&py);
    c.arg(&script);
    (c, script)
}

/// Convert a STEP file to GLB, cached by the STEP's hash plus the converter version.
#[tauri::command]
async fn convert_step(app: AppHandle, path: String) -> Res<Response> {
    let cache = app.path().app_cache_dir().map_err(err)?.join("step2glb");
    tauri::async_runtime::spawn_blocking(move || -> Res<Response> {
        let bytes = fs::read(&path).map_err(err)?;
        let (mut cmd, ver_src) = converter();
        let ver = fs::read(&ver_src).map(|b| format!("{:x}", Sha256::digest(b))).unwrap_or_default();
        let key = format!("{:x}-{}", Sha256::digest(&bytes), &ver[..ver.len().min(12)]);
        let dir = cache.join(key);
        let stem = Path::new(&path).file_stem().and_then(|s| s.to_str()).unwrap_or("model");
        let out = dir.join(format!("{stem}.glb"));
        if !out.exists() {
            fs::create_dir_all(&dir).map_err(err)?;
            let src = dir.join(Path::new(&path).file_name().unwrap());
            fs::write(&src, &bytes).map_err(err)?;
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flash from the bundled exe
            }
            let o = cmd.arg(&src).arg("-o").arg(&out).arg("--tree").arg("--quiet").output()
                .map_err(|e| format!("could not start the STEP converter: {e}. Install Python 3 and `pip install -r tools/step2glb/requirements.txt`, or set TANDEMCAD_PYTHON."))?;
            if !o.status.success() { return Err(String::from_utf8_lossy(&o.stderr).trim().to_string()); }
        }
        Ok(Response::new(fs::read(out).map_err(err)?))
    }).await.map_err(err)?
}

struct Watch(Mutex<Option<RecommendedWatcher>>);

#[derive(Clone, Serialize)]
struct Changed { path: String }

/// Watch the opened file (replaces any previous watch). CAD programs write
/// in bursts, so events are debounced into one `file-changed` event.
#[tauri::command]
fn watch_file(app: AppHandle, state: State<Watch>, path: String) -> Res<()> {
    let target = PathBuf::from(&path);
    let dir = target.parent().ok_or("no parent folder")?.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let t2 = target.clone();
    let mut w = notify::recommended_watcher(move |ev: notify::Result<notify::Event>| {
        if let Ok(ev) = ev {
            if ev.paths.iter().any(|p| p == &t2) && !ev.kind.is_access() { let _ = tx.send(()); }
        }
    }).map_err(err)?;
    // watch the folder: many programs save by replacing the file
    w.watch(&dir, RecursiveMode::NonRecursive).map_err(err)?;
    std::thread::spawn(move || {
        while rx.recv().is_ok() {
            while rx.recv_timeout(Duration::from_millis(600)).is_ok() {}
            let _ = app.emit("file-changed", Changed { path: path.clone() });
        }
    });
    *state.0.lock().unwrap() = Some(w);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Watch(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![read_file, load_sidecar, save_sidecar, convert_step, watch_file])
        .run(tauri::generate_context!())
        .expect("error while running TandemCAD");
}
