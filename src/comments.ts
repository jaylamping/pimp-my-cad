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
