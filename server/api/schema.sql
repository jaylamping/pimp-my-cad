-- Applied at startup; idempotent. Every row carries workspace_id from day one.
create table if not exists schema_version (v int primary key);

create table if not exists workspaces (
  id text primary key,
  name text not null,
  owner_id text not null,
  wrapped_key bytea not null,          -- workspace data key, wrapped by the master key
  created_at timestamptz not null default now()
);

create table if not exists api_tokens (
  token_hash text primary key,         -- sha256 of the token; the token itself is never stored
  workspace_id text not null references workspaces(id),
  name text not null,
  scope text not null check (scope in ('read','comment','admin')),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz
);

-- one row per distinct file content in a workspace
create table if not exists files (
  workspace_id text not null references workspaces(id),
  sha256 text not null,
  name text not null,                  -- last name it was seen under
  path text,                           -- path inside an import folder, if imported
  size bigint not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, sha256)
);
create index if not exists files_path on files (workspace_id, path);

-- small per-revision anchor record (part tree, fingerprints, frame); encrypted
create table if not exists anchors (
  workspace_id text not null,
  file_sha text not null,
  body bytea not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, file_sha)
);

-- append-only comment events; payload is encrypted JSON. ULID ids sort by time.
create table if not exists events (
  id text primary key,
  workspace_id text not null references workspaces(id),
  file_sha text not null,
  comment_id text not null,            -- id of the comment.add event this belongs to
  type text not null,                  -- comment.add | comment.edit | comment.status
  actor text not null,
  payload bytea not null,
  created_at timestamptz not null default now()
);
create index if not exists events_file on events (workspace_id, file_sha, id);
