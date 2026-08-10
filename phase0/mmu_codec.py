"""
PrusaSlicer / OrcaSlicer MMU segmentation codec.

Encodes and decodes the per-triangle quadtree stored in the
`slic3rpe:mmu_segmentation` attribute (PrusaSlicer) / `paint_color` (OrcaSlicer)
of triangle elements inside a 3MF's 3D/3dmodel.model.

Format (see wiki/MMU-Segmentation-Format.md in coreynguyen/prusa_mmu_painter):

  - The hex string is read BACKWARDS. The last character is the root node.
  - Each nibble: low 2 bits = split type, high 2 bits = color or special-side.
      split 0 -> leaf (0 children)
      split 1 -> 2 children   split 2 -> 3 children   split 3 -> 4 children
  - Leaf colors 0,1,2 encode directly as 0x0, 0x4, 0x8.
    Color >= 3 encodes as marker 0xC followed by an extension nibble (color-3).
  - Non-leaf: high 2 bits are the "special side" (which edge the split favours).
  - Children are written pre-order, parent before children.
  - 4-way child order is: 0=Center, 1=Corner2, 2=Corner1, 3=Corner0.

Color index 0 means "unpainted" -> falls back to the object's own extruder.
Color index N means extruder N+1 in PrusaSlicer's 1-based UI numbering.
"""

from dataclasses import dataclass, field
from typing import List, Optional


# --------------------------------------------------------------------------
# Tree model
# --------------------------------------------------------------------------

@dataclass
class Node:
    """A node in a triangle's subdivision quadtree."""
    color: int = 0                      # meaningful only when children is empty
    special_side: int = 0               # meaningful only when children is non-empty
    children: List["Node"] = field(default_factory=list)

    @property
    def is_leaf(self) -> bool:
        return not self.children

    def prune(self) -> "Node":
        """Collapse subtrees whose leaves all share one color. Big size win."""
        if self.is_leaf:
            return self
        self.children = [c.prune() for c in self.children]
        if all(c.is_leaf for c in self.children):
            first = self.children[0].color
            if all(c.color == first for c in self.children):
                return Node(color=first)
        return self

    def leaf_count(self) -> int:
        if self.is_leaf:
            return 1
        return sum(c.leaf_count() for c in self.children)

    def max_depth(self) -> int:
        if self.is_leaf:
            return 0
        return 1 + max(c.max_depth() for c in self.children)


# --------------------------------------------------------------------------
# Encode
# --------------------------------------------------------------------------

def encode(root: Node) -> str:
    """Serialize a quadtree to its hex string. Returns '' for an unpainted leaf."""
    if root.is_leaf and root.color == 0:
        return ""  # unpainted: omit the attribute entirely

    buf: List[int] = []
    _encode_node(root, buf)
    buf.reverse()
    return "".join(f"{n:X}" for n in buf)


def _encode_node(node: Node, buf: List[int]) -> None:
    if node.is_leaf:
        if node.color < 3:
            buf.append(node.color << 2)
        else:
            buf.append(0xC)              # extended-color marker
            buf.append(node.color - 3)   # extension nibble
        return

    split_type = len(node.children) - 1
    if not 1 <= split_type <= 3:
        raise ValueError(f"node has {len(node.children)} children; must be 2-4")
    buf.append((node.special_side << 2) | split_type)
    for child in node.children:          # pre-order: parent already written
        _encode_node(child, buf)


# --------------------------------------------------------------------------
# Decode
# --------------------------------------------------------------------------

class _BackwardReader:
    def __init__(self, s: str):
        self.s = s
        self.pos = len(s) - 1

    def next_nibble(self) -> int:
        if self.pos < 0:
            raise ValueError("ran off the start of the string; malformed input")
        v = int(self.s[self.pos], 16)
        self.pos -= 1
        return v

    @property
    def exhausted(self) -> bool:
        return self.pos < 0


def decode(s: str) -> Node:
    """Parse a hex string back into a quadtree."""
    if not s:
        return Node(color=0)
    r = _BackwardReader(s)
    root = _decode_node(r)
    if not r.exhausted:
        raise ValueError(
            f"trailing data: {r.pos + 1} nibble(s) unconsumed in {s!r}"
        )
    return root


def _decode_node(r: _BackwardReader) -> Node:
    nibble = r.next_nibble()
    split_type = nibble & 0b11
    upper = nibble >> 2

    if split_type == 0:
        color = upper
        if color == 3:                       # extended
            color = r.next_nibble() + 3
        return Node(color=color)

    n_children = split_type + 1
    children = [_decode_node(r) for _ in range(n_children)]
    return Node(special_side=upper, children=children)


# --------------------------------------------------------------------------
# Geometry: 4-way subdivision matching PrusaSlicer's child ordering
# --------------------------------------------------------------------------

def subdivide4(v0, v1, v2):
    """
    Split a triangle 4 ways, returning children in PrusaSlicer's expected order.

            v0
            /\\
        t01/__\\t20
          /\\  /\\
         /__\\/__\\
        v1  t12   v2

    Order: 0=Center, 1=Corner2, 2=Corner1, 3=Corner0
    """
    t01 = _mid(v0, v1)
    t12 = _mid(v1, v2)
    t20 = _mid(v2, v0)
    return [
        (t01, t12, t20),   # 0 Center
        (t12, v2,  t20),   # 1 Corner2
        (t01, v1,  t12),   # 2 Corner1
        (v0,  t01, t20),   # 3 Corner0
    ]


def _mid(a, b):
    return ((a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5)


def _centroid(a, b, c):
    return ((a[0] + b[0] + c[0]) / 3.0,
            (a[1] + b[1] + c[1]) / 3.0,
            (a[2] + b[2] + c[2]) / 3.0)


def build_tree(v0, v1, v2, classify, max_depth: int, depth: int = 0) -> Node:
    """
    Adaptively subdivide a triangle against a classifier.

    `classify(point) -> color index`. We sample the three corners and the
    centroid; if they all agree we stop, otherwise we split and recurse until
    max_depth. Corner-only sampling misses thin features that pass through the
    middle of a triangle, which is why the centroid is included.
    """
    samples = [classify(v0), classify(v1), classify(v2),
               classify(_centroid(v0, v1, v2))]

    if len(set(samples)) == 1:
        return Node(color=samples[0])

    if depth >= max_depth:
        # Out of budget: majority vote, ties break toward the centroid sample.
        return Node(color=max(set(samples), key=samples.count))

    children = [
        build_tree(a, b, c, classify, max_depth, depth + 1)
        for (a, b, c) in subdivide4(v0, v1, v2)
    ]
    return Node(special_side=0, children=children).prune()
