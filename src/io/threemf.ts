/**
 * 3MF writer producing PrusaSlicer-compatible files, in either output mode.
 *
 * PrusaSlicer represents a multi-part object as ONE merged mesh plus a config
 * file that carves it into volumes by triangle index range. So a model with
 * three decal parts is a single `<object>` whose triangles are the model's
 * followed by each decal's, with `Slic3r_PE_model.config` declaring
 * `firstid`/`lastid` spans and a per-volume extruder.
 *
 * That's what makes parts appear in PrusaSlicer's object tree with their own
 * toolhead dropdown, and what lets smart fill and bucket fill work on them —
 * they're real geometry, not per-triangle metadata.
 *
 * Paint mode instead emits a single volume carrying `slic3rpe:mmu_segmentation`
 * attributes. Both can be combined in one file.
 */

import { zipSync, strToU8 } from 'fflate';
import type { Tri, Vec3 } from '../mmu/codec.ts';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

export interface Volume {
  name: string;
  tris: Tri[];
  /** Toolhead this volume prints with. */
  extruder: number;
  /** Optional per-triangle MMU paint, index-aligned with `tris`. */
  segments?: (string | undefined)[];
}

export interface Write3mfOptions {
  volumes: Volume[];
  objectName?: string;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmt = (n: number) => n.toFixed(6);

export function build3mf(opts: Write3mfOptions): Uint8Array {
  const { volumes, objectName = 'SVGMesh model' } = opts;
  if (volumes.length === 0) throw new Error('a 3MF needs at least one volume');

  // Weld across the whole merged mesh. STL is triangle soup and 3MF wants an
  // indexed mesh; 6dp is well below printable resolution and stops float noise
  // splitting seams.
  const index = new Map<string, number>();
  const verts: Vec3[] = [];
  const vid = (p: Vec3): number => {
    const k = `${fmt(p[0])},${fmt(p[1])},${fmt(p[2])}`;
    let i = index.get(k);
    if (i === undefined) {
      i = verts.length;
      index.set(k, i);
      verts.push(p);
    }
    return i;
  };

  const triLines: string[] = [];
  const spans: { first: number; last: number; v: Volume }[] = [];

  for (const v of volumes) {
    if (v.tris.length === 0) continue;
    const first = triLines.length;
    v.tris.forEach((t, i) => {
      const seg = v.segments?.[i];
      const paint = seg ? ` slic3rpe:mmu_segmentation="${seg}"` : '';
      triLines.push(
        `   <triangle v1="${vid(t[0])}" v2="${vid(t[1])}" v3="${vid(t[2])}"${paint}/>`,
      );
    });
    spans.push({ first, last: triLines.length - 1, v });
  }

  const vertLines = verts.map((v) => `   <vertex x="${fmt(v[0])}" y="${fmt(v[1])}" z="${fmt(v[2])}"/>`);

  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US"
       xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
       xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">
 <metadata name="slic3rpe:Version3mf">1</metadata>
 <metadata name="slic3rpe:MmPaintingVersion">1</metadata>
 <metadata name="Application">SVGMesh</metadata>
 <resources>
  <object id="1" type="model">
   <mesh>
    <vertices>
${vertLines.join('\n')}
    </vertices>
    <triangles>
${triLines.join('\n')}
    </triangles>
   </mesh>
  </object>
 </resources>
 <build>
  <item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>
 </build>
</model>`;

  const volumeXml = spans
    .map(
      ({ first, last, v }) => `  <volume firstid="${first}" lastid="${last}">
   <metadata type="volume" key="name" value="${esc(v.name)}"/>
   <metadata type="volume" key="volume_type" value="ModelPart"/>
   <metadata type="volume" key="extruder" value="${v.extruder}"/>
   <mesh edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
  </volume>`,
    )
    .join('\n');

  const config = `<?xml version="1.0" encoding="UTF-8"?>
<config>
 <object id="1" instances_count="1">
  <metadata type="object" key="name" value="${esc(objectName)}"/>
${volumeXml}
 </object>
</config>`;

  return zipSync(
    {
      '[Content_Types].xml': strToU8(CONTENT_TYPES),
      '_rels/.rels': strToU8(RELS),
      '3D/3dmodel.model': strToU8(model),
      'Metadata/Slic3r_PE_model.config': strToU8(config),
    },
    { level: 6 },
  );
}

export function downloadBlob(data: Uint8Array, filename: string): void {
  const blob = new Blob([data as BlobPart], {
    type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
