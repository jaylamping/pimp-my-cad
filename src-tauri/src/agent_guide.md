# TandemCAD reviews: how to read and reply

TandemCAD is a desktop app where a person pins comments on parts of CAD and print files.
The comments live next to the models, in this folder, as plain JSON. You can read and edit them directly.

## Where things are

- One file per reviewed model: `.tandemcad/reviews/<path of the model>.json`
  (for `arm/upper_arm.step` it is `.tandemcad/reviews/arm/upper_arm.step.json`).
- This folder has its own `.gitignore` containing `*`, so reviews are not committed unless the person removes it.

## What a review file holds

- `modelId`: stable id of the model. It survives renames and moves.
- `file`: the model's current path; `paths`: earlier paths.
- `revisions`: sha256 hashes of the model file revisions the app has seen.
- `version`: bumped on every write.
- `deleted`: ids of deleted comments (do not bring them back).
- `comments[]`, each with:
  - Write times as UTC with a `Z` (`2026-11-09T12:00:00Z`); the later `updated` wins when two writers meet.
  - `id`, `part` (node path inside the model), `anchor` (`p` point and `n` normal in the part's local mm),
    `selectors` (extra ways to find the spot again), `severity` (blocker, major, minor, note),
    `text`, `fix` (suggested fix), `status`, `author`, `created`, `updated`, and `rev` (hash of the model
    revision it was written against). If `rev` differs from the sha256 of the model file as it is now, the model changed since;
    check the comment still applies.

## What you may do

- Read every comment whose `status` is `open`.
- Set `status` to `claimed` (and add `claim: { by, at }`) when you start on one.
- Add replies to `thread`: `{ by, at, text }`.
- When you have changed the model, export the new file next to the original, then set `status` to `proposed`
  and add `proposal: { by, at, rev, note }` where `rev` is the sha256 of the file that holds the fix.
- New findings: add a comment with `status: "suggested"` and `source: { agent, model }`. The person accepts or rejects it.
- **Never** set `status` to `fixed` or `wontfix`. Only the person closes a comment.

## How to write safely

The app and you may both write this file. Write a temporary file in the same folder and rename it over the original.
Keep every existing comment, give new comments unique ids, set `updated` (ISO time) on any comment you change,
and increase `version` by one. The app merges by comment id, and the later `updated` wins.
