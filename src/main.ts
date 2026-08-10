/**
 * SVGMesh.
 *
 * Load an STL, build a library of SVGs, place decals on the surface, and export
 * a 3MF in one of two modes:
 *
 *   PARTS — each decal becomes a thin extruded volume embedded just under the
 *           surface. PrusaSlicer lists it under the object with its own
 *           toolhead dropdown, and smart fill / bucket fill work on it because
 *           it is real geometry. Colour depth is exactly the prism thickness.
 *
 *   PAINT — MMU segmentation, mesh untouched. Nothing to repair, works on any
 *           surface, but only editable with the paint brush and the slicer
 *           decides how deep the colour reaches.
 *
 * Preview uses DecalGeometry, which clips real geometry to the projector box
 * and hugs the surface, so curvature and silhouette read correctly.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DecalGeometry } from 'three/addons/geometries/DecalGeometry.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

import type { Tri, Vec3 } from './mmu/codec.ts';
import { boundingBox, parseSTL, trisToPositions } from './io/stl.ts';
import { build3mf, downloadBlob, type Volume } from './io/threemf.ts';
import { rasterizeSvg } from './paint/svgMask.ts';
import { extrudeShapes, parseSvgShapes, polygonsToShapes } from './paint/extrude.ts';
import { FONT_FAMILIES, renderText } from './app/text.ts';
import { projectorFromHit, stampLayers, type DecalLayer, type Mask } from './paint/stamp.ts';
import { DecalStore, type Decal } from './app/decals.ts';
import { watchForNewBuild } from './app/updateCheck.ts';

/** Shown in the panel and written into export filenames. Bump on behaviour changes. */
export const BUILD = 'v0.5.1';

/* eslint-disable @typescript-eslint/no-explicit-any */
(THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
(THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree;
(THREE.Mesh.prototype as any).raycast = acceleratedRaycast;

// --- state -----------------------------------------------------------------

const store = new DecalStore();
const thumbs = new Map<string, string>();
const silhouettes = new Map<string, HTMLCanvasElement>();
const textures = new Map<string, THREE.Texture>();
const decalMeshes = new Map<string, THREE.Mesh>();

let tris: Tri[] = [];
let mesh: THREE.Mesh | null = null;
let modelMinDim = 10;
let modelSpan = 50;
let modelCentre = new THREE.Vector3();
let stlName = 'model';
let activeAssetId: string | null = null;

/** New decals inherit the last size and toolhead used, rather than resetting. */
let lastWidthMm = 20;
let lastState = 2;

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

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const key = new THREE.DirectionalLight(0xffffff, 1.4);
key.position.set(1, -1, 2);
scene.add(key);
const rim = new THREE.DirectionalLight(0xffffff, 0.4);
rim.position.set(-1, 1, -0.5);
scene.add(rim);

const grid = new THREE.GridHelper(400, 40, 0x3a424c, 0x2a3038);
grid.rotation.x = Math.PI / 2;
scene.add(grid);

// DoubleSide matters for more than looks: Three culls raycast hits by
// material.side, so a FrontSide model is invisible to any ray travelling
// outward from inside it — which is exactly what "copy to opposite face" does.
// It also saves us from STLs with inconsistent winding.
const modelMat = new THREE.MeshStandardMaterial({
  color: 0xff8000,
  roughness: 0.75,
  side: THREE.DoubleSide,
});

const TOOL_COLOURS = ['#ff8000', '#db5182', '#3ec0ff', '#ff4f4f', '#fbeb7d'];
const toolColour = (n: number) => TOOL_COLOURS[(n - 1) % TOOL_COLOURS.length];

function resize(): void {
  camera.aspect = view.clientWidth / view.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(view.clientWidth, view.clientHeight);
}
addEventListener('resize', resize);
resize();

(function loop() {
  requestAnimationFrame(loop);
  controls.update();
  renderer.render(scene, camera);
})();

// --- surface maths ---------------------------------------------------------

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

/**
 * Drop a point onto the model surface along -normal.
 *
 * Nudging and aligning move a decal in its own tangent plane, which on anything
 * but a flat face leaves it floating or buried. Re-projecting keeps it stuck to
 * the surface and picks up the new local normal.
 */
function snapToSurface(target: Vec3, normal: Vec3): { point: Vec3; normal: Vec3 } | null {
  if (!mesh) return null;
  const dir = new THREE.Vector3(-normal[0], -normal[1], -normal[2]).normalize();
  const origin = new THREE.Vector3(...target).addScaledVector(dir, -modelSpan);
  raycaster.set(origin, dir);
  raycaster.far = modelSpan * 3;
  const hit = raycaster.intersectObject(mesh, true)[0];
  raycaster.far = Infinity;
  if (!hit?.face) return null;
  const n = hit.face.normal.clone().normalize();
  return { point: [hit.point.x, hit.point.y, hit.point.z], normal: [n.x, n.y, n.z] };
}

/**
 * The far side of the model, straight through from a given surface point.
 *
 * Implemented as an OUTSIDE-IN ray: start beyond the far side and come back
 * toward the model along the flipped normal. The obvious approach — fire a ray
 * from inside the model outward — is fragile, because it depends on back faces
 * being hittable, which in turn depends on material.side, geometry winding and
 * how the raycaster was configured. Approaching from outside hits a front face
 * on a correctly wound mesh and needs none of that to line up.
 *
 * `snapToSurface` already does exactly this, so the whole feature reduces to
 * "snap to the surface, looking the other way".
 */
function oppositeFace(point: Vec3, normal: Vec3): { point: Vec3; normal: Vec3 } | null {
  return snapToSurface(point, [-normal[0], -normal[1], -normal[2]]);
}

function basisOf(d: Decal) {
  return projectorFromHit(d.point, d.normal, d.widthMm, heightOf(d), (d.rollDeg * Math.PI) / 180);
}

function heightOf(d: Decal): number {
  return d.widthMm / (store.assetFor(d)?.aspect ?? 1);
}

// --- decal preview ---------------------------------------------------------

function textureFor(assetId: string, mirrorX: boolean): THREE.Texture | null {
  const canvas = silhouettes.get(assetId);
  if (!canvas) return null;
  const k = `${assetId}:${mirrorX}`;
  let t = textures.get(k);
  if (!t) {
    t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    if (mirrorX) {
      t.wrapS = THREE.RepeatWrapping;
      t.repeat.x = -1;
      t.offset.x = 1;
    }
    textures.set(k, t);
  }
  return t;
}

/**
 * Depth of the projector box used for preview. Capped against the model's
 * smallest dimension so a 15mm decal on a 2mm token doesn't punch through and
 * appear on the underside.
 */
const previewDepth = (size: number) => Math.max(0.4, Math.min(size * 0.3, modelMinDim * 0.85));

function rebuildDecal(d: Decal): void {
  if (!mesh) return;
  disposeDecalMesh(d.id);

  const h = heightOf(d);
  const p = basisOf(d);
  const orientation = new THREE.Euler().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(
      new THREE.Vector3(...p.right),
      new THREE.Vector3(...p.up),
      new THREE.Vector3(-p.direction[0], -p.direction[1], -p.direction[2]),
    ),
  );

  const geom = new DecalGeometry(
    mesh,
    new THREE.Vector3(...d.point),
    orientation,
    new THREE.Vector3(d.widthMm, h, previewDepth(Math.max(d.widthMm, h))),
  );

  const m = new THREE.Mesh(
    geom,
    new THREE.MeshStandardMaterial({
      map: textureFor(d.assetId, d.mirrorX),
      color: new THREE.Color(toolColour(d.state)),
      transparent: true,
      alphaTest: 0.5,
      roughness: 0.65,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      emissive: new THREE.Color(store.selectedId === d.id ? 0x2a2a2a : 0x000000),
    }),
  );
  m.userData.decalId = d.id;
  m.renderOrder = 1;
  scene.add(m);
  decalMeshes.set(d.id, m);
}

function disposeDecalMesh(id: string): void {
  const m = decalMeshes.get(id);
  if (!m) return;
  scene.remove(m);
  m.geometry.dispose();
  (m.material as THREE.Material).dispose();
  decalMeshes.delete(id);
}

function rebuildAll(): void {
  for (const id of [...decalMeshes.keys()]) {
    if (!store.decals.some((d) => d.id === id)) disposeDecalMesh(id);
  }
  for (const d of store.decals) rebuildDecal(d);
  renderPanel();
}

// --- panel -----------------------------------------------------------------

function renderAssets(): void {
  const gridEl = $<HTMLDivElement>('assetGrid');
  gridEl.innerHTML = '';
  for (const asset of store.assets.values()) {
    const cell = document.createElement('div');
    cell.className = 'asset' + (asset.id === activeAssetId ? ' active' : '');
    cell.title = asset.name;

    const thumb = thumbs.get(asset.id);
    if (thumb) {
      const img = document.createElement('img');
      img.src = thumb;
      cell.append(img);
    }

    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '×';
    x.title = `Remove ${asset.name}`;
    x.onclick = (e) => {
      e.stopPropagation();
      const n = store.removeByAsset(asset.id);
      if (activeAssetId === asset.id) activeAssetId = null;
      thumbs.delete(asset.id);
      silhouettes.delete(asset.id);
      rebuildAll();
      renderAssets();
      say(n > 0 ? `Removed ${asset.name} and ${n} decal(s) using it.` : `Removed ${asset.name}.`);
    };
    cell.append(x);

    cell.onclick = () => {
      activeAssetId = asset.id;
      renderAssets();
      hintEl.textContent = mesh ? 'Click the model to place this decal' : 'Load an STL';
      say(`${asset.name} selected. Click the model to place it.`);
    };
    gridEl.append(cell);
  }
  $<HTMLDivElement>('assetHint').textContent =
    store.assets.size === 0
      ? 'Add SVGs, pick one, then click the model to place it.'
      : 'Click a thumbnail to arm it, then click the model.';
}

function renderPanel(): void {
  const list = $<HTMLDivElement>('decalList');
  list.innerHTML = '';
  if (store.decals.length === 0) list.innerHTML = '<div class="empty">No decals yet.</div>';

  store.decals.forEach((d, i) => {
    const row = document.createElement('div');
    row.className = 'row' + (d.id === store.selectedId ? ' sel' : '');

    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = toolColour(d.state);

    const name = document.createElement('span');
    name.className = 'rowName';
    name.textContent = `${i + 1}. ${store.assetFor(d)?.name ?? 'decal'}`;

    const tool = document.createElement('span');
    tool.className = 'rowTool';
    tool.textContent = `T${d.state}`;

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '×';
    del.onclick = (e) => {
      e.stopPropagation();
      store.remove(d.id);
      rebuildAll();
    };

    row.append(sw, name, tool, del);
    row.onclick = () => {
      store.selectedId = d.id;
      rebuildAll();
    };
    list.append(row);
  });

  const sel = store.selected;
  $<HTMLFieldSetElement>('props').style.display = sel ? 'block' : 'none';
  if (sel) {
    $<HTMLInputElement>('size').value = String(sel.widthMm);
    $<HTMLInputElement>('sizeNum').value = sel.widthMm.toFixed(2);
    $<HTMLInputElement>('rot').value = String(sel.rollDeg);
    $<HTMLInputElement>('rotNum').value = String(sel.rollDeg);
    $<HTMLSelectElement>('extruder').value = String(sel.state);
    $<HTMLInputElement>('mirrorX').checked = sel.mirrorX;
  }

  $<HTMLButtonElement>('export').disabled = !mesh || store.decals.length === 0;
  $<HTMLButtonElement>('undo').disabled = !store.canUndo;
  $<HTMLButtonElement>('redo').disabled = !store.canRedo;
  $<HTMLButtonElement>('clearModel').disabled = !mesh;
}

// --- model loading ---------------------------------------------------------

$<HTMLInputElement>('stl').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  let parsed: Tri[];
  try {
    parsed = parseSTL(await file.arrayBuffer());
  } catch (err) {
    say(`Could not read that STL.\n${(err as Error).message}`);
    return;
  }
  if (parsed.length === 0) {
    say('That STL contained no triangles.');
    return;
  }

  const replacing = mesh !== null;
  tris = parsed;
  stlName = file.name.replace(/\.stl$/i, '');
  loadMesh();

  // Decal positions are model coordinates, so they're meaningless on a
  // different model. Clear rather than leave decals floating in space.
  if (replacing && store.decals.length > 0) {
    store.clear();
    say(`Loaded ${stlName} — ${tris.length.toLocaleString()} triangles.\nPrevious decals cleared (undo brings them back).`);
  } else {
    say(`Loaded ${stlName} — ${tris.length.toLocaleString()} triangles.`);
  }
  rebuildAll();
  hintEl.textContent = activeAssetId ? 'Click the model to place a decal' : 'Now add an SVG';
  input.value = '';
});

function loadMesh(): void {
  if (mesh) {
    scene.remove(mesh);
    mesh.geometry.dispose();
    mesh = null;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(trisToPositions(tris), 3));
  geom.computeVertexNormals();
  (geom as any).computeBoundsTree();
  mesh = new THREE.Mesh(geom, modelMat);
  scene.add(mesh);

  const { min, max } = boundingBox(tris);
  const dims = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  modelMinDim = Math.max(0.5, Math.min(...dims));
  modelSpan = Math.max(...dims) || 10;
  modelCentre.set((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);

  controls.target.copy(modelCentre);
  camera.position.set(
    modelCentre.x + modelSpan * 1.1,
    modelCentre.y - modelSpan * 1.5,
    modelCentre.z + modelSpan * 1.1,
  );
  camera.near = modelSpan / 500;
  camera.far = modelSpan * 100;
  camera.updateProjectionMatrix();
  controls.update();
  grid.position.set(modelCentre.x, modelCentre.y, min[2]);
}

$<HTMLButtonElement>('clearModel').onclick = () => {
  if (!mesh) return;
  scene.remove(mesh);
  mesh.geometry.dispose();
  mesh = null;
  tris = [];
  store.clear();
  rebuildAll();
  hintEl.textContent = 'Load an STL to begin';
  say('Model removed. The SVG library is kept.');
};

// --- SVG library -----------------------------------------------------------

$<HTMLInputElement>('svg').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = '';
  if (files.length === 0) return;

  let added = 0;
  for (const file of files) {
    const svgText = await file.text();
    try {
      const { mask, aspect, preview, silhouette } = await rasterizeSvg(svgText);
      const asset = store.addAsset({ name: file.name, svgText, mask, aspect });
      silhouettes.set(asset.id, silhouette);
      thumbs.set(asset.id, preview.toDataURL());
      activeAssetId = asset.id;
      added++;
    } catch (err) {
      say(`Could not rasterize ${file.name}.\n${(err as Error).message}`);
    }
  }

  renderAssets();
  if (added > 0) {
    hintEl.textContent = mesh ? 'Click the model to place this decal' : 'Now load an STL';
    say(`Added ${added} SVG${added > 1 ? 's' : ''}. Click the model to place one.`);
  }
});

// --- text ------------------------------------------------------------------

const fontSel = $<HTMLSelectElement>('fontFamily');
for (const f of FONT_FAMILIES) {
  const o = document.createElement('option');
  o.value = f;
  o.textContent = f;
  o.style.fontFamily = f;
  fontSel.append(o);
}
fontSel.value = 'Arial';

$<HTMLButtonElement>('addText').onclick = () => {
  const text = $<HTMLTextAreaElement>('textInput').value.trim();
  if (!text) {
    say('Type something first.');
    return;
  }
  try {
    const r = renderText({
      text,
      fontFamily: fontSel.value,
      bold: $<HTMLInputElement>('fontBold').checked,
    });
    const name = text.replace(/\s+/g, ' ').slice(0, 24);
    const asset = store.addAsset({
      name,
      mask: r.mask,
      aspect: r.aspect,
      polygons: r.polygons,
    });
    silhouettes.set(asset.id, r.silhouette);
    thumbs.set(asset.id, r.preview.toDataURL());
    activeAssetId = asset.id;
    renderAssets();
    hintEl.textContent = mesh ? 'Click the model to place this text' : 'Now load an STL';
    say(`Added “${name}”. Click the model to place it.`);
  } catch (err) {
    say(`Could not render that text.\n${(err as Error).message}`);
  }
};

// --- placing and dragging --------------------------------------------------

let dragId: string | null = null;
let moved = false;

function setPointer(ev: PointerEvent): void {
  const r = renderer.domElement.getBoundingClientRect();
  pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
  pointer.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
}

renderer.domElement.addEventListener('pointerdown', (ev) => {
  moved = false;
  if (!mesh) return;
  setPointer(ev);
  const hit = raycaster.intersectObjects([...decalMeshes.values()], false)[0];
  if (!hit) return;

  store.selectedId = hit.object.userData.decalId as string;
  dragId = store.selectedId;
  store.beginGesture(); // whole drag collapses to one undo step
  controls.enabled = false;
  rebuildAll();
});

renderer.domElement.addEventListener('pointermove', (ev) => {
  moved = true;
  if (!dragId || !mesh) return;
  setPointer(ev);
  const hit = raycaster.intersectObject(mesh, true)[0];
  if (!hit?.face) return;
  const n = hit.face.normal.clone().normalize();
  store.update(dragId, { point: [hit.point.x, hit.point.y, hit.point.z], normal: [n.x, n.y, n.z] }, true);
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
  if (moved || !mesh || !activeAssetId) return;

  setPointer(ev as PointerEvent);
  const hit = raycaster.intersectObject(mesh, true)[0];
  if (!hit?.face) return;
  const n = hit.face.normal.clone().normalize();

  store.add({
    assetId: activeAssetId,
    point: [hit.point.x, hit.point.y, hit.point.z],
    normal: [n.x, n.y, n.z],
    widthMm: lastWidthMm,
    rollDeg: 0,
    state: lastState,
    thicknessMm: parseFloat($<HTMLInputElement>('thickness').value) || 0.6,
    mirrorX: false,
  });
  rebuildAll();
  say('Placed. Drag to move, arrow keys to nudge, or use the align buttons.');
});

// --- selected-decal controls ----------------------------------------------

/** Keep a slider and its number field in step, both editing the same value. */
function bindNumeric(
  sliderId: string,
  numberId: string,
  apply: (v: number) => Partial<Decal>,
  after?: (d: Decal) => void,
): void {
  const slider = $<HTMLInputElement>(sliderId);
  const num = $<HTMLInputElement>(numberId);

  const commit = (raw: string, coalesce: boolean) => {
    const d = store.selected;
    const v = parseFloat(raw);
    if (!d || !Number.isFinite(v)) return;
    store.update(d.id, apply(v), coalesce);
    after?.(d);
    rebuildDecal(d);
    renderPanel();
  };

  slider.addEventListener('pointerdown', () => store.beginGesture());
  slider.addEventListener('input', () => commit(slider.value, true));
  num.addEventListener('change', () => commit(num.value, false));
}

bindNumeric('size', 'sizeNum', (v) => ({ widthMm: Math.max(0.1, v) }), (d) => {
  lastWidthMm = d.widthMm;
});
bindNumeric('rot', 'rotNum', (v) => ({ rollDeg: v }));

$<HTMLSelectElement>('extruder').addEventListener('change', (e) => {
  const d = store.selected;
  if (!d) return;
  lastState = parseInt((e.target as HTMLSelectElement).value, 10);
  store.update(d.id, { state: lastState });
  rebuildAll();
});

$<HTMLInputElement>('mirrorX').addEventListener('change', (e) => {
  const d = store.selected;
  if (!d) return;
  store.update(d.id, { mirrorX: (e.target as HTMLInputElement).checked });
  rebuildAll();
});

$<HTMLInputElement>('thickness').addEventListener('change', (e) => {
  const v = parseFloat((e.target as HTMLInputElement).value);
  const d = store.selected;
  if (d && Number.isFinite(v)) store.update(d.id, { thicknessMm: Math.max(0.05, v) });
});

// --- alignment -------------------------------------------------------------

type Align = 'left' | 'right' | 'hcenter' | 'top' | 'bottom' | 'center';

/**
 * Align against the model's bounding box as seen from the decal's own viewing
 * direction. "Centre" on a hexagon token's face therefore means the centre of
 * the token, which is what you actually want for a coin-like stamp.
 */
function alignDecal(d: Decal, how: Align): void {
  if (!mesh) return;
  const p = basisOf(d);
  const right = new THREE.Vector3(...p.right);
  const upv = new THREE.Vector3(...p.up);
  const { min, max } = boundingBox(tris);

  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) {
      for (const z of [min[2], max[2]]) {
        const rel = new THREE.Vector3(x, y, z).sub(modelCentre);
        const u = rel.dot(right);
        const v = rel.dot(upv);
        uMin = Math.min(uMin, u);
        uMax = Math.max(uMax, u);
        vMin = Math.min(vMin, v);
        vMax = Math.max(vMax, v);
      }
    }
  }

  const cur = new THREE.Vector3(...d.point).sub(modelCentre);
  let u = cur.dot(right);
  let v = cur.dot(upv);
  const hw = d.widthMm / 2;
  const hh = heightOf(d) / 2;

  if (how === 'left') u = uMin + hw;
  if (how === 'right') u = uMax - hw;
  if (how === 'bottom') v = vMin + hh;
  if (how === 'top') v = vMax - hh;
  if (how === 'hcenter') u = 0;
  if (how === 'center') {
    u = 0;
    v = 0;
  }

  const target = modelCentre.clone().addScaledVector(right, u).addScaledVector(upv, v);
  const snapped = snapToSurface([target.x, target.y, target.z], d.normal);
  if (!snapped) {
    say('Could not align — that position misses the model surface.');
    return;
  }
  store.update(d.id, snapped);
}

for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-align]')) {
  btn.onclick = () => {
    const d = store.selected;
    if (!d) return;
    alignDecal(d, btn.dataset.align as Align);
    rebuildAll();
  };
}

$<HTMLButtonElement>('mirrorOpposite').onclick = () => {
  const d = store.selected;
  if (!d) return;
  const far = oppositeFace(d.point, d.normal);
  if (!far) {
    say('No opposite face found straight through from there.');
    return;
  }
  store.duplicate(d.id, { ...far, mirrorX: !d.mirrorX });
  rebuildAll();
  say(
    'Copied to the opposite face, artwork flipped so it reads the same from that side.\n' +
      'Untick "Flip artwork horizontally" if you wanted it unmirrored.',
  );
};

// --- keyboard --------------------------------------------------------------

addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT') return;

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey ? store.redo() : store.undo()) rebuildAll();
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && store.selectedId) {
    e.preventDefault();
    store.remove(store.selectedId);
    rebuildAll();
    return;
  }

  const arrows: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, 1],
    ArrowDown: [0, -1],
  };
  const dir = arrows[e.key];
  const d = store.selected;
  if (!dir || !d) return;

  e.preventDefault();
  const step = parseFloat($<HTMLSelectElement>('nudgeStep').value);
  const p = basisOf(d);
  const target: Vec3 = [
    d.point[0] + p.right[0] * dir[0] * step + p.up[0] * dir[1] * step,
    d.point[1] + p.right[1] * dir[0] * step + p.up[1] * dir[1] * step,
    d.point[2] + p.right[2] * dir[0] * step + p.up[2] * dir[1] * step,
  ];
  const snapped = snapToSurface(target, d.normal);
  store.update(d.id, snapped ?? { point: target });
  rebuildAll();
});

// --- history buttons -------------------------------------------------------

$<HTMLButtonElement>('undo').onclick = () => {
  if (store.undo()) rebuildAll();
};
$<HTMLButtonElement>('redo').onclick = () => {
  if (store.redo()) rebuildAll();
};

// --- output mode -----------------------------------------------------------

const modeSel = $<HTMLSelectElement>('mode');
function syncMode(): void {
  const parts = modeSel.value === 'parts';
  $<HTMLDivElement>('thicknessWrap').style.display = parts ? 'block' : 'none';
  $<HTMLDivElement>('qualityWrap').style.display = parts ? 'none' : 'block';
  $<HTMLDivElement>('modeNote').textContent = parts
    ? 'Each decal becomes a thin part embedded under the surface. Listed in PrusaSlicer’s object tree with its own toolhead, and smart fill works on it.'
    : 'Per-triangle MMU paint. The mesh is never modified and there is nothing to repair, but the slicer decides how deep the colour reaches.';
}
modeSel.addEventListener('change', syncMode);
syncMode();

// --- export ----------------------------------------------------------------

$<HTMLButtonElement>('export').addEventListener('click', async () => {
  if (!mesh || store.decals.length === 0) return;

  const base = parseInt($<HTMLSelectElement>('base').value, 10);
  const parts = modeSel.value === 'parts';

  const clash = store.decals.filter((d) => d.state === base);
  if (clash.length > 0) {
    say(
      `${clash.length} decal(s) use toolhead ${base}, the same as the model.\n` +
        'They would be invisible — give them a different toolhead.',
    );
    return;
  }

  const btn = $<HTMLButtonElement>('export');
  btn.disabled = true;
  say(parts ? 'Building parts…' : 'Projecting…');
  await new Promise((r) => setTimeout(r, 16));

  try {
    const t0 = performance.now();
    let volumes: Volume[];
    let detail: string;

    if (parts) {
      volumes = [{ name: stlName, tris, extruder: base }];
      let skipped = 0;
      for (const [i, d] of store.decals.entries()) {
        const asset = store.assetFor(d);
        if (!asset) continue;

        // Prefer the SVG's own paths — exact curves beat a traced raster. Fall
        // back to traced outlines for text, and for stroke-only SVGs that
        // legitimately contain no fillable shapes.
        let shapes = asset.svgText ? parseSvgShapes(asset.svgText) : [];
        if (shapes.length === 0 && asset.polygons) {
          shapes = polygonsToShapes(asset.polygons, asset.aspect);
        }

        const prism = extrudeShapes(shapes, {
          point: d.point,
          normal: d.normal,
          widthMm: d.widthMm,
          heightMm: heightOf(d),
          thicknessMm: d.thicknessMm,
          rollRad: (d.rollDeg * Math.PI) / 180,
          mirrorX: d.mirrorX,
        });
        if (prism.length === 0) {
          skipped++;
          continue;
        }
        volumes.push({
          name: `${i + 1} ${store.assetFor(d)?.name ?? 'decal'}`,
          tris: prism,
          extruder: d.state,
        });
      }
      if (volumes.length === 1) {
        say(
          'No decal geometry could be built.\nThese SVGs may be stroke-only — part mode needs ' +
            'filled shapes. Add a fill, or use Paint mode.',
        );
        return;
      }
      const faces = volumes.slice(1).reduce((n, v) => n + v.tris.length, 0);
      detail =
        `${volumes.length - 1} part(s), ${faces.toLocaleString()} triangles added\n` +
        `${store.decals[0].thicknessMm} mm deep` +
        (skipped ? `\n${skipped} decal(s) skipped — no fillable shapes` : '');
    } else {
      const layers: DecalLayer[] = store.decals.map((d) => {
        const asset = store.assetFor(d)!;
        const base: Mask = asset.mask;
        return {
          projector: projectorFromHit(
            d.point,
            d.normal,
            d.widthMm,
            heightOf(d),
            (d.rollDeg * Math.PI) / 180,
          ),
          mask: d.mirrorX ? (u: number, v: number) => base(1 - u, v) : base,
          state: d.state,
        };
      });
      const targetFeatureMm = parseFloat($<HTMLSelectElement>('quality').value);
      const res = stampLayers(tris, layers, { targetFeatureMm });
      if (res.stats.paintedTriangles === 0) {
        say('Nothing was painted. The decals may be off the model or too small for this detail setting.');
        return;
      }
      volumes = [{ name: stlName, tris: res.tris, extruder: base, segments: res.segments }];
      detail =
        `${res.stats.paintedTriangles.toLocaleString()} of ${res.stats.triangles.toLocaleString()} triangles painted\n` +
        `Resolved to ${res.stats.effectiveResolutionMm.toFixed(3)} mm · mesh unchanged`;
    }

    const data = build3mf({ volumes, objectName: stlName });
    const clock = new Date().toISOString().slice(11, 19).replace(/:/g, '');
    downloadBlob(data, `${stlName}-${parts ? 'parts' : 'paint'}-${clock}.3mf`);

    const tools = [...new Set(store.decals.map((d) => d.state))].sort().join(', ');
    say(
      `Exported in ${Math.round(performance.now() - t0)} ms · ${BUILD}\n` +
        `${store.decals.length} decal(s) on toolhead ${tools}\n` +
        `${detail}\n${(data.length / 1024).toFixed(0)} KB`,
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
renderAssets();
renderPanel();

$<HTMLButtonElement>('updateReload').onclick = () => location.reload();
watchForNewBuild(() => {
  $<HTMLDivElement>('update').hidden = false;
});
