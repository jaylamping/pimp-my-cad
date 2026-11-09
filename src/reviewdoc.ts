// Review documents (schema 2): the contract between the app and any agent.
// One file per model, at `.tandemcad/reviews/<path of the model>.json` in the
// workspace root. This module is pure (no DOM, no Tauri) so it can be tested
// with plain node.
export type Severity = 'blocker' | 'major' | 'minor' | 'note';
// Agents may set claimed / proposed / suggested; only a person sets fixed / wontfix.
export type Status = 'open' | 'claimed' | 'proposed' | 'suggested' | 'fixed' | 'wontfix';

/** Redundant ways to find a spot again on a later revision (used for re-anchoring). */
export interface Selectors {
  partName?: string;
  bbox?: [number, number, number, number, number, number]; // part-local min xyz, max xyz (mm)
  centroid?: [number, number, number];
  fingerprint?: string;                                     // short geometry summary, see fingerprint()
}

export interface ThreadEntry { by: string; at: string; text: string; rev?: string }

export interface ReviewComment {
  id: string;
  part: string;              // node path inside the file, e.g. "upper_arm/clamp_solid"
  anchor: { p: [number, number, number]; n: [number, number, number] }; // part-local mm
  selectors?: Selectors;
  severity: Severity;
  text: string;
  fix?: string;              // suggested fix, optional
  status: Status;
  author: string;
  created: string;           // ISO time
  updated?: string;          // ISO time of the last change; the later one wins when two writers meet
  rev: string;               // sha256 of the file this was written against
  resolved?: { by: string; at: string; rev?: string; note?: string };
  claim?: { by: string; at: string };
  thread?: ThreadEntry[];
  proposal?: { by: string; at: string; rev: string; note?: string };
  source?: { agent: string; model?: string; run?: string }; // set on comments that came from an agent review
}

export interface RevisionRecord { sha: string; size?: number; seen: string }

export interface ReviewDoc {
  schema: 2;
  modelId: string;           // stable id for this model, survives renames and moves
  file: string;              // current path relative to the workspace root (or the bare name)
  paths?: string[];          // earlier paths, oldest first
  revisions: RevisionRecord[];
  version: number;           // bumped on every write; a writer holding an older one must merge
  deleted?: string[];        // ids of deleted comments, so a merge doesn't bring them back
  comments: ReviewComment[];
}

export interface CommentStore {
  load(file: string, sha?: string, size?: number): Promise<ReviewDoc>;
  save(doc: ReviewDoc): Promise<void>;
}

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export function emptyDoc(file: string): ReviewDoc {
  return { schema: 2, modelId: 'm' + newId(), file, revisions: [], version: 0, comments: [] };
}

const SEVERITIES: Severity[] = ['blocker', 'major', 'minor', 'note'];
const STATUSES: Status[] = ['open', 'claimed', 'proposed', 'suggested', 'fixed', 'wontfix'];
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d);

/** Make one comment safe to render: known severity/status, strings where strings are expected. */
function cleanComment(c: any): ReviewComment | null {
  if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !c.id) return null;
  const v = (x: unknown) => Array.isArray(x) && x.length === 3 && x.every((n) => typeof n === 'number' && isFinite(n));
  const p = c.anchor && v(c.anchor.p) ? c.anchor.p : [0, 0, 0];
  const n = c.anchor && v(c.anchor.n) ? c.anchor.n : [0, 0, 1];
  return {
    ...c,
    part: str(c.part),
    anchor: { p, n },
    severity: SEVERITIES.includes(c.severity) ? c.severity : 'note',
    status: STATUSES.includes(c.status) ? c.status : 'open',
    text: str(c.text), author: str(c.author, 'unknown'),
    created: str(c.created, new Date(0).toISOString()), rev: str(c.rev),
  };
}

/** Accept schema 1 (`{schema:1,file,comments}`) or 2 and return a validated schema 2 doc. */
export function upgradeDoc(raw: any, file: string): ReviewDoc {
  const clean = (list: unknown) => (Array.isArray(list) ? list : []).map(cleanComment).filter((c): c is ReviewComment => !!c);
  if (raw && raw.schema === 2) {
    return {
      ...raw,
      modelId: str(raw.modelId) || 'm' + newId(),
      file: str(raw.file, file),
      revisions: (Array.isArray(raw.revisions) ? raw.revisions : []).filter((r: any) => r && typeof r.sha === 'string'),
      version: Number.isFinite(raw.version) ? raw.version : 0,
      deleted: Array.isArray(raw.deleted) ? raw.deleted.filter((x: unknown) => typeof x === 'string') : undefined,
      comments: clean(raw.comments),
    };
  }
  const comments: ReviewComment[] = clean(raw?.comments);
  const seen = new Map<string, RevisionRecord>();
  for (const c of comments) if (c.rev && !seen.has(c.rev)) seen.set(c.rev, { sha: c.rev, seen: c.created });
  return {
    schema: 2, modelId: 'm' + newId(), file: raw?.file ?? file,
    revisions: [...seen.values()], version: 0, comments,
  };
}

/** Record that `sha` is a revision of this model (once). */
export function noteRevision(doc: ReviewDoc, sha: string, size?: number, now = new Date().toISOString()): boolean {
  if (!sha || sha === 'unhashed') return false;
  const r = doc.revisions.find((x) => x.sha === sha);
  if (r) { if (size != null && r.size == null) { r.size = size; return true; } return false; }
  doc.revisions.push({ sha, size, seen: now });
  return true;
}

/** Point the doc at the model's current path, remembering where it was. */
export function notePath(doc: ReviewDoc, file: string): boolean {
  if (doc.file === file) return false;
  if (doc.file) doc.paths = [...(doc.paths ?? []), doc.file];
  doc.file = file;
  return true;
}

// Compare as times, not strings: offsets and missing milliseconds sort wrong as text.
const time = (t: string) => { const n = Date.parse(t); return Number.isNaN(n) ? 0 : n; };
/** Agents can claim/propose/suggest; those still need a person's decision, so only fixed/wontfix are closed. */
export const isClosed = (c: Pick<ReviewComment, 'status'>) => c.status === 'fixed' || c.status === 'wontfix';

const stamp = (c: ReviewComment) => time(c.updated ?? c.created);

/** Union of two writers' views of the same model. The later `updated` wins per comment; ties keep `mine`. */
export function mergeDocs(disk: ReviewDoc, mine: ReviewDoc): ReviewDoc {
  const deleted = [...new Set([...(disk.deleted ?? []), ...(mine.deleted ?? [])])];
  const gone = new Set(deleted);
  const byId = new Map<string, ReviewComment>();
  for (const c of disk.comments) if (!gone.has(c.id)) byId.set(c.id, c);
  for (const c of mine.comments) {
    if (gone.has(c.id)) continue;
    const d = byId.get(c.id);
    if (!d || stamp(c) >= stamp(d)) byId.set(c.id, c);
  }
  const revisions = [...disk.revisions];
  for (const r of mine.revisions) if (!revisions.some((x) => x.sha === r.sha)) revisions.push(r);
  const paths = [...new Set([...(disk.paths ?? []), ...(mine.paths ?? [])])];
  return {
    ...mine,
    modelId: disk.modelId || mine.modelId,
    paths: paths.length ? paths : undefined,
    revisions,
    deleted: deleted.length ? deleted : undefined,
    comments: [...byId.values()].sort((a, b) => time(a.created) - time(b.created)),
  };
}

/** Does this doc know the given revision hash? */
export function knowsRevision(doc: ReviewDoc, sha: string): boolean {
  return doc.revisions.some((r) => r.sha === sha) || doc.comments.some((c) => c.rev === sha);
}

/**
 * A model went missing at its old path and a file with a known hash appeared at a new one:
 * pick the one review doc that can be re-linked. Ambiguous (0 or 2+ matches) returns null.
 */
export function pickRelink<T extends { doc: ReviewDoc; modelExists: boolean }>(entries: T[], sha: string): T | null {
  if (!sha || sha === 'unhashed') return null;
  const hits = entries.filter((e) => !e.modelExists && knowsRevision(e.doc, sha));
  return hits.length === 1 ? hits[0] : null;
}

/** Short geometry summary of a part, stable across re-exports of the same shape. Not a security hash. */
export function fingerprint(vertexCount: number, triangleCount: number, size: [number, number, number]): string {
  return `v1:${vertexCount}:${triangleCount}:${size.map((s) => Math.round(s * 10) / 10).join('x')}`;
}
