// Review comments. The schema and the pure helpers live in reviewdoc.ts; this file keeps the
// browser-only fallback store (used when the app runs in a plain browser, not the desktop app).
import { emptyDoc, upgradeDoc, type CommentStore, type ReviewDoc } from './reviewdoc';
export * from './reviewdoc';

export class LocalStore implements CommentStore {
  async load(file: string): Promise<ReviewDoc> {
    const raw = localStorage.getItem(`review:${file}`);
    return raw ? upgradeDoc(JSON.parse(raw), file) : emptyDoc(file);
  }
  async save(doc: ReviewDoc) { doc.version += 1; localStorage.setItem(`review:${doc.file}`, JSON.stringify(doc)); }
}
