import { randomBytes } from 'node:crypto';
const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastT = 0, lastR = 0n;
// Monotonic ULID: 48-bit ms time + 80-bit random, Crockford base32.
export function ulid(): string {
  let t = Date.now();
  let r: bigint;
  if (t <= lastT) { t = lastT; r = lastR + 1n; } else r = BigInt('0x' + randomBytes(10).toString('hex'));
  lastT = t; lastR = r;
  let s = '';
  for (let i = 0; i < 10; i++) { s = A[t % 32] + s; t = Math.floor(t / 32); }
  let rr = r;
  let tail = '';
  for (let i = 0; i < 16; i++) { tail = A[Number(rr % 32n)] + tail; rr /= 32n; }
  return s + tail;
}
