// Where review files live. No Tauri or other crates in here, so `rustc --test` can run it alone.
//
// Inside a workspace (the nearest folder above the model that has `.tandemcad/` or `.git`):
//   <root>/.tandemcad/reviews/<path of the model relative to root>.json
// A model outside any workspace keeps its review in the app's data folder, keyed by a hash of its path.
// Older builds wrote `<model>.tandem.json` beside the model; that is still read when nothing newer exists.
use std::{
    fs, io,
    path::{Path, PathBuf},
};

pub const DIR: &str = ".tandemcad";

/// Nearest folder above `file` that has `.tandemcad/` or `.git`.
pub fn workspace_root(file: &Path) -> Option<PathBuf> {
    file.parent()?.ancestors().find(|d| d.join(DIR).is_dir() || d.join(".git").exists()).map(Path::to_path_buf)
}

/// `a/b/c.step` style path of `file` below `root`, always with forward slashes.
pub fn rel_path(root: &Path, file: &Path) -> Option<String> {
    let rel = file.strip_prefix(root).ok()?;
    Some(rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"))
}

/// Where the review for `file` is stored. `loose_dir` and `loose_key` are used outside any workspace.
pub fn review_path(file: &Path, loose_dir: &Path, loose_key: &str) -> PathBuf {
    match workspace_root(file).and_then(|r| rel_path(&r, file).map(|rel| (r, rel))) {
        Some((root, rel)) => root.join(DIR).join("reviews").join(format!("{rel}.json")),
        None => loose_dir.join(format!("{loose_key}.json")),
    }
}

fn legacy_path(file: &Path) -> PathBuf { PathBuf::from(format!("{}.tandem.json", file.display())) }

pub fn read_review(file: &Path, loose_dir: &Path, loose_key: &str) -> io::Result<Option<String>> {
    // A model that was outside any workspace and later gained one still finds its old review in the
    // app data folder; the next save writes it into the workspace.
    for p in [review_path(file, loose_dir, loose_key), loose_dir.join(format!("{loose_key}.json")), legacy_path(file)] {
        match fs::read_to_string(&p) {
            Ok(s) => return Ok(Some(s)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(None)
}

const AGENT_GUIDE: &str = include_str!("agent_guide.md");

/// Atomic write (temp file, then rename). The first time a workspace gets a `.tandemcad/` folder it also
/// gets a `.gitignore` containing `*` (reviews are not committed unless you remove it) and `AGENTS.md`.
pub fn write_review(file: &Path, loose_dir: &Path, loose_key: &str, json: &str) -> io::Result<PathBuf> {
    let p = review_path(file, loose_dir, loose_key);
    if let Some(root) = workspace_root(file) {
        let dir = root.join(DIR);
        if !dir.exists() {
            fs::create_dir_all(&dir)?;
            fs::write(dir.join(".gitignore"), "*\n")?;
            fs::write(dir.join("AGENTS.md"), AGENT_GUIDE)?;
        }
    }
    if let Some(parent) = p.parent() { fs::create_dir_all(parent)?; }
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, json)?;
    fs::rename(&tmp, &p)?;
    Ok(p)
}

pub fn delete_review(file: &Path, loose_dir: &Path, loose_key: &str) -> io::Result<()> {
    match fs::remove_file(review_path(file, loose_dir, loose_key)) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

pub struct Entry { pub rel: String, pub json: String, pub model_exists: bool }

/// Every review in the workspace of `file`, with whether the model it mirrors still exists.
pub fn list_reviews(file: &Path) -> io::Result<Vec<Entry>> {
    let Some(root) = workspace_root(file) else { return Ok(vec![]) };
    let base = root.join(DIR).join("reviews");
    let mut out = vec![];
    let mut stack = vec![base.clone()];
    while let Some(d) = stack.pop() {
        let rd = match fs::read_dir(&d) {
            Ok(r) => r,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        for e in rd {
            let p = e?.path();
            if p.is_dir() { stack.push(p); continue; }
            if p.extension().and_then(|x| x.to_str()) != Some("json") { continue; }
            let rel_json = rel_path(&base, &p).unwrap_or_default();
            let rel = rel_json.trim_end_matches(".json").to_string();
            let json = fs::read_to_string(&p)?; // an unreadable review must not hide a relink candidate
            let model_exists = root.join(&rel).exists();
            out.push(Entry { rel, json, model_exists });
        }
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tandemcad-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn workspace_review_mirrors_model_path_and_creates_guide_and_ignore() {
        let root = tmp("ws");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("arm")).unwrap();
        let model = root.join("arm").join("upper_arm.step");
        fs::write(&model, "x").unwrap();
        let loose = tmp("loose");
        let p = write_review(&model, &loose, "k", "{\"a\":1}").unwrap();
        assert_eq!(p, root.join(".tandemcad/reviews/arm/upper_arm.step.json"));
        assert_eq!(fs::read_to_string(root.join(".tandemcad/.gitignore")).unwrap(), "*\n");
        assert!(root.join(".tandemcad/AGENTS.md").exists());
        assert_eq!(read_review(&model, &loose, "k").unwrap().as_deref(), Some("{\"a\":1}"));
        assert!(!p.with_extension("json.tmp").exists());
    }

    #[test]
    fn existing_tandemcad_folder_is_not_rewritten() {
        let root = tmp("keep");
        fs::create_dir_all(root.join(".tandemcad")).unwrap();
        fs::write(root.join(".tandemcad/.gitignore"), "custom\n").unwrap();
        let model = root.join("a.stl");
        write_review(&model, &tmp("l1"), "k", "{}").unwrap();
        assert_eq!(fs::read_to_string(root.join(".tandemcad/.gitignore")).unwrap(), "custom\n");
        assert!(!root.join(".tandemcad/AGENTS.md").exists());
    }

    #[test]
    fn loose_file_uses_app_data_folder() {
        let dir = tmp("nowhere");
        let model = dir.join("part.3mf");
        let loose = tmp("loose2");
        let p = write_review(&model, &loose, "abc", "{}").unwrap();
        assert_eq!(p, loose.join("abc.json"));
        assert!(!dir.join(".tandemcad").exists());
    }

    #[test]
    fn legacy_file_beside_model_is_read_when_nothing_newer() {
        let root = tmp("legacy");
        fs::create_dir_all(root.join(".git")).unwrap();
        let model = root.join("a.stl");
        fs::write(root.join("a.stl.tandem.json"), "{\"old\":true}").unwrap();
        let l = tmp("l3");
        assert_eq!(read_review(&model, &l, "k").unwrap().as_deref(), Some("{\"old\":true}"));
        write_review(&model, &l, "k", "{\"new\":true}").unwrap();
        assert_eq!(read_review(&model, &l, "k").unwrap().as_deref(), Some("{\"new\":true}"));
    }

    #[test]
    fn list_reports_missing_models_and_delete_removes() {
        let root = tmp("list");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::create_dir_all(root.join("sub")).unwrap();
        let a = root.join("a.stl");
        let b = root.join("sub").join("b.stl");
        fs::write(&a, "x").unwrap();
        let l = tmp("l6");
        write_review(&a, &l, "k", "{\"n\":\"a\"}").unwrap();
        write_review(&b, &l, "k", "{\"n\":\"b\"}").unwrap(); // b.stl does not exist
        let es = list_reviews(&a).unwrap();
        assert_eq!(es.len(), 2);
        assert_eq!((es[0].rel.as_str(), es[0].model_exists), ("a.stl", true));
        assert_eq!((es[1].rel.as_str(), es[1].model_exists), ("sub/b.stl", false));
        delete_review(&b, &l, "k").unwrap();
        assert_eq!(list_reviews(&a).unwrap().len(), 1);
    }
}
