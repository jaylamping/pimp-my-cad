import test from 'node:test';
import assert from 'node:assert/strict';
import { upgradeDoc, mergeDocs, pickRelink, noteRevision, notePath, emptyDoc } from '../src/reviewdoc.ts';

const c = (id, updated, extra = {}) => ({ id, part: 'p', anchor: { p: [0, 0, 0], n: [0, 0, 1] }, severity: 'major', text: id, status: 'open', author: 'a', created: '2026-01-01T00:00:00Z', updated, rev: 'r1', ...extra });
const doc = (comments, extra = {}) => ({ ...emptyDoc('a.stl'), comments, ...extra });

test('upgrade v1 keeps comments and learns revisions', () => {
  const d = upgradeDoc({ schema: 1, file: 'a.stl', comments: [c('x', undefined)] }, 'a.stl');
  assert.equal(d.schema, 2);
  assert.equal(d.revisions[0].sha, 'r1');
  assert.equal(d.comments.length, 1);
});

test('merge: later updated wins, union by id, tombstones win', () => {
  const disk = doc([c('a', '2026-01-02T00:00:00Z', { status: 'claimed' }), c('b', '2026-01-01T00:00:00Z')]);
  const mine = doc([c('a', '2026-01-01T00:00:00Z'), c('c', '2026-01-03T00:00:00Z')], { deleted: ['b'] });
  const m = mergeDocs(disk, mine);
  assert.deepEqual(m.comments.map((x) => x.id), ['a', 'c']);
  assert.equal(m.comments[0].status, 'claimed');
  assert.deepEqual(m.deleted, ['b']);
});

test('relink only when exactly one orphan knows the hash', () => {
  const known = { doc: doc([], { revisions: [{ sha: 's', seen: 'x' }] }), modelExists: false };
  const other = { doc: doc([]), modelExists: false };
  assert.equal(pickRelink([known, other], 's'), known);
  assert.equal(pickRelink([known, { ...known }], 's'), null);
  assert.equal(pickRelink([{ ...known, modelExists: true }], 's'), null);
});

test('noteRevision and notePath are idempotent and remember history', () => {
  const d = doc([]);
  assert.equal(noteRevision(d, 's', 5), true);
  assert.equal(noteRevision(d, 's', 5), false);
  assert.equal(notePath(d, 'b.stl'), true);
  assert.deepEqual(d.paths, ['a.stl']);
  assert.equal(notePath(d, 'b.stl'), false);
});
