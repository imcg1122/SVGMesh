"""
Toolhead mapping probe — settles state -> extruder indexing once and for all.

Ian's report on the first test cubes implied a one-off shift between the state
value we write and the toolhead PrusaSlicer assigns. Panda2Prusa's source says
"state 0 is the volume's extruder; state N paints extruder N" (direct mapping).
Those two disagree, so this file makes the answer readable at a glance.

Layout: a 120 x 20 x 3 mm bar. Six square patches painted on the top face,
left to right, using states 1, 2, 3, 4, 5, 6. Nothing else is painted.
The object's own extruder is 1.

  patch #     1    2    3    4    5    6
  state       1    2    3    4    5    6
  x centre   10   30   50   70   90  110   (mm, left to right)

How to read the result in PrusaSlicer:

  DIRECT mapping   -> patch 1 is invisible (state 1 = extruder 1 = the object's
                      own extruder). Patches 2-5 are toolheads 2, 3, 4, 5.
                      Patch 6 asks for a nonexistent toolhead 6.

  SHIFTED mapping  -> patch 1 is invisible (asks for toolhead 0).
                      Patches 2-6 are toolheads 1, 2, 3, 4, 5.

The single distinguishing question: **what toolhead is the SECOND patch from
the left?** Toolhead 2 means direct. Toolhead 1 means shifted.
Cross-check: if the rightmost patch prints at all, the mapping is shifted.
"""

import os
import zipfile

from mmu_codec import encode, build_tree, subdivide4
from make_test_3mf import CONTENT_TYPES, RELS

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

LEN_X, LEN_Y, LEN_Z = 120.0, 20.0, 3.0
PATCH = 14.0
N_PATCHES = 6


def classify(p):
    """Six square patches along the top face, states 1..6 left to right."""
    x, y, z = p
    if abs(z - LEN_Z) > 1e-6:
        return 0
    for i in range(N_PATCHES):
        cx = 10.0 + i * 20.0
        if abs(x - cx) <= PATCH / 2 and abs(y - LEN_Y / 2) <= PATCH / 2:
            return i + 1
    return 0


def bar_triangles():
    X, Y, Z = LEN_X, LEN_Y, LEN_Z
    v = [(0, 0, 0), (X, 0, 0), (X, Y, 0), (0, Y, 0),
         (0, 0, Z), (X, 0, Z), (X, Y, Z), (0, Y, Z)]
    faces = [
        (0, 3, 2), (0, 2, 1),   # bottom
        (4, 5, 6), (4, 6, 7),   # top
        (0, 1, 5), (0, 5, 4),   # front
        (2, 3, 7), (2, 7, 6),   # back
        (1, 2, 6), (1, 6, 5),   # right
        (3, 0, 4), (3, 4, 7),   # left
    ]
    return [(v[a], v[b], v[c]) for a, b, c in faces]


def subdivide_top_only(tris, levels):
    """Only refine the top face; the rest of the bar stays cheap."""
    out = []
    for (a, b, c) in tris:
        if all(abs(p[2] - LEN_Z) < 1e-6 for p in (a, b, c)):
            batch = [(a, b, c)]
            for _ in range(levels):
                nxt = []
                for (p, q, r) in batch:
                    nxt.extend(subdivide4(p, q, r))
                batch = nxt
            out.extend(batch)
        else:
            out.append((a, b, c))
    return out


def write(path, tris, max_depth):
    index, verts = {}, []

    def vid(p):
        k = (round(p[0], 6), round(p[1], 6), round(p[2], 6))
        if k not in index:
            index[k] = len(verts)
            verts.append(k)
        return index[k]

    lines, painted = [], 0
    for (a, b, c) in tris:
        ia, ib, ic = vid(a), vid(b), vid(c)
        seg = encode(build_tree(a, b, c, classify, max_depth).prune())
        if seg:
            painted += 1
            lines.append(f'   <triangle v1="{ia}" v2="{ib}" v3="{ic}" '
                         f'slic3rpe:mmu_segmentation="{seg}"/>')
        else:
            lines.append(f'   <triangle v1="{ia}" v2="{ib}" v3="{ic}"/>')

    vl = [f'   <vertex x="{x:.6f}" y="{y:.6f}" z="{z:.6f}"/>' for x, y, z in verts]
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<model unit="millimeter" xml:lang="en-US"\n'
        '       xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"\n'
        '       xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">\n'
        ' <metadata name="slic3rpe:Version3mf">1</metadata>\n'
        ' <metadata name="slic3rpe:MmPaintingVersion">1</metadata>\n'
        ' <metadata name="Application">MeshStamp toolhead probe</metadata>\n'
        ' <resources>\n  <object id="1" type="model">\n   <mesh>\n'
        '    <vertices>\n' + "\n".join(vl) + '\n    </vertices>\n'
        '    <triangles>\n' + "\n".join(lines) + '\n    </triangles>\n'
        '   </mesh>\n  </object>\n </resources>\n'
        ' <build>\n  <item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>\n'
        ' </build>\n</model>\n'
    )
    cfg = (
        '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n'
        ' <object id="1" instances_count="1">\n'
        '  <metadata type="object" key="name" value="Toolhead mapping probe"/>\n'
        f'  <volume firstid="0" lastid="{len(tris) - 1}">\n'
        '   <metadata type="volume" key="name" value="probe_bar"/>\n'
        '   <metadata type="volume" key="volume_type" value="ModelPart"/>\n'
        '   <metadata type="volume" key="extruder" value="1"/>\n'
        '   <mesh edges_fixed="0" degenerate_facets="0" facets_removed="0"'
        ' facets_reversed="0" backwards_edges="0"/>\n'
        '  </volume>\n </object>\n</config>\n'
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", RELS)
        z.writestr("3D/3dmodel.model", xml)
        z.writestr("Metadata/Slic3r_PE_model.config", cfg)
    return len(verts), len(tris), painted


if __name__ == "__main__":
    tris = subdivide_top_only(bar_triangles(), levels=4)
    path = os.path.join(OUT_DIR, "toolhead_probe.3mf")
    nv, nt, np_ = write(path, tris, max_depth=4)
    print(f"wrote {os.path.basename(path)}")
    print(f"  vertices {nv}  triangles {nt}  painted {np_}"
          f"  size {os.path.getsize(path)/1024:.1f} KB")
    print("\n  patch #   1    2    3    4    5    6")
    print("  state     1    2    3    4    5    6")
    print("  x centre  10   30   50   70   90   110  (mm, left to right)")
    print("\nQuestion to answer: what toolhead is the SECOND patch from the left?")
    print("  toolhead 2 -> direct mapping   |   toolhead 1 -> shifted mapping")
