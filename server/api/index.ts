import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApp } from './app';
import { S3BlobStore } from './blobs';
import { config } from './config';
import { Vault } from './crypto';
import { connect, DEFAULT_WS } from './db';
import { importDir } from './import';

if (!config.masterKey) throw new Error('Set PIMP_MASTER_KEY (openssl rand -base64 32)');
const vault = new Vault(config.masterKey);
const db = await connect(vault);
const blobs = new S3BlobStore();
await blobs.init();
const deps = { db, blobs, vault };

const rescan = () => importDir(deps, DEFAULT_WS, config.importDir);
const app = createApp(deps, config.importDir ? rescan : undefined);
app.use('/*', serveStatic({ root: config.distDir }));
app.get('*', serveStatic({ path: `${config.distDir}/index.html` }));

serve({ fetch: app.fetch, port: config.port }, (i) => console.log(`pimp-my-cad API on :${i.port}`));

if (config.importDir) {
  rescan()
    .then((r) => console.log(`import ${config.importDir}: ${r.imported} new, ${r.skipped} already there`))
    .catch((e) => console.error('import failed', e));
}
