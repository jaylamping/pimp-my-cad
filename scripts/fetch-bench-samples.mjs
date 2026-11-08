// Downloads test meshes for the GPU print-check bench (bench.html) into public/samples/ (gitignored)
// and writes public/samples/bench.json. Defaults to marengo's upper-arm print package, including
// two older revisions of upper_arm.stl for the revision-distance check.
//
//   npm run bench:samples [-- owner/repo]
//
// Files come from GitHub's LFS media endpoint, so no git-lfs install or clone is needed.
// Plain Node (18+), so it runs the same on Windows, macOS and Linux.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const repo = process.argv[2] ?? 'jaylamping/marengo';
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`expected owner/repo, got ${repo}`);
const dir = 'hardware/designs/left-arm/prints/upper-arm/cad';
const out = resolve(import.meta.dirname, '..', 'public', 'samples');
await mkdir(out, { recursive: true });

async function get(ref, path, file) {
  const url = `https://media.githubusercontent.com/media/${repo}/${ref}/${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000 && buf.toString('utf8', 0, 40).startsWith('version https://git-lfs')) {
    throw new Error(`${file} came back as an LFS pointer, not the mesh: ${url}`);
  }
  await writeFile(resolve(out, file), buf);
  console.log(`  ${file} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

console.log(`Fetching from ${repo} into ${out}`);
for (const f of ['carrier', 'cover', 'p2_l05', 'upper_arm']) await get('main', `${dir}/${f}.stl`, `${f}.stl`);
// Older upper_arm revisions: e036254 (neck spikes fix, close to current) and 0c1a074 (coarse
// export from the first gate review, a much bigger change).
await get('e036254', `${dir}/upper_arm.stl`, 'upper_arm@e036254.stl');
await get('0c1a074', `${dir}/upper_arm.stl`, 'upper_arm@0c1a074.stl');

await writeFile(resolve(out, 'bench.json'), JSON.stringify({
  meshes: [
    { name: 'upper_arm', url: '/samples/upper_arm.stl', revisions: [
      { name: 'upper_arm @ e036254', url: '/samples/upper_arm@e036254.stl' },
      { name: 'upper_arm @ 0c1a074', url: '/samples/upper_arm@0c1a074.stl' } ] },
    { name: 'p2_l05', url: '/samples/p2_l05.stl', revisions: [] },
    { name: 'cover', url: '/samples/cover.stl', revisions: [] },
    { name: 'carrier', url: '/samples/carrier.stl', revisions: [] },
  ],
}, null, 2));
console.log('Wrote public/samples/bench.json. Now run: npm run bench');
