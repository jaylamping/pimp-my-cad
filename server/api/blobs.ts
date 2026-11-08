// BlobStore is the swappable seam for file bytes. Keys are plain strings, so the
// same code serves MinIO today and R2/S3/B2 later (endpoint + keys change only).
import {
  S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand,
  CreateBucketCommand, HeadBucketCommand,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { config } from './config';

export interface BlobStore {
  init(): Promise<void>;
  has(key: string): Promise<boolean>;
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  get(key: string, range?: { start: number; end?: number }): Promise<{ body: Readable; size: number; total: number; contentType?: string } | null>;
}

export class S3BlobStore implements BlobStore {
  private c: S3Client;
  private bucket: string;
  constructor(cfg = config.s3) {
    this.bucket = cfg.bucket;
    this.c = new S3Client({
      endpoint: cfg.endpoint, region: cfg.region, forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }
  async init() {
    try { await this.c.send(new HeadBucketCommand({ Bucket: this.bucket })); }
    catch { await this.c.send(new CreateBucketCommand({ Bucket: this.bucket })); }
  }
  async has(key: string) {
    try { await this.c.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })); return true; }
    catch { return false; }
  }
  async put(key: string, body: Buffer, contentType?: string) {
    await this.c.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }
  async get(key: string, range?: { start: number; end?: number }) {
    try {
      const r = await this.c.send(new GetObjectCommand({
        Bucket: this.bucket, Key: key,
        Range: range ? `bytes=${range.start}-${range.end ?? ''}` : undefined,
      }));
      const size = r.ContentLength ?? 0;
      const total = r.ContentRange ? Number(r.ContentRange.split('/')[1]) : size;
      return { body: r.Body as Readable, size, total, contentType: r.ContentType };
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey') return null;
      throw e;
    }
  }
}

// Key layout, from the storage design doc.
export const keys = {
  source: (ws: string, sha: string) => `workspaces/${ws}/files/${sha}`,
  glb: (ws: string, sha: string, v: string) => `workspaces/${ws}/derived/${sha}/model-${v}.glb`,
  tree: (ws: string, sha: string, v: string) => `workspaces/${ws}/derived/${sha}/parts-${v}.json`,
};
