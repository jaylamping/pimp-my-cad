import * as THREE from 'three';
import { Viewer, Hit, Mode } from './viewer';
import { loadModel, sha256 } from './loaders';
import { LocalStore, CommentStore, ReviewDoc, ReviewComment, Severity, newId } from './comments';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const viewer = new Viewer($('#view'));
const store: CommentStore = new LocalStore();

type LibItem = { title: string; path: string; url: string };
let library: LibItem[] = [];
let current: { path: string; title: string; sha: string; doc: ReviewDoc } | null = null;
let draft: Hit | null = null;
let activeId: string | null = null;
let severity: Severity = 'major';
let fileStatus = '';

const author = () => localStorage.getItem('review:author') || 'Joey';
const status = (s: string) => ($('#status').textContent = s);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

// ---------- loading ----------
async function open(buf: ArrayBuffer, path: string, title = path.split('/').pop()!) {
  status(`Loading ${title}…`);
  const t0 = performance.now();
  const { root, upAxis } = await loadModel(buf, path);
  const sha = await sha256(buf).catch(() => 'unhashed');
  viewer.setModel(root, upAxis);
  const doc = await store.load(path);
  current = { path, title, sha, doc };
  draft = null; activeId = null;
  ($('#explode') as HTMLInputElement).value = '0';
  ($('#sec-axis') as HTMLSelectElement).value = '';
  hideComposer();
  buildTree();
  renderComments();
  const tris = viewer.meshes.reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0);
  status(fileStatus = `${title} · ${viewer.meshes.length} bodies · ${(tris / 1000).toFixed(0)}k tris · rev ${sha.slice(0, 8)} · ${Math.round(performance.now() - t0)} ms`);
  const want = new URLSearchParams(location.hash.slice(1)).get('c');
  if (want) focusComment(want);
}

async function openUrl(item: LibItem) {
  const res = await fetch(item.url);
  if (!res.ok) return status(`Could not fetch ${item.url} (${res.status})`);
  const buf = await res.arrayBuffer();
  if (new TextDecoder().decode(buf.slice(0, 40)).startsWith('version https://git-lfs')) return status(`${item.title} is a Git LFS pointer, not the file`);
  setHash({ file: item.path });
  await open(buf, item.path, item.title);
}

function setHash(p: Record<string, string>) {
  const h = new URLSearchParams(p).toString();
  history.replaceState(null, '', `#${h}`);
}

async function initLibrary() {
  try {
    // library.local.json (gitignored) wins in dev; library.json is what a deployment ships
    for (const f of ['library.local.json', 'library.json']) {
      const r = await fetch(f);
      if (r.ok && (r.headers.get('content-type') || '').includes('json')) { library = (await r.json()).items; break; }
    }
  } catch { library = []; }
  const sel = $<HTMLSelectElement>('#library');
  for (const it of library) sel.add(new Option(it.title, it.path));
  sel.onchange = () => { const it = library.find((i) => i.path === sel.value); if (it) openUrl(it); };
  const want = new URLSearchParams(location.hash.slice(1)).get('file');
  const it = library.find((i) => i.path === want) || library[0];
  if (it) { sel.value = it.path; await openUrl(it); }
  else status('Drop a 3MF, STL or GLB anywhere, or press File');
}

$<HTMLInputElement>('#file').onchange = async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) await open(await f.arrayBuffer(), f.name);
};
document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
document.addEventListener('drop', async (e) => {
  e.preventDefault(); document.body.classList.remove('dragging');
  const f = e.dataTransfer?.files[0];
  if (f) await open(await f.arrayBuffer(), f.name);
});

// ---------- part tree ----------
function buildTree() {
  const ul = $('#tree');
  ul.innerHTML = '';
  for (const m of viewer.meshes) {
    const li = document.createElement('li');
    li.dataset.part = m.userData.part;
    const col = '#' + (m.userData.baseColor as number).toString(16).padStart(6, '0');
    const n = current!.doc.comments.filter((c) => c.part === m.userData.part && c.status === 'open').length;
    li.innerHTML = `<input type="checkbox" ${m.visible ? 'checked' : ''}/><span class="sw" style="background:${col}"></span>
      <span class="nm" title="${esc(m.userData.part)}">${esc(m.name)}</span>
      ${m.userData.kind === 'modifier' ? '<span class="mod">modifier</span>' : ''}${n ? `<span class="cnt">${n}</span>` : ''}`;
    const cb = li.querySelector('input')!;
    cb.onclick = (e) => { e.stopPropagation(); viewer.setVisible(m, cb.checked); };
    li.onclick = () => selectMesh(m);
    li.ondblclick = () => { viewer.isolate(viewer.meshes.every((x) => x === m || !x.visible) ? null : m); syncTreeChecks(); };
    ul.appendChild(li);
  }
}
function syncTreeChecks() {
  for (const li of Array.from(document.querySelectorAll<HTMLLIElement>('#tree li'))) {
    const m = viewer.meshes.find((x) => x.userData.part === li.dataset.part);
    if (m) li.querySelector('input')!.checked = m.visible;
  }
}
function selectMesh(m: THREE.Mesh | null) {
  viewer.select(m);
  for (const li of Array.from(document.querySelectorAll<HTMLLIElement>('#tree li'))) li.classList.toggle('sel', !!m && li.dataset.part === m.userData.part);
  const info = $('#info');
  if (!m) { info.innerHTML = ''; return; }
  const box = new THREE.Box3().setFromObject(m);
  const s = viewer.model!.scale.x * viewer.model!.parent!.scale.x;
  const size = box.getSize(new THREE.Vector3()).divideScalar(s);
  const st = m.userData.settings as Record<string, string> | undefined;
  info.innerHTML = `<h3>Selected</h3><div><code>${esc(m.userData.part)}</code></div>
    <div>Bounds ${size.x.toFixed(1)} × ${size.y.toFixed(1)} × ${size.z.toFixed(1)} mm</div>
    ${st ? `<div>Slicer overrides: ${Object.entries(st).map(([k, v]) => `<code>${esc(k)}=${esc(v)}</code>`).join(' ')}</div>` : ''}`;
  if ($<HTMLSelectElement>('#filter').value === 'part') renderComments();
}

// ---------- modes ----------
function setMode(mode: Mode) {
  viewer.mode = mode;
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('#modes button'))) b.classList.toggle('on', b.dataset.mode === mode);
  if (mode !== 'measure') viewer.clearMeasure();
  status(mode === 'pin' ? 'Tap the spot you want to comment on' : mode === 'measure' ? 'Tap two points to measure' : fileStatus);
}
for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('#modes button'))) b.onclick = () => setMode(b.dataset.mode as Mode);

viewer.onPick = (hit) => {
  if (viewer.mode === 'pin') {
    if (!hit) return;
    startDraft(hit);
    return;
  }
  selectMesh(hit?.mesh ?? null);
};
viewer.onMeasure = (mm) => { if (mm != null) status(`Distance ${mm.toFixed(2)} mm`); };

// ---------- composer ----------
function startDraft(hit: Hit) {
  draft = hit;
  viewer.clearPins();
  drawPins();
  viewer.addPin('draft', '+', hit.part, hit.local.toArray() as [number, number, number], 'draft', () => {});
  selectMesh(hit.mesh);
  $('#c-target').innerHTML = `On <code>${esc(hit.mesh.name)}</code> at (${hit.local.toArray().map((v) => v.toFixed(1)).join(', ')})`;
  $('#composer').hidden = false;
  document.body.classList.add('show-right');
  $<HTMLTextAreaElement>('#c-text').focus();
}
function hideComposer() {
  $('#composer').hidden = true;
  $<HTMLTextAreaElement>('#c-text').value = '';
  $<HTMLTextAreaElement>('#c-fix').value = '';
  draft = null;
}
for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('#c-sev button'))) b.onclick = () => {
  severity = b.dataset.v as Severity;
  for (const x of Array.from(document.querySelectorAll('#c-sev button'))) x.classList.toggle('on', x === b);
};
$('#c-cancel').onclick = () => { hideComposer(); renderComments(); };
$<HTMLFormElement>('#composer').onsubmit = async (e) => {
  e.preventDefault();
  if (!draft || !current) return;
  const c: ReviewComment = {
    id: newId(), part: draft.part,
    anchor: { p: round(draft.local.toArray()), n: round(draft.normal.toArray()) },
    severity, text: $<HTMLTextAreaElement>('#c-text').value.trim(),
    fix: $<HTMLTextAreaElement>('#c-fix').value.trim() || undefined,
    status: 'open', author: author(), created: new Date().toISOString(), rev: current.sha,
  };
  current.doc.comments.push(c);
  await store.save(current.doc);
  hideComposer();
  activeId = c.id;
  buildTree();
  renderComments();
};
const round = (a: number[]) => a.map((v) => Math.round(v * 1000) / 1000) as [number, number, number];

// ---------- comment list + pins ----------
function visibleComments(): ReviewComment[] {
  if (!current) return [];
  const f = $<HTMLSelectElement>('#filter').value;
  return current.doc.comments.filter((c) =>
    f === 'all' ? true : f === 'part' ? c.part === viewer.selected?.userData.part : c.status === 'open');
}
function drawPins() {
  if (!current) return;
  current.doc.comments.forEach((c, i) => {
    const cls = c.status === 'open' ? c.severity : 'done';
    viewer.addPin(c.id, String(i + 1), c.part, c.anchor.p, cls, () => focusComment(c.id));
  });
  viewer.highlightPin(activeId);
}
function renderComments() {
  viewer.clearPins();
  drawPins();
  if (draft) viewer.addPin('draft', '+', draft.part, draft.local.toArray() as [number, number, number], 'draft', () => {});
  const ol = $('#comments');
  ol.innerHTML = '';
  if (!current) return;
  const all = current.doc.comments;
  $('#open-count').textContent = String(all.filter((c) => c.status === 'open').length || '');
  for (const c of visibleComments()) {
    const n = all.indexOf(c) + 1;
    const li = document.createElement('li');
    li.className = `${c.severity} ${c.status !== 'open' ? 'done' : ''} ${c.id === activeId ? 'active' : ''} ${c.rev !== current.sha ? 'stale' : ''}`;
    const missing = !viewer.meshes.some((m) => m.userData.part === c.part);
    li.innerHTML = `<div class="meta"><b>#${n}</b><span>${c.severity}</span><span>${esc(c.part.split('/').pop()!)}</span>
        <span>${esc(c.author)}</span><span>${new Date(c.created).toLocaleString()}</span>${c.status !== 'open' ? `<span>${c.status}</span>` : ''}
        ${missing ? '<span style="color:var(--blocker)">part not in this file</span>' : ''}</div>
      <div class="txt">${esc(c.text)}</div>${c.fix ? `<div class="fix">${esc(c.fix)}</div>` : ''}
      ${c.resolved?.note ? `<div class="meta">Resolution: ${esc(c.resolved.note)}</div>` : ''}
      <div class="acts">${c.status === 'open'
        ? '<button data-a="fixed" class="btn">Fixed</button><button data-a="wontfix" class="btn">Won\'t fix</button>'
        : '<button data-a="open" class="btn">Reopen</button>'}
        <button data-a="link" class="btn">Link</button><button data-a="del" class="btn">Delete</button></div>`;
    li.onclick = (e) => {
      const a = (e.target as HTMLElement).dataset.a;
      if (a) return act(c, a);
      focusComment(c.id);
    };
    ol.appendChild(li);
  }
  if (!ol.children.length) ol.innerHTML = `<li class="done" style="border-left-color:var(--line)">No ${$<HTMLSelectElement>('#filter').value === 'all' ? '' : 'matching '}comments. Pick <b>Comment</b> and tap the part.</li>`;
}
async function act(c: ReviewComment, a: string) {
  if (!current) return;
  if (a === 'del') {
    if (!confirm('Delete this comment?')) return;
    current.doc.comments = current.doc.comments.filter((x) => x !== c);
  } else if (a === 'link') {
    setHash({ file: current.path, c: c.id });
    await navigator.clipboard?.writeText(location.href).catch(() => {});
    status('Link copied');
    return;
  } else if (a === 'open') {
    c.status = 'open'; delete c.resolved;
  } else {
    const note = prompt(a === 'fixed' ? 'How was it fixed? (optional)' : 'Why not? (optional)') ?? undefined;
    c.status = a as 'fixed' | 'wontfix';
    c.resolved = { by: author(), at: new Date().toISOString(), rev: current.sha, note: note || undefined };
  }
  await store.save(current.doc);
  buildTree();
  renderComments();
}
function focusComment(id: string) {
  activeId = id;
  const c = current?.doc.comments.find((x) => x.id === id);
  const w = viewer.pinWorld(id);
  if (w) viewer.focus(w);
  if (c) selectMesh(viewer.meshes.find((m) => m.userData.part === c.part) ?? null);
  renderComments();
  document.querySelector('#comments li.active')?.scrollIntoView({ block: 'nearest' });
}
$('#filter').onchange = renderComments;

// ---------- export / import ----------
$('#export').onclick = () => {
  if (!current) return;
  const blob = new Blob([JSON.stringify(current.doc, null, 2) + '\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = current.path.split('/').pop() + '.review.json';
  a.click();
};
$<HTMLInputElement>('#import').onchange = async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f || !current) return;
  const doc = JSON.parse(await f.text()) as ReviewDoc;
  const have = new Set(current.doc.comments.map((c) => c.id));
  for (const c of doc.comments) if (!have.has(c.id)) current.doc.comments.push(c);
  await store.save(current.doc);
  buildTree(); renderComments();
};

// ---------- view controls ----------
$<HTMLInputElement>('#explode').oninput = (e) => viewer.setExplode(+(e.target as HTMLInputElement).value);
const sec = () => viewer.setSection(($<HTMLSelectElement>('#sec-axis').value || null) as any, +$<HTMLInputElement>('#sec-pos').value, $<HTMLInputElement>('#sec-flip').checked);
$('#sec-axis').onchange = sec; $('#sec-pos').oninput = sec; $('#sec-flip').onchange = sec;
$<HTMLInputElement>('#show-mod').onchange = (e) => { viewer.showModifiers((e.target as HTMLInputElement).checked); syncTreeChecks(); };
$<HTMLSelectElement>('#views').onchange = (e) => viewer.view((e.target as HTMLSelectElement).value);
$('#fit').onclick = () => viewer.fit();
$('#toggle-left').onclick = () => { document.body.classList.toggle('show-left'); document.body.classList.remove('show-right'); };
$('#toggle-right').onclick = () => { document.body.classList.toggle('show-right'); document.body.classList.remove('show-left'); };
$('#view').addEventListener('pointerdown', () => document.body.classList.remove('show-left', 'show-right'));
document.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).matches('input, textarea, select')) return;
  const k = e.key.toLowerCase();
  if (k === 's') setMode('select');
  if (k === 'c') setMode('pin');
  if (k === 'm') setMode('measure');
  if (k === 'f') viewer.fit();
  if (k === 'escape') { hideComposer(); setMode('select'); renderComments(); }
});

initLibrary();
