// Desktop (Tauri) bridge. Everything here is a no-op in a plain browser.
// Comments live in `<file>.pimp.json` next to the opened file, so agents and
// git can read them without going through the app.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open as pickDialog } from '@tauri-apps/plugin-dialog';
import type { CommentStore, ReviewDoc } from './comments';

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const fileName = (p: string) => p.split(/[\\/]/).pop()!;

export class SidecarStore implements CommentStore {
  async load(file: string): Promise<ReviewDoc> {
    const raw = await invoke<string | null>('load_sidecar', { file });
    return raw ? JSON.parse(raw) : { schema: 1, file: fileName(file), comments: [] };
  }
  async save(doc: ReviewDoc & { path?: string }) {
    // doc.file is the bare name (keeps the JSON portable); the path comes from the open file
    await invoke('save_sidecar', { file: currentPath, json: JSON.stringify(doc, null, 2) });
  }
}

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

export const onDropPaths = (cb: (path: string) => void) =>
  getCurrentWebview().onDragDropEvent((e) => {
    if (e.payload.type === 'drop' && e.payload.paths[0]) cb(e.payload.paths[0]);
  });
