// Everything the API reads from the environment. Moving from the local stack to
// managed Postgres + Cloudflare R2 only changes DATABASE_URL and the S3_* values.
const env = process.env;

export const config = {
  port: Number(env.PORT || 8080),
  databaseUrl: env.DATABASE_URL || 'postgres://pimp:pimp@localhost:5432/pimp',
  s3: {
    endpoint: env.S3_ENDPOINT || 'http://localhost:9000',
    region: env.S3_REGION || 'auto',
    bucket: env.S3_BUCKET || 'pimp-my-cad',
    accessKeyId: env.S3_ACCESS_KEY || 'pimpminio',
    secretAccessKey: env.S3_SECRET_KEY || 'pimpminio-secret',
    forcePathStyle: env.S3_FORCE_PATH_STYLE !== 'false', // MinIO needs it; R2 is fine with it too
  },
  // 32 random bytes, base64. Wraps each workspace's data key. Local stand-in for a KMS.
  masterKey: env.PIMP_MASTER_KEY || '',
  // bootstrap admin token; stored hashed. Agents get their own scoped tokens.
  adminToken: env.PIMP_ADMIN_TOKEN || '',
  importDir: env.IMPORT_DIR || '',        // read-only CAD folder to import by hash
  distDir: env.DIST_DIR || 'dist',        // built web app
  python: env.PIMP_PYTHON || 'python3',
};
