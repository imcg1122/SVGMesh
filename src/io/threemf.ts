/**
 * 3MF writer producing PrusaSlicer-compatible painted files.
 *
 * A 3MF is a zip. PrusaSlicer reads paint data from the `slic3rpe:mmu_segmentation`
 * attribute on triangles in `3D/3dmodel.model`, and per-volume extruder assignment
 * from `Metadata/Slic3r_PE_model.config`.
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

export interface Write3mfOptions {
  tris: Tri[];
  /** One segmentation string per triangle; '' or undefined means unpainted. */
  segments: (string | undefined)[];
  /** Extruder the unpainted body prints with. */
  baseExtruder?: number;
  objectName?: string;
}

/** Weld duplicate vertices. STL is triangle soup; 3MF wants an indexed mesh. */
function weld(tris: Tri[]): { verts: Vec3[]; faces: [number, number, number][] } {
  const index = new Map<string, number>();
  const verts: Vec3[] = [];
  const faces: [number, number, number][] = [];

  const id = (p: Vec3): number => {
    // 6dp is well below printable resolution and avoids float noise splitting seams.
    const k = `${p[0].toFixed(6)},${p[1].toFixed(6)},${p[2].toFixed(6)}`;
    let i = index.get(k);
    if (i === undefined) {
      i = verts.length;
      index.set(k, i);
      verts.push(p);
    }
    return i;
  };

  for (const t of tris) faces.push([id(t[0]), id(t[1]), id(t[2])]);
  return { verts, faces };
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function build3mf(opts: Write3mfOptions): Uint8Array {
  const { tris, segments, baseExtruder = 1, objectName = 'SVGMesh model' } = opts;
  const { verts, faces } = weld(tris);

  const vertXml = verts
    .map((v) => `   <vertex x="${v[0].toFixed(6)}" y="${v[1].toFixed(6)}" z="${v[2].toFixed(6)}"/>`)
    .join('\n');

  const triXml = faces
    .map((f, i) => {
      const seg = segments[i];
      const paint = seg ? ` slic3rpe:mmu_segmentation="${seg}"` : '';
      return `   <triangle v1="${f[0]}" v2="${f[1]}" v3="${f[2]}"${paint}/>`;
    })
    .join('\n');

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
${vertXml}
    </vertices>
    <triangles>
${triXml}
    </triangles>
   </mesh>
  </object>
 </resources>
 <build>
  <item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>
 </build>
</model>`;

  const config = `<?xml version="1.0" encoding="UTF-8"?>
<config>
 <object id="1" instances_count="1">
  <metadata type="object" key="name" value="${esc(objectName)}"/>
  <volume firstid="0" lastid="${faces.length - 1}">
   <metadata type="volume" key="name" value="${esc(objectName)}"/>
   <metadata type="volume" key="volume_type" value="ModelPart"/>
   <metadata type="volume" key="extruder" value="${baseExtruder}"/>
   <mesh edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
  </volume>
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
  const blob = new Blob([data as BlobPart], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
