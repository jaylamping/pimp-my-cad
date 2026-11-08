// Review comments. One JSON document per reviewed file, shaped so a design
// thread can read it straight from the repo:
//   reviews/<repo path of the reviewed file>.json
export type Severity = 'blocker' | 'major' | 'minor' | 'note';
export type Status = 'open' | 'fixed' | 'wontfix';

export interface ReviewComment {
  id: string;
  part: string;              // node path inside the file, e.g. "upper_arm/clamp_solid"
  anchor: { p: [number, number, number]; n: [number, number, number] }; // part-local mm
  severity: Severity;
  text: string;
  fix?: string;              // suggested fix, optional
  status: Status;
  author: string;
  created: string;           // ISO time
  rev: string;               // sha256 of the file this was written against
  resolved?: { by: string; at: string; rev?: string; note?: string };
}

export interface ReviewDoc {
  schema: 1;
  file: string;              // repo path (or plain name for a local file)
  comments: ReviewComment[];
}

export interface CommentStore {
  load(file: string): Promise<ReviewDoc>;
  save(doc: ReviewDoc): Promise<void>;
}

export class LocalStore implements CommentStore {
  async load(file: string): Promise<ReviewDoc> {
    const raw = localStorage.getItem(`review:${file}`);
    return raw ? JSON.parse(raw) : { schema: 1, file, comments: [] };
  }
  async save(doc: ReviewDoc) { localStorage.setItem(`review:${doc.file}`, JSON.stringify(doc)); }
}

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Talks to the pimp-my-cad API (docker compose stack). The token is the bootstrap
// admin token or a scoped one; set it once with localStorage.setItem('pimp-token', ...).
// The API stores append-only events, so save() diffs against the last load and
// sends only what changed.
export class ApiStore implements CommentStore {
  private seen = new Map<string, ReviewDoc>();
  constructor(private resolveSha: (file: string) => string | undefined, private base = '') {}
  private async call(path: string, init: RequestInit = {}) {
    const r = await fetch(this.base + path, {
      ...init, headers: { authorization: `Bearer ${localStorage.getItem('pimp-token') ?? ''}`, 'content-type': 'application/json' },
    });
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
    return r.json();
  }
  async load(file: string): Promise<ReviewDoc> {
    const sha = this.resolveSha(file);
    const doc: ReviewDoc = sha ? await this.call(`/api/files/${sha}/review`) : { schema: 1, file, comments: [] };
    this.seen.set(file, structuredClone(doc));
    return doc;
  }
  async save(doc: ReviewDoc) {
    const sha = this.resolveSha(doc.file);
    if (!sha) throw new Error(`${doc.file} is not in the store`);
    const old = new Map((this.seen.get(doc.file)?.comments ?? []).map((c) => [c.id, c]));
    for (const c of doc.comments) {
      const prev = old.get(c.id);
      if (!prev) {
        const { id } = await this.call(`/api/files/${sha}/comments`, {
          method: 'POST', body: JSON.stringify({ part: c.part, anchor: c.anchor, severity: c.severity, text: c.text, fix: c.fix }),
        });
        c.id = id; // the server owns ids
      } else if (prev.status !== c.status || prev.severity !== c.severity || prev.text !== c.text || prev.fix !== c.fix) {
        await this.call(`/api/comments/${c.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: c.status !== prev.status ? c.status : undefined, note: c.resolved?.note, severity: c.severity, text: c.text, fix: c.fix }),
        });
      }
    }
    this.seen.set(doc.file, structuredClone(doc));
  }
}
