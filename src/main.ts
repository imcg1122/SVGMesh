/**
 * SVGMesh.
 *
 * Load an STL, load one or more SVGs, click to place decals, drag to move them,
 * export a 3MF with each decal on its own toolhead.
 *
 * Preview uses Three's DecalGeometry, which clips real geometry to the
 * projector box and hugs the surface. That's a far more honest preview than a
 * floating quad — it shows curvature and silhouette the way the export will see
 * them. It is still an approximation: the export culls by face angle where
 * DecalGeometry clips by box, and the exported paint is quantized to the
 * subdivision tree. Both differences land below print resolution.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

import type { Tri } from './mmu/codec.ts';
import { boundingBox, parseSTL, trisToPositions } from './io/stl.ts';
import { build3mf, downloadBlob } from './io/threemf.ts';
import { rasterizeSvg } from './paint/svgMask.ts';
import { projectorFromHit, stampLayers, type DecalLayer } from './paint/stamp.ts';
import { DecalStore, type Decal } from './app/decals.ts';

/**
 * Bump whenever behaviour changes. Shown in the panel and written into export
 * filenames — a stale cached page cost us a debugging round trip once already.
 */
export const BUILD = 'v0.3.0';

/* eslint-disable @typescript-eslint/no-explicit-any */
// three-mesh-bvh patches these onto Three's prototypes at runtime.
(THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
(THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree;
(THREE.Mesh.prototype as any).raycast = acceleratedRaycast;

// --- state -----------------------------------------------------------------

const store = new DecalStore();
const textures = new Map<string, THREE.Texture>();
const decalMeshes = new Map<string, THREE.Mesh>();

let tris: Tri[] = [];
let mesh: THREE.Mesh | null = null;
let modelMinDim = 10;
let stlName = 'model';
let pendingAssetId: string | null = null;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $<HTMLDivElement>('status');
const hintEl = $<HTMLDivElement>('hint');
const say = (m: string) => {
  statusEl.textContent = m;
};

// --- scene -----------------------------------------------------------------

const view = $<HTMLDivElement>('view');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b1f24);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
camera.up.set(0, 0, 1);
camera.position.set(60, -80, 60);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
view.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(1, -1, 2);
scene.add(key);
const rim = new THREE.DirectionalLight(0xffffff, 0.4);
rim.position.set(-1, 1, -0.5);
scene.add(rim);

const grid = new THREE.GridHelper(400, 40, 0x3a424c, 0x2a3038);
grid.rotation.x = Math.PI / 2;
scene.add(grid);

const modelMat = new THREE.MeshStandardMaterial({ color: 0xff8000, roughness: 0.75 });

/** Toolhead swatches, matching Prusa's default extruder colours. */
const TOOL_COLOURS = ['#ff8000', '#db5182', '#3ec0ff', '#ff4f4f', '#fbeb7d'];
const toolColour = (n: number) => TOOL_COLOURS[(n - 1) % TOOL_COLOURS.length];

function resize(): void {
  const w = view.clientWidth;
  const h = view.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
addEventListener('resize', resize);
resize();

(function loop() {
  requestAnimationFrame(loop);
  controls.update();
  renderer.render(scene, camera);
})();

// --- decal rendering -------------------------------------------------------

/**
 * How deep the decal projector box cuts into the model. Too shallow and a decal
 * on a curved surface gets clipped; too deep and it punches through to the far
 * side of a thin part. Capping against the model's smallest dimension keeps a
 * 2mm token from getting a decal on its underside.
 */
function decalDepth(widthMm: number): number {
  return Math.max(0.6, Math.min(widthMm * 0.35, modelMinDim * 0.9));
}

function orientationFor(d: Decal): THREE.Euler {
  const p = projectorFromHit(d.point, d.normal, d.widthMm, d.widthMm, (d.rollDeg * Math.PI) / 180);
  const m = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(...p.right),
    new THREE.Vector3(...p.up),
    new THREE.Vector3(-p.direction[0], -p.direction[1], -p.direction[2]),
  );
  return new THREE.Euler().setFromRotationMatrix(m);
}

function heightOf(d: Decal): number {
  return d.widthMm / (store.assetFor(d)?.aspect ?? 1);
}

function rebuildDecal(d: Decal): void {
  if (!mesh) return;
  const old = decalMeshes.get(d.id);
  if (old) {
    scene.remove(old);
    old.geometry.dispose();
    (old.material as THREE.Material).dispose();
  }

  const h = heightOf(d);
  const geom = new DecalGeometry(
    mesh,
    new THREE.Vector3(...d.point),
    orientationFor(d),
    new THREE.Vector3(d.widthMm, h, decalDepth(Math.max(d.widthMm, h))),
  );

  const selected = store.selectedId === d.id;
  const mat = new THREE.MeshStandardMaterial({
    map: textures.get(d.assetId) ?? null,
    color: new THREE.Color(toolColour(d.state)),
    transparent: true,
    alphaTest: 0.5, // hard edge, matching how the paint actually resolves
    roughness: 0.7,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    emissive: new THREE.Color(selected ? 0x333333 : 0x000000),
  });

  const m = new THREE.Mesh(geom, mat);
  m.userData.decalId = d.id;
  m.renderOrder = 1;
  scene.add(m);
  decalMeshes.set(d.id, m);
}

function rebuildAll(): void {
  for (const [id, m] of decalMeshes) {
    if (!store.decals.some((d) => d.id === id)) {
      scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      decalMeshes.delete(id);
    }
  }
  for (const d of store.decals) rebuildDecal(d);
  renderPanel();
}

// --- panel -----------------------------------------------------------------

function renderPanel(): void {
  const list = $<HTMLDivElement>('decalList');
  list.innerHTML = '';

  if (store.decals.length === 0) {
    list.innerHTML = '<div class="empty">No decals yet.</div>';
  }

  store.decals.forEach((d, i) => {
    const row = document.createElement('div');
    row.className = 'row' + (d.id === store.selectedId ? ' sel' : '');

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = toolColour(d.state);

    const label = document.createElement('span');
    label.className = 'rowName';
    label.textContent = `${i + 1}. ${store.assetFor(d)?.name ?? 'decal'}`;

    const tool = document.createElement('span');
    tool.className = 'rowTool';
    tool.textContent = `T${d.state}`;

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.title = 'Delete';
    del.onclick = (e) => {
      e.stopPropagation();
      store.remove(d.id);
      rebuildAll();
    };

    row.append(swatch, label, tool, del);
    row.onclick = () => {
      store.selectedId = d.id;
      rebuildAll();
    };
    list.append(row);
  });

  const sel = store.selected;
  $<HTMLDivElement>('props').style.display = sel ? 'block' : 'none';
  if (sel) {
    $<HTMLInputElement>('size').value = String(sel.widthMm);
    $<HTMLInputElement>('rot').value = String(sel.rollDeg);
    $<HTMLSelectElement>('extruder').value = String(sel.state);
    $<HTMLSpanElement>('sizeVal').textContent = `${sel.widthMm.toFixed(1)} mm`;
    $<HTMLSpanElement>('rotVal').textContent = `${sel.rollDeg}°`;
  }

  $<HTMLButtonElement>('export').disabled = !mesh || store.decals.length === 0;
  $<HTMLButtonElement>('undo').disabled = !store.canUndo;
  $<HTMLButtonElement>('redo').disabled = !store.canRedo;
}

// --- loading ---------------------------------------------------------------

$<HTMLInputElement>('stl').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  stlName = file.name.replace(/\.stl$/i, '');
  say('Reading STL…');

  try {
    tris = parseSTL(await file.arrayBuffer());
  } catch (err) {
    say(`Could not read that STL.\n${(err as Error).message}`);
    return;
  }
  if (tris.length === 0) {
    say('That STL contained no triangles.');
    return;
  }

  if (mesh) {
    scene.remove(mesh);
    mesh.geometry.dispose();
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(trisToPositions(tris), 3));
  geom.computeVertexNormals();
  (geom as any).computeBoundsTree();
  mesh = new THREE.Mesh(geom, modelMat);
  scene.add(mesh);

  frameModel();
  rebuildAll();
  hintEl.textContent = pendingAssetId
    ? 'Click the model to place a decal'
    : 'Now load an SVG';
  say(`Loaded ${stlName} — ${tris.length.toLocaleString()} triangles.`);
});

function frameModel(): void {
  const { min, max } = boundingBox(tris);
  const dims = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  modelMinDim = Math.max(0.5, Math.min(...dims));
  const c = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  const span = Math.max(...dims) || 10;
  controls.target.copy(c);
  camera.position.set(c.x + span * 1.1, c.y - span * 1.5, c.z + span * 1.1);
  camera.near = span / 500;
  camera.far = span * 100;
  camera.updateProjectionMatrix();
  controls.update();
  grid.position.set(c.x, c.y, min[2]);
}

$<HTMLInputElement>('svg').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const svgText = await file.text();

  try {
    const { mask, aspect, preview } = await rasterizeSvg(svgText);
    const asset = store.addAsset({ name: file.name, svgText, mask, aspect });
    const tex = new THREE.CanvasTexture(preview);
    tex.colorSpace = THREE.SRGBColorSpace;
    textures.set(asset.id, tex);
    pendingAssetId = asset.id;
    hintEl.textContent = 'Click the model to place this decal';
    say(`Loaded ${file.name}. Click the model to place it.`);
  } catch (err) {
    say(`Could not rasterize that SVG.\n${(err as Error).message}`);
  }
  input.value = ''; // allow re-loading the same file
});

// --- pointer interaction ---------------------------------------------------

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let dragId: string | null = null;
let moved = false;

function pick(ev: PointerEvent): THREE.Intersection | null {
  if (!mesh) return null;
  const r = renderer.domElement.getBoundingClientRect();
  pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
  pointer.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObject(mesh, true)[0] ?? null;
}

renderer.domElement.addEventListener('pointerdown', (ev) => {
  moved = false;
  if (!mesh) return;

  const r = renderer.domElement.getBoundingClientRect();
  pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
  pointer.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const hitDecal = raycaster.intersectObjects([...decalMeshes.values()], false)[0];
  if (hitDecal) {
    const id = hitDecal.object.userData.decalId as string;
    store.selectedId = id;
    dragId = id;
    store.beginGesture(); // one undo step for the whole drag
    controls.enabled = false;
    rebuildAll();
  }
});

renderer.domElement.addEventListener('pointermove', (ev) => {
  moved = true;
  if (!dragId) return;
  const hit = pick(ev);
  if (!hit?.face) return;
  const n = hit.face.normal.clone().normalize();
  store.update(
    dragId,
    { point: [hit.point.x, hit.point.y, hit.point.z], normal: [n.x, n.y, n.z] },
    true,
  );
  const d = store.decals.find((x) => x.id === dragId);
  if (d) rebuildDecal(d);
});

addEventListener('pointerup', (ev) => {
  if (dragId) {
    dragId = null;
    controls.enabled = true;
    renderPanel();
    return;
  }
  if (moved || !mesh || !pendingAssetId) return;

  const hit = pick(ev as PointerEvent);
  if (!hit?.face) return;
  const n = hit.face.normal.clone().normalize();
  const asset = store.assets.get(pendingAssetId)!;
  const span = Math.max(modelMinDim, 10);

  store.add({
    assetId: asset.id,
    point: [hit.point.x, hit.point.y, hit.point.z],
    normal: [n.x, n.y, n.z],
    widthMm: Math.min(20, span * 4),
    rollDeg: 0,
    state: nextFreeToolhead(),
  });
  rebuildAll();
  say('Placed. Drag it to move, or adjust size and rotation below.');
});

/** Prefer a toolhead not already in use, so overlapping decals stay distinct. */
function nextFreeToolhead(): number {
  const base = parseInt($<HTMLSelectElement>('base').value, 10);
  const used = new Set(store.decals.map((d) => d.state));
  for (let t = 2; t <= 5; t++) if (t !== base && !used.has(t)) return t;
  return base === 2 ? 3 : 2;
}

// --- property controls -----------------------------------------------------

function bindSlider(id: string, apply: (d: Decal, value: number) => Partial<Decal>): void {
  const el = $<HTMLInputElement>(id);
  el.addEventListener('pointerdown', () => store.beginGesture());
  el.addEventListener('input', () => {
    const d = store.selected;
    if (!d) return;
    store.update(d.id, apply(d, parseFloat(el.value)), true);
    rebuildDecal(d);
    renderPanel();
  });
}
bindSlider('size', (_d, v) => ({ widthMm: v }));
bindSlider('rot', (_d, v) => ({ rollDeg: v }));

$<HTMLSelectElement>('extruder').addEventListener('change', (e) => {
  const d = store.selected;
  if (!d) return;
  store.update(d.id, { state: parseInt((e.target as HTMLSelectElement).value, 10) });
  rebuildAll();
});

$<HTMLButtonElement>('undo').onclick = () => {
  if (store.undo()) rebuildAll();
};
$<HTMLButtonElement>('redo').onclick = () => {
  if (store.redo()) rebuildAll();
};

addEventListener('keydown', (e) => {
  const typing = (e.target as HTMLElement)?.tagName === 'INPUT';
  if (typing) return;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    const done = e.shiftKey ? store.redo() : store.undo();
    if (done) rebuildAll();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && store.selectedId) {
    e.preventDefault();
    store.remove(store.selectedId);
    rebuildAll();
  }
});

// --- export ----------------------------------------------------------------

$<HTMLButtonElement>('export').addEventListener('click', async () => {
  if (!mesh || store.decals.length === 0) return;

  const targetFeatureMm = parseFloat($<HTMLSelectElement>('quality').value);
  const base = parseInt($<HTMLSelectElement>('base').value, 10);

  const clashing = store.decals.filter((d) => d.state === base);
  if (clashing.length > 0) {
    say(
      `${clashing.length} decal(s) use toolhead ${base}, the same as the model.\n` +
        'Paint that matches the model’s own toolhead is invisible — give them a different one.',
    );
    return;
  }

  const btn = $<HTMLButtonElement>('export');
  btn.disabled = true;
  say('Projecting…');
  await new Promise((r) => setTimeout(r, 16)); // let the UI paint before blocking

  try {
    const t0 = performance.now();
    const layers: DecalLayer[] = store.decals.map((d) => {
      const asset = store.assetFor(d)!;
      const h = heightOf(d);
      return {
        projector: projectorFromHit(d.point, d.normal, d.widthMm, h, (d.rollDeg * Math.PI) / 180),
        mask: asset.mask,
        state: d.state,
      };
    });

    const result = stampLayers(tris, layers, { targetFeatureMm });

    if (result.stats.paintedTriangles === 0) {
      say(
        'Nothing was painted.\nThe decals may be off the edge of the model, on faces angled ' +
          'away from where you placed them, or too small for the current detail setting.',
      );
      return;
    }

    const data = build3mf({
      tris: result.tris,
      segments: result.segments,
      baseExtruder: base,
      objectName: stlName,
    });

    const stampId = new Date().toISOString().slice(11, 19).replace(/:/g, '');
    downloadBlob(data, `${stlName}-${store.decals.length}decal-${targetFeatureMm}mm-${stampId}.3mf`);

    const s = result.stats;
    const tools = [...new Set(store.decals.map((d) => d.state))].sort().join(', ');
    say(
      `Exported in ${Math.round(performance.now() - t0)} ms  ·  ${BUILD}\n` +
        `${store.decals.length} decal(s) on toolhead ${tools}\n` +
        `${s.paintedTriangles.toLocaleString()} of ${s.triangles.toLocaleString()} triangles painted\n` +
        `Resolved to ${s.effectiveResolutionMm.toFixed(3)} mm · ${(data.length / 1024).toFixed(0)} KB\n` +
        'Mesh unchanged — no repair needed.',
    );
  } catch (err) {
    say(`Export failed.\n${(err as Error).message}`);
  } finally {
    btn.disabled = false;
    renderPanel();
  }
});

// --- init ------------------------------------------------------------------

$<HTMLDivElement>('version').textContent = BUILD;
renderPanel();
