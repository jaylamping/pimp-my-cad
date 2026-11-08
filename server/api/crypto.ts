// Envelope encryption for comments and anchors (not for source CAD files, by
// decision). A random data key per workspace is wrapped by the master key; each
// record is sealed with AES-256-GCM under the data key. A leaked table alone
// reveals nothing. Swap wrapKey/unwrapKey for a KMS call in the managed phase.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const masterBytes = (b64: string) => {
  const k = Buffer.from(b64, 'base64');
  if (k.length !== 32) throw new Error('PIMP_MASTER_KEY must be 32 random bytes, base64 (openssl rand -base64 32)');
  return k;
};

function seal(key: Buffer, plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]); // iv(12) | tag(16) | ciphertext
}
function open(key: Buffer, blob: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12));
  d.setAuthTag(blob.subarray(12, 28));
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

export class Vault {
  private master: Buffer;
  constructor(masterB64: string) { this.master = masterBytes(masterB64); }
  newWorkspaceKey(): Buffer { return seal(this.master, randomBytes(32)); } // wrapped key to store
  private dataKey(wrapped: Buffer) { return open(this.master, wrapped); }
  encryptJson(wrapped: Buffer, v: unknown): Buffer { return seal(this.dataKey(wrapped), Buffer.from(JSON.stringify(v))); }
  decryptJson<T>(wrapped: Buffer, blob: Buffer): T { return JSON.parse(open(this.dataKey(wrapped), blob).toString()); }
}
