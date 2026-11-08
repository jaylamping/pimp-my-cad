// Comments are append-only events. This folds them into the same ReviewDoc shape
// the viewer already uses (src/comments.ts), so UI and agents see one format.
export type Severity = 'blocker' | 'major' | 'minor' | 'note';
export type Status = 'open' | 'fixed' | 'wontfix';

export interface Anchor {
  p: [number, number, number];
  n: [number, number, number];
  tri?: number;                 // triangle index on this revision
  bary?: [number, number, number];
}
export interface ReviewComment {
  id: string; part: string; anchor: Anchor; severity: Severity; text: string; fix?: string;
  status: Status; author: string; created: string; rev: string;
  resolved?: { by: string; at: string; rev?: string; note?: string };
}
export interface ReviewDoc { schema: 1; file: string; comments: ReviewComment[] }

export interface EventRow { id: string; type: string; actor: string; comment_id: string; created_at: Date; payload: Record<string, unknown> }

export function fold(file: string, events: EventRow[]): ReviewDoc {
  const by = new Map<string, ReviewComment>();
  for (const e of events) { // events arrive in ULID order
    const p = e.payload as Record<string, any>;
    if (e.type === 'comment.add') {
      by.set(e.comment_id, {
        id: e.comment_id, part: p.part, anchor: p.anchor, severity: p.severity, text: p.text,
        fix: p.fix, status: 'open', author: e.actor, created: p.created ?? e.created_at.toISOString(), rev: p.rev,
      });
      continue;
    }
    const c = by.get(e.comment_id);
    if (!c) continue;
    if (e.type === 'comment.edit') {
      for (const k of ['severity', 'text', 'fix'] as const) if (p[k] !== undefined) (c as any)[k] = p[k];
    } else if (e.type === 'comment.status') {
      c.status = p.status;
      if (p.status === 'open') delete c.resolved;
      else c.resolved = { by: e.actor, at: e.created_at.toISOString(), rev: p.rev, note: p.note };
    }
  }
  return { schema: 1, file, comments: [...by.values()] };
}
