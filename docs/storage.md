# Local storage stack (phase 1)

`docker compose up --build` runs everything on one machine:

| Service | What | Data |
|---|---|---|
| `app` | web app, API, STEP converter (Python + OpenCascade). MCP runs as `npm run mcp` | none |
| `db` | Postgres 16 | volume `pgdata` |
| `blobs` | S3-compatible server (MinIO by default) | volume `blobdata` |

## Setup

```
cp .env.example .env     # fill POSTGRES_PASSWORD, S3_SECRET_KEY, PIMP_MASTER_KEY, PIMP_ADMIN_TOKEN, CAD_DIR
docker compose up --build
```

`CAD_DIR` is mounted read-only at `/import`. On start the app walks it, hashes every
`.step/.stp/.3mf/.stl/.glb` and stores new content in `blobs`. Re-scan with
`POST /api/import`. Originals are never modified. On Docker Desktop for Windows run it
from WSL2 and keep the volumes on the Linux side. A 0.2 GB folder is fine through a bind mount.

## What lives where

- **Files**: `blobs`, key `workspaces/<ws>/files/<sha256>`; converted `derived/<sha256>/model-<converter version>.glb` and `parts-<v>.json`. Source CAD is **not encrypted** (decision), so Drive previews and SolidWorks keep working on the originals.
- **Postgres**: `workspaces`, `api_tokens` (hashed), `files`, `anchors` (encrypted), `events` (encrypted, append-only, ULID ids). Every row carries `workspace_id`.
- **Encryption**: comments and anchors are AES-256-GCM under a per-workspace data key, wrapped by `PIMP_MASTER_KEY`. **Losing the master key makes comments unreadable; back it up.** The managed phase swaps this wrapping for a KMS call.
- **Anchors**: comment = part id + local `p`/`n` (+ optional `tri`, `bary`), `rev` = SHA-256 of the file it was written against. `PUT /api/files/:sha/anchors` stores the per-revision record (part tree, fingerprints). Re-mapping pins across revisions is not built yet.

## API (bearer token; scopes `read` < `comment` < `admin`)

```
GET  /api/files                        list
POST /api/files?name=&path=            upload bytes (admin)
GET  /api/files/:sha/raw               source bytes (Range supported)
GET  /api/files/:sha/glb | /tree       STEP -> GLB / part tree, converted once and cached
GET  /api/files/:sha/review            folded comments (same ReviewDoc as the viewer)
GET  /api/files/:sha/events?after=     raw events, for export and sync
POST /api/files/:sha/comments          {part, anchor:{p,n}, severity, text, fix?}
PATCH /api/comments/:id                {status?, note?, severity?, text?, fix?}
GET|PUT /api/files/:sha/anchors
POST /api/tokens                       {name, scope, expiresAt?} -> token, shown once (admin)
POST /api/import                       rescan CAD_DIR (admin)
```

Agents never touch Postgres or the bucket. Give each a scoped token and run the MCP
server (`PIMP_API_URL=http://localhost:8080 PIMP_TOKEN=... npm run mcp`; tools: `list_files`,
`get_part_tree`, `list_comments`, `add_comment`, `set_comment_status`).

`src/comments.ts` has `ApiStore` for the viewer; the viewer is not switched over yet
(that comes with the React migration).

## Going managed later

Only configuration changes: `DATABASE_URL` to Supabase/Neon, `S3_ENDPOINT`/`S3_REGION`/keys to Cloudflare R2
(`S3_FORCE_PATH_STYLE=false` is fine). `BlobStore` in `server/api/blobs.ts` is the seam for other backends.

## Check

`npm run typecheck:server`, and with the stack up: `PIMP_API_URL=http://localhost:8080 PIMP_TOKEN=<admin> npm run smoke`.
