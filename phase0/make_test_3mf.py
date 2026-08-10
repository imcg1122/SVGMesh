"""
Phase 0 validation: generate a painted 3MF from scratch and see whether
PrusaSlicer accepts it.

Builds a 40mm cube with three painted test patterns, one per visible face:

  TOP   (+Z)  a circle                    -> extruder 2
  FRONT (-Y)  four vertical stripes       -> extruders 2, 3, 4, 5
  RIGHT (+X)  a ring / annulus            -> extruder 3

The FRONT face is the important one: extruders 4 and 5 are color indices 3 and
4, which force the 0xC extended-color encoding. That is the branch most likely
to be wrong, and the one a 5-toolhead XL hits constantly.

Two variants are written so the crispness tradeoff can be compared directly:

  A. coarse geometry (12 triangles) + deep quadtree
  B. pre-subdivided geometry + shallow quadtree

Same nominal resolution, very different file size and edge quality.
"""

import math
import os
import zipfile

from mmu_codec import Node, encode, build_tree, subdivide4

SIZE = 40.0
OUT_DIR = os.path.dirname(os.path.abspath(__file__))


# --------------------------------------------------------------------------
# Paint pattern
# --------------------------------------------------------------------------

def classify(p):
    """Map a point on the cube surface to a color index (0 = unpainted)."""
    x, y, z = p
    eps = 1e-6
    c = SIZE / 2.0

    # TOP face: circle, extruder 2 -> color index 1
    if abs(z - SIZE) < eps:
        if math.hypot(x - c, y - c) <= 12.0:
            return 1
        return 0

    # FRONT face: four stripes -> extruders 2,3,4,5 = color indices 1,2,3,4
    if abs(y) < eps:
        if 4.0 <= z <= 36.0:
            band = (x - 4.0) / 8.0
            if 0 <= band < 4:
                idx = int(band)
                # 1mm gutter between stripes so boundaries are visible
                if (x - 4.0) % 8.0 > 1.0:
                    return idx + 1
        return 0

    # RIGHT face: annulus, extruder 3 -> color index 2
    if abs(x - SIZE) < eps:
        r = math.hypot(y - c, z - c)
        if 8.0 <= r <= 15.0:
            return 2
        return 0

    return 0


# --------------------------------------------------------------------------
# Geometry
# --------------------------------------------------------------------------

def cube_triangles():
    """A 40mm cube as 12 triangles with outward-facing winding."""
    s = SIZE
    v = [(0, 0, 0), (s, 0, 0), (s, s, 0), (0, s, 0),
         (0, 0, s), (s, 0, s), (s, s, s), (0, s, s)]
    faces = [
        (0, 3, 2), (0, 2, 1),   # bottom -Z
        (4, 5, 6), (4, 6, 7),   # top    +Z
        (0, 1, 5), (0, 5, 4),   # front  -Y
        (2, 3, 7), (2, 7, 6),   # back   +Y
        (1, 2, 6), (1, 6, 5),   # right  +X
        (3, 0, 4), (3, 4, 7),   # left   -X
    ]
    return [(v[a], v[b], v[c]) for a, b, c in faces]


def presubdivide(tris, levels):
    """Midpoint-subdivide every triangle `levels` times (4^levels each)."""
    for _ in range(levels):
        out = []
        for (a, b, c) in tris:
            out.extend(subdivide4(a, b, c))
        tris = out
    return tris


# --------------------------------------------------------------------------
# 3MF writing
# --------------------------------------------------------------------------

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
"""

RELS = """<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
"""


def build_model_xml(tris, max_depth):
    """Weld vertices, paint each triangle, emit 3dmodel.model. Returns (xml, stats)."""
    index = {}
    verts = []

    def vid(p):
        key = (round(p[0], 6), round(p[1], 6), round(p[2], 6))
        if key not in index:
            index[key] = len(verts)
            verts.append(key)
        return index[key]

    tri_lines = []
    painted = 0
    total_leaves = 0
    deepest = 0

    for (a, b, c) in tris:
        ia, ib, ic = vid(a), vid(b), vid(c)
        tree = build_tree(a, b, c, classify, max_depth).prune()
        seg = encode(tree)
        total_leaves += tree.leaf_count()
        deepest = max(deepest, tree.max_depth())
        if seg:
            painted += 1
            tri_lines.append(
                f'   <triangle v1="{ia}" v2="{ib}" v3="{ic}" '
                f'slic3rpe:mmu_segmentation="{seg}"/>'
            )
        else:
            tri_lines.append(f'   <triangle v1="{ia}" v2="{ib}" v3="{ic}"/>')

    vert_lines = [
        f'   <vertex x="{x:.6f}" y="{y:.6f}" z="{z:.6f}"/>' for (x, y, z) in verts
    ]

    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<model unit="millimeter" xml:lang="en-US"\n'
        '       xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"\n'
        '       xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">\n'
        ' <metadata name="slic3rpe:Version3mf">1</metadata>\n'
        ' <metadata name="slic3rpe:MmPaintingVersion">1</metadata>\n'
        ' <metadata name="Application">MeshStamp Phase 0</metadata>\n'
        ' <resources>\n'
        '  <object id="1" type="model">\n'
        '   <mesh>\n'
        '    <vertices>\n' + "\n".join(vert_lines) + '\n    </vertices>\n'
        '    <triangles>\n' + "\n".join(tri_lines) + '\n    </triangles>\n'
        '   </mesh>\n'
        '  </object>\n'
        ' </resources>\n'
        ' <build>\n'
        '  <item objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>\n'
        ' </build>\n'
        '</model>\n'
    )

    stats = {
        "vertices": len(verts),
        "triangles": len(tris),
        "painted_triangles": painted,
        "leaves": total_leaves,
        "max_tree_depth": deepest,
    }
    return xml, stats


def build_model_config(n_tris):
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<config>\n'
        ' <object id="1" instances_count="1">\n'
        '  <metadata type="object" key="name" value="MeshStamp Phase 0 Test"/>\n'
        f'  <volume firstid="0" lastid="{n_tris - 1}">\n'
        '   <metadata type="volume" key="name" value="test_cube"/>\n'
        '   <metadata type="volume" key="volume_type" value="ModelPart"/>\n'
        '   <metadata type="volume" key="extruder" value="1"/>\n'
        '   <mesh edges_fixed="0" degenerate_facets="0" facets_removed="0"'
        ' facets_reversed="0" backwards_edges="0"/>\n'
        '  </volume>\n'
        ' </object>\n'
        '</config>\n'
    )


def write_3mf(path, tris, max_depth):
    xml, stats = build_model_xml(tris, max_depth)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", RELS)
        z.writestr("3D/3dmodel.model", xml)
        z.writestr("Metadata/Slic3r_PE_model.config", build_model_config(len(tris)))
    stats["file_kb"] = os.path.getsize(path) / 1024.0
    return stats


def report(label, path, stats):
    print(f"\n{label}")
    print(f"  file              {os.path.basename(path)}")
    print(f"  vertices          {stats['vertices']}")
    print(f"  triangles         {stats['triangles']}")
    print(f"  painted triangles {stats['painted_triangles']}")
    print(f"  quadtree leaves   {stats['leaves']}")
    print(f"  max tree depth    {stats['max_tree_depth']}")
    print(f"  size              {stats['file_kb']:.1f} KB")


if __name__ == "__main__":
    base = cube_triangles()

    a_path = os.path.join(OUT_DIR, "test_A_coarse_deeptree.3mf")
    report("VARIANT A - coarse geometry (12 tris) + deep quadtree (depth 7)",
           a_path, write_3mf(a_path, base, max_depth=7))

    b_tris = presubdivide(base, levels=3)   # 12 -> 768 triangles
    b_path = os.path.join(OUT_DIR, "test_B_presubdiv_shallowtree.3mf")
    report("VARIANT B - pre-subdivided geometry (768 tris) + quadtree (depth 4)",
           b_path, write_3mf(b_path, b_tris, max_depth=4))

    print("\nOpen both in PrusaSlicer with an XL 5-toolhead profile.")
    print("Check: does the paint appear, and does the FRONT face show four")
    print("distinct stripes on extruders 2, 3, 4 and 5?")
