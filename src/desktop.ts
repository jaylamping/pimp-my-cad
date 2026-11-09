// Desktop (Tauri) bridge. Everything here is a no-op in a plain browser.
// Comments live in `.tandemcad/reviews/<model path>.json` at the workspace root
// (the nearest folder with `.tandemcad/` or `.git`), so agents can read them
// without going through the app (the folder is gitignored by default). A model outside any workspace keeps its
// review in the app's data folder.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open as pickDialog } from '@tauri-apps/plugin-dialog';
import { emptyDoc, mergeDocs, noteRevision, notePath, pickRelink, upgradeDoc, type CommentStore, type ReviewDoc } from './reviewdoc';

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const fileName = (p: string) => p.split(/[\\/]/).pop()!;

type ReviewEntry = { rel: string; json: string; modelExists: boolean };

// Each doc remembers which model path it belongs to, so a slow open can never save into another model's review.
const docPath = new WeakMap<ReviewDoc, string>();

const baseNoExt = (rel: string) => fileName(rel).replace(/\.[^.]+$/, '');

export class ReviewStore implements CommentStore {
  /** Open the review for `file`; carries comments over when the file was renamed or moved. */
  async load(file: string, sha?: string, size?: number): Promise<ReviewDoc> {
    const root = await invoke<string | null>('workspace_root', { file });
    const rel = root ? relTo(root, file) : fileName(file);
    const raw = await invoke<string | null>('load_review', { file });
    let doc: ReviewDoc;
    let from: string | null = null; // review file of an earlier life of this model, removed after the new one is saved
    if (raw) {
      doc = upgradeDoc(JSON.parse(raw), rel);
    } else {
      doc = emptyDoc(rel);
      const found = root && sha ? await this.relink(root, file, sha) : null;
      if (found) { doc = found.doc; from = found.from; }
    }
    docPath.set(doc, file);
    // keep `file` in step with where the model is now, and remember the revision
    const moved = notePath(doc, rel);
    if (from && moved) rewriteStlParts(doc, doc.paths?.[doc.paths.length - 1] ?? '', rel);
    const changed = [moved, sha ? noteRevision(doc, sha, size) : false];
    if (from || (changed.some(Boolean) && (raw || doc.comments.length || doc.deleted?.length))) await this.save(doc);
    if (from) await invoke('delete_review', { file: joinPath(root!, from) }); // only after the new copy is on disk
    return doc;
  }

  /** A review whose model is gone, and that knows this file's hash, is this file's earlier life. */
  private async relink(root: string, file: string, sha: string): Promise<{ doc: ReviewDoc; from: string } | null> {
    const entries = await invoke<ReviewEntry[]>('list_reviews', { file });
    const parsed: { e: ReviewEntry; doc: ReviewDoc; modelExists: boolean }[] = [];
    for (const e of entries) {
      try { parsed.push({ e, doc: upgradeDoc(JSON.parse(e.json), e.rel), modelExists: e.modelExists }); }
      catch (err) { console.warn(`skipping unreadable review ${e.rel}:`, err); }
    }
    const hit = pickRelink(parsed, sha);
    return hit ? { doc: hit.doc, from: hit.e.rel } : null;
  }

  async save(doc: ReviewDoc) {
    const file = docPath.get(doc);
    if (!file) throw new Error('review doc was not opened through this store');
    // another writer (an agent) may have changed the file since we loaded it; versions can tie while
    // contents differ, so always merge by comment id
    const raw = await invoke<string | null>('load_review', { file });
    const disk = raw ? upgradeDoc(JSON.parse(raw), doc.file) : null;
    const next = disk ? mergeDocs(disk, doc) : doc;
    next.version = Math.max(disk?.version ?? 0, doc.version) + 1;
    await invoke('save_review', { file, json: JSON.stringify(next, null, 2) + '\n' });
    if (next !== doc) Object.assign(doc, next);
  }

  /** The doc as it is on disk now (null if there is none yet). */
  async peek(file: string): Promise<ReviewDoc | null> {
    const raw = await invoke<string | null>('load_review', { file });
    return raw ? upgradeDoc(JSON.parse(raw), fileName(file)) : null;
  }
}

/** STL parts are named after the file, so a renamed STL needs its comments' part paths renamed too. */
function rewriteStlParts(doc: ReviewDoc, oldRel: string, newRel: string) {
  if (!/\.stl$/i.test(oldRel) || !/\.stl$/i.test(newRel)) return;
  const [o, n] = [baseNoExt(oldRel), baseNoExt(newRel)];
  if (o === n) return;
  for (const c of doc.comments) if (c.part === o) c.part = n;
}

const relTo = (root: string, file: string) => {
  const n = (p: string) => p.replace(/\\/g, '/');
  const r = n(root).replace(/\/$/, '') + '/';
  return n(file).startsWith(r) ? n(file).slice(r.length) : fileName(file);
};
const joinPath = (root: string, rel: string) => root.replace(/[\\/]$/, '') + (root.includes('\\') ? '\\' : '/') + (root.includes('\\') ? rel.replace(/\//g, '\\') : rel);

export async function pickFile(): Promise<string | null> {
  const r = await pickDialog({
    multiple: false,
    filters: [{ name: 'CAD / print files', extensions: ['step', 'stp', '3mf', 'stl', 'glb', 'gltf'] }],
  });
  return typeof r === 'string' ? r : null;
}

export const readFile = async (path: string) => invoke<ArrayBuffer>('read_file', { path });
export const convertStep = async (path: string) => invoke<ArrayBuffer>('convert_step', { path });

/** Re-open the file when the CAD program saves it. */
export async function watch(path: string) { await invoke('watch_file', { path }); }
export const onFileChanged = (cb: (path: string) => void) =>
  listen<{ path: string }>('file-changed', (e) => cb(e.payload.path));
/** An agent (or another window) wrote the review file. */
export const onReviewChanged = (cb: (path: string) => void) =>
  listen<{ path: string }>('review-changed', (e) => cb(e.payload.path));

export const onDropPaths = (cb: (path: string) => void) =>
  getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type === 'drop' && e.payload.paths[0]) cb(e.payload.paths[0]);
  });
