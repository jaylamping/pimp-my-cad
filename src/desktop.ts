// Desktop (Tauri) bridge. Everything here is a no-op in a plain browser.
// Comments live in `.tandemcad/reviews/<model path>.json` at the workspace root
// (the nearest folder with `.tandemcad/` or `.git`), so agents and git can read
// them without going through the app. A model outside any workspace keeps its
// review in the app's data folder.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open as pickDialog } from '@tauri-apps/plugin-dialog';
import { emptyDoc, mergeDocs, noteRevision, notePath, pickRelink, upgradeDoc, type CommentStore, type ReviewDoc } from './reviewdoc';

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const fileName = (p: string) => p.split(/[\\/]/).pop()!;

type ReviewEntry = { rel: string; json: string; modelExists: boolean };

export class ReviewStore implements CommentStore {
  /** Open the review for `file`; carries comments over when the file was renamed or moved. */
  async load(file: string, sha?: string, size?: number): Promise<ReviewDoc> {
    const root = await invoke<string | null>('workspace_root', { file });
    const rel = root ? relTo(root, file) : fileName(file);
    const raw = await invoke<string | null>('load_review', { file });
    let doc: ReviewDoc;
    if (raw) {
      doc = upgradeDoc(JSON.parse(raw), rel);
    } else {
      doc = emptyDoc(rel);
      const found = root && sha ? await this.relink(file, root, sha) : null;
      if (found) doc = found;
    }
    // keep `file` in step with where the model is now, and remember the revision
    const changed = [notePath(doc, rel), sha ? noteRevision(doc, sha, size) : false];
    if (changed.some(Boolean) && (raw || doc.comments.length)) await this.save(doc);
    return doc;
  }

  /** A review whose model is gone, and that knows this file's hash, is this file's earlier life. */
  private async relink(file: string, root: string, sha: string): Promise<ReviewDoc | null> {
    const entries = await invoke<ReviewEntry[]>('list_reviews', { file });
    const parsed = entries.map((e) => ({ e, doc: upgradeDoc(JSON.parse(e.json), e.rel), modelExists: e.modelExists }));
    const hit = pickRelink(parsed, sha);
    if (!hit) return null;
    await invoke('delete_review', { file: joinPath(root, hit.e.rel) });
    return hit.doc;
  }

  async save(doc: ReviewDoc) {
    const file = currentPath;
    // another writer (an agent) may have changed the file since we loaded it
    const raw = await invoke<string | null>('load_review', { file });
    const disk = raw ? upgradeDoc(JSON.parse(raw), doc.file) : null;
    const next = disk && disk.version !== doc.version ? mergeDocs(disk, doc) : doc;
    next.version = Math.max(disk?.version ?? 0, doc.version) + 1;
    await invoke('save_review', { file, json: JSON.stringify(next, null, 2) + '\n' });
    if (next !== doc) Object.assign(doc, next);
    else doc.version = next.version;
  }

  /** The doc as it is on disk now (null if there is none yet). */
  async peek(file: string): Promise<ReviewDoc | null> {
    const raw = await invoke<string | null>('load_review', { file });
    return raw ? upgradeDoc(JSON.parse(raw), fileName(file)) : null;
  }
}

const relTo = (root: string, file: string) => {
  const n = (p: string) => p.replace(/\\/g, '/');
  const r = n(root).replace(/\/$/, '') + '/';
  return n(file).startsWith(r) ? n(file).slice(r.length) : fileName(file);
};
const joinPath = (root: string, rel: string) => root.replace(/[\\/]$/, '') + (root.includes('\\') ? '\\' : '/') + (root.includes('\\') ? rel.replace(/\//g, '\\') : rel);

let currentPath = '';
export const setCurrentPath = (p: string) => { currentPath = p; };

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
