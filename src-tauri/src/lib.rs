// Native side of TandemCAD: local files, the STEP converter sidecar, the
// review files, and a file watcher for live reload.
//
// Comments live in `.tandemcad/reviews/<model path>.json` at the workspace root
// (see reviews.rs; same schema as `ReviewDoc` in src/reviewdoc.ts), so agents
// and git can read them directly.
mod reviews;

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

/// Folder and file name used for models that sit outside any workspace.
fn loose(app: &AppHandle, file: &str) -> Res<(PathBuf, String)> {
    let dir = app.path().app_data_dir().map_err(err)?.join("reviews");
    Ok((dir, format!("{:x}", Sha256::digest(file.as_bytes()))))
}

/// Raw bytes of any file (a Response avoids JSON-encoding large buffers).
#[tauri::command]
fn read_file(path: String) -> Res<Response> {
    Ok(Response::new(fs::read(&path).map_err(err)?))
}

#[tauri::command]
fn load_review(app: AppHandle, file: String) -> Res<Option<String>> {
    let (dir, key) = loose(&app, &file)?;
    reviews::read_review(Path::new(&file), &dir, &key).map_err(err)
}

/// Atomic write; the first write in a workspace also creates `.tandemcad/.gitignore` and `AGENTS.md`.
#[tauri::command]
fn save_review(app: AppHandle, file: String, json: String) -> Res<()> {
    let (dir, key) = loose(&app, &file)?;
    reviews::write_review(Path::new(&file), &dir, &key, &json).map(|_| ()).map_err(err)
}

#[derive(Serialize)]
struct ReviewEntry { rel: String, json: String, #[serde(rename = "modelExists")] model_exists: bool }

/// All reviews in the workspace of `file`, used to re-link comments after a rename.
#[tauri::command]
fn list_reviews(file: String) -> Res<Vec<ReviewEntry>> {
    Ok(reviews::list_reviews(Path::new(&file)).map_err(err)?
        .into_iter().map(|e| ReviewEntry { rel: e.rel, json: e.json, model_exists: e.model_exists }).collect())
}

/// Remove the review stored for `file` (after its comments were moved to a new path).
#[tauri::command]
fn delete_review(app: AppHandle, file: String) -> Res<()> {
    let (dir, key) = loose(&app, &file)?;
    reviews::delete_review(Path::new(&file), &dir, &key).map_err(err)
}

/// Path of the workspace root for `file`, if it sits in one.
#[tauri::command]
fn workspace_root(file: String) -> Option<String> {
    reviews::workspace_root(Path::new(&file)).map(|p| p.to_string_lossy().into_owned())
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

enum Kind { Model, Review }

/// Watch the opened file and its review file (replaces any previous watch). CAD programs
/// write in bursts, so events are debounced: one `file-changed` when the model changed,
/// one `review-changed` when an agent (or the app) wrote the review file.
#[tauri::command]
fn watch_file(app: AppHandle, state: State<Watch>, path: String) -> Res<()> {
    let target = PathBuf::from(&path);
    let dir = target.parent().ok_or("no parent folder")?.to_path_buf();
    let (ldir, key) = loose(&app, &path)?;
    let review = reviews::review_path(&target, &ldir, &key);
    let (tx, rx) = std::sync::mpsc::channel::<Kind>();
    let (t2, r2) = (target.clone(), review.clone());
    let mut w = notify::recommended_watcher(move |ev: notify::Result<notify::Event>| {
        if let Ok(ev) = ev {
            if ev.kind.is_access() { return; }
            if ev.paths.iter().any(|p| p == &t2) { let _ = tx.send(Kind::Model); }
            if ev.paths.iter().any(|p| p == &r2) { let _ = tx.send(Kind::Review); }
        }
    }).map_err(err)?;
    // watch the folder: many programs save by replacing the file
    w.watch(&dir, RecursiveMode::NonRecursive).map_err(err)?;
    if let Some(rd) = review.parent() {
        // only if it exists already; the app calls watch_file again after the first save creates it
        if rd.is_dir() && rd != dir { let _ = w.watch(rd, RecursiveMode::NonRecursive); }
    }
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let (mut model, mut rev) = (matches!(first, Kind::Model), matches!(first, Kind::Review));
            while let Ok(k) = rx.recv_timeout(Duration::from_millis(600)) {
                match k { Kind::Model => model = true, Kind::Review => rev = true }
            }
            if model { let _ = app.emit("file-changed", Changed { path: path.clone() }); }
            if rev { let _ = app.emit("review-changed", Changed { path: path.clone() }); }
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
        .invoke_handler(tauri::generate_handler![read_file, load_review, save_review, list_reviews, delete_review, workspace_root, convert_step, watch_file])
        .run(tauri::generate_context!())
        .expect("error while running TandemCAD");
}
