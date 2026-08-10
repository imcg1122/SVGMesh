/**
 * SVGMesh MVP.
 *
 * Load an STL, load an SVG, click the model to place the decal, export a 3MF
 * with the decal already assigned to a toolhead.
 *
 * Placement preview is a textured quad floating just above the surface — that
 * gives instant feedback while dragging sliders. The real projection and paint
 * encoding only runs on export, which keeps interaction responsive on meshes
 * where a full re-stamp would take seconds.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';

import type { Tri, Vec3 } from './mmu/codec.ts';
import { boundingBox, parseSTL, trisToPositions } from './io/stl.ts';
import { build3mf, downloadBlob } from './io/threemf.ts';
import { rasterizeSvg, type SvgMask } from './paint/svgMask.ts';
import { projectorFromHit, stamp } from './paint/stamp.ts';

// Accelerated raycasting — essential once meshes get into six figures.
// three-mesh-bvh monkey-patches these onto Three's prototypes at runtime, which
// TypeScript can't model without a module augmentation that may or may not
// duplicate the library's own. Casting keeps this working across versions.
/* eslint-disable @typescript-eslint/no-explicit-any */
(THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree;
(THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree;
(THREE.Mesh.prototype as any).raycast = acceleratedRaycast;

// --- state -----------------------------------------------------------------

let tris: Tri[] = [];
let mesh: THREE.Mesh | null = null;
let svg: SvgMask | null = null;
let svgText = '';
let stlName = 'model';

let hitPoint: Vec3 | null = null;
let hitNormal: Vec3 | null = null;

/**
 * Bump this whenever behaviour changes. It's shown in the panel and stamped
 * into exported filenames, so "which build produced this file?" is never a
 * guess — a stale cached page cost us a debugging round trip once already.
 */
export const BUILD = 'v0.2.0 mesh-preserving';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusEl = $<HTMLDivElement>('status');
const hintEl = $<HTMLDivElement>('hint');
const exportBtn = $<HTMLButtonElement>('export');

const say = (msg: string) => {
  statusEl.textContent = msg;
};

$<HTMLDivElement>('version').textContent = BUILD;

// --- scene -----------------------------------------------------------------

const view = $<HTMLDivElement>('view');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b1f24);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
camera.position.set(60, -80, 60);
camera.up.set(0, 0, 1);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
view.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(1, -1, 2);
scene.add(key);
const grid = new THREE.GridHelper(400, 40, 0x3a424c, 0x2a3038);
grid.rotation.x = Math.PI / 2;
scene.add(grid);

const modelMat = new THREE.MeshStandardMaterial({
  color: 0xff8000,
  roughness: 0.75,
  metalness: 0.0,
  flatShading: false,
});

// Preview quad for the decal.
const decalMat = new THREE.MeshBasicMaterial({
  transparent: true,
  depthTest: false,
  side: THREE.DoubleSide,
});
const decal = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), decalMat);
decal.visible = false;
decal.renderOrder = 2;
scene.add(decal);

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

// --- model loading ---------------------------------------------------------

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
  decal.visible = false;
  hitPoint = null;
  hintEl.textContent = 'Click the model to place the decal';
  say(`Loaded ${stlName} — ${tris.length.toLocaleString()} triangles.\nClick the model to place the decal.`);
  refreshExport();
});

function frameModel(): void {
  const { min, max } = boundingBox(tris);
  const c = new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  const span = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 10;
  controls.target.copy(c);
  camera.position.set(c.x + span * 1.2, c.y - span * 1.6, c.z + span * 1.2);
  camera.near = span / 500;
  camera.far = span * 100;
  camera.updateProjectionMatrix();
  controls.update();
  grid.position.set(c.x, c.y, min[2]);
}

// --- SVG loading -----------------------------------------------------------

$<HTMLInputElement>('svg').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  svgText = await file.text();
  try {
    svg = await rasterizeSvg(svgText);
  } catch (err) {
    say(`Could not rasterize that SVG.\n${(err as Error).message}`);
    return;
  }

  const tex = new THREE.CanvasTexture(svg.preview);
  tex.colorSpace = THREE.SRGBColorSpace;
  decalMat.map = tex;
  decalMat.needsUpdate = true;

  say(`Loaded ${file.name} (aspect ${svg.aspect.toFixed(2)}).`);
  updateDecal();
  refreshExport();
});

// --- placement -------------------------------------------------------------

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let dragged = false;

renderer.domElement.addEventListener('pointerdown', () => {
  dragged = false;
});
renderer.domElement.addEventListener('pointermove', () => {
  dragged = true;
});
renderer.domElement.addEventListener('pointerup', (ev) => {
  if (dragged || !mesh) return;

  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const hit = raycaster.intersectObject(mesh, true)[0];
  if (!hit || !hit.face) return;

  hitPoint = [hit.point.x, hit.point.y, hit.point.z];
  const n = hit.face.normal.clone().normalize();
  hitNormal = [n.x, n.y, n.z];
  updateDecal();
  refreshExport();
  say(
    `Placed at ${hitPoint.map((v) => v.toFixed(1)).join(', ')}.\n` +
      'Adjust size and rotation, then export.',
  );
});

function decalSize(): { w: number; h: number } {
  const w = parseFloat($<HTMLInputElement>('size').value);
  return { w, h: w / (svg?.aspect ?? 1) };
}

function updateDecal(): void {
  if (!hitPoint || !hitNormal || !svg) {
    decal.visible = false;
    return;
  }
  const { w, h } = decalSize();
  const roll = (parseFloat($<HTMLInputElement>('rot').value) * Math.PI) / 180;
  const proj = projectorFromHit(hitPoint, hitNormal, w, h, roll);

  const basis = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(...proj.right),
    new THREE.Vector3(...proj.up),
    new THREE.Vector3(-proj.direction[0], -proj.direction[1], -proj.direction[2]),
  );

  decal.geometry.dispose();
  decal.geometry = new THREE.PlaneGeometry(w, h);
  decal.quaternion.setFromRotationMatrix(basis);
  // Float slightly proud of the surface so it doesn't z-fight.
  const lift = Math.max(w, h) * 0.004;
  decal.position.set(
    hitPoint[0] - proj.direction[0] * lift,
    hitPoint[1] - proj.direction[1] * lift,
    hitPoint[2] - proj.direction[2] * lift,
  );
  decal.visible = true;
}

for (const id of ['size', 'rot']) {
  $<HTMLInputElement>(id).addEventListener('input', () => {
    $<HTMLSpanElement>('sizeVal').textContent = `${parseFloat($<HTMLInputElement>('size').value).toFixed(1)} mm`;
    $<HTMLSpanElement>('rotVal').textContent = `${$<HTMLInputElement>('rot').value}°`;
    updateDecal();
  });
}

function refreshExport(): void {
  exportBtn.disabled = !(mesh && svg && hitPoint);
}

// --- export ----------------------------------------------------------------

exportBtn.addEventListener('click', async () => {
  if (!svg || !hitPoint || !hitNormal) return;

  const targetFeatureMm = parseFloat($<HTMLSelectElement>('quality').value);
  const state = parseInt($<HTMLSelectElement>('extruder').value, 10);
  const base = parseInt($<HTMLSelectElement>('base').value, 10);

  if (state === base) {
    say('The decal and the model are on the same toolhead, so the decal will be invisible.\nPick a different toolhead for one of them.');
    return;
  }

  exportBtn.disabled = true;
  say('Projecting…');
  await new Promise((r) => setTimeout(r, 16)); // let the UI paint before we block

  try {
    const { w, h } = decalSize();
    const roll = (parseFloat($<HTMLInputElement>('rot').value) * Math.PI) / 180;
    const t0 = performance.now();

    const result = stamp(tris, {
      projector: projectorFromHit(hitPoint, hitNormal, w, h, roll),
      mask: svg.mask,
      state,
      targetFeatureMm,
    });

    if (result.stats.paintedTriangles === 0) {
      say(
        'Nothing was painted.\nThe decal may be off the edge of the model, on a face angled away ' +
          'from the camera, or too small for the current detail setting.',
      );
      exportBtn.disabled = false;
      return;
    }

    const data = build3mf({
      tris: result.tris,
      segments: result.segments,
      baseExtruder: base,
      objectName: stlName,
    });
    // Detail and a timestamp in the filename so successive exports never
    // overwrite or get confused with each other.
    const stampId = new Date().toISOString().slice(11, 19).replace(/:/g, '');
    downloadBlob(data, `${stlName}-th${state}-${targetFeatureMm}mm-${stampId}.3mf`);

    const ms = Math.round(performance.now() - t0);
    const s = result.stats;
    say(
      `Exported in ${ms} ms  ·  ${BUILD}\n` +
        `${s.paintedTriangles.toLocaleString()} of ${s.triangles.toLocaleString()} triangles painted ` +
        `on toolhead ${state}\n` +
        `Resolved to ${s.effectiveResolutionMm.toFixed(3)} mm (tree depth ${s.maxTreeDepth})\n` +
        `${(data.length / 1024).toFixed(0)} KB — mesh unchanged, no repair needed`,
    );
  } catch (err) {
    say(`Export failed.\n${(err as Error).message}`);
  } finally {
    exportBtn.disabled = false;
  }
});
