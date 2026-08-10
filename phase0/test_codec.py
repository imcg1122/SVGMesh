"""Regression tests for the MMU segmentation codec.

The critical case is extended colors (index >= 3), which is the branch we hit
constantly on a 5-toolhead XL and the least-exercised part of the format.
"""

import sys
from mmu_codec import Node, encode, decode

FAILS = []


def check(name, got, want):
    if got == want:
        print(f"  PASS  {name}")
    else:
        print(f"  FAIL  {name}\n          got:  {got!r}\n          want: {want!r}")
        FAILS.append(name)


def leaf(c):
    return Node(color=c)


print("\n-- documented reference example --")
# From the format docs: root 4-way split, children [c0, c1, c2, c1] -> "48403"
ref = Node(special_side=0, children=[leaf(0), leaf(1), leaf(2), leaf(1)])
check("encode reference tree", encode(ref), "48403")

d = decode("48403")
check("decode: root is a split", d.is_leaf, False)
check("decode: 4 children", len(d.children), 4)
check("decode: child colors", [c.color for c in d.children], [0, 1, 2, 1])


print("\n-- single leaf colors --")
check("color 0 -> omitted", encode(leaf(0)), "")
check("color 1", encode(leaf(1)), "4")
check("color 2", encode(leaf(2)), "8")
check("color 3 (extended)", encode(leaf(3)), "0C")
check("color 4 (extended)", encode(leaf(4)), "1C")
check("color 5 (extended)", encode(leaf(5)), "2C")

for c in range(1, 6):
    check(f"round-trip leaf color {c}", decode(encode(leaf(c))).color, c)


print("\n-- five-toolhead XL: all extruders in one triangle --")
xl = Node(special_side=0, children=[leaf(1), leaf(2), leaf(3), leaf(4)])
s = encode(xl)
back = decode(s)
check("XL 4-way all-extruders round-trip",
      [c.color for c in back.children], [1, 2, 3, 4])
print(f"        encoded as: {s}")


print("\n-- nested subdivision --")
nested = Node(special_side=0, children=[
    Node(special_side=0, children=[leaf(1), leaf(0), leaf(4), leaf(2)]),
    leaf(3),
    Node(special_side=2, children=[leaf(5), leaf(0), leaf(1), leaf(1)]),
    leaf(0),
])
s = encode(nested)
back = decode(s)
check("nested round-trip: outer colors",
      [c.color if c.is_leaf else None for c in back.children],
      [None, 3, None, 0])
check("nested round-trip: inner 0",
      [c.color for c in back.children[0].children], [1, 0, 4, 2])
check("nested round-trip: inner 2",
      [c.color for c in back.children[2].children], [5, 0, 1, 1])
check("nested round-trip: special_side preserved",
      back.children[2].special_side, 2)
print(f"        encoded as: {s}")


print("\n-- partial splits (2-way and 3-way) --")
two = Node(special_side=1, children=[leaf(2), leaf(4)])
check("2-way round-trip", [c.color for c in decode(encode(two)).children], [2, 4])
check("2-way special_side", decode(encode(two)).special_side, 1)

three = Node(special_side=2, children=[leaf(1), leaf(3), leaf(0)])
check("3-way round-trip", [c.color for c in decode(encode(three)).children], [1, 3, 0])


print("\n-- pruning --")
uniform = Node(special_side=0, children=[leaf(2), leaf(2), leaf(2), leaf(2)])
check("uniform subtree collapses to a leaf", uniform.prune().is_leaf, True)
check("collapsed leaf keeps the color", uniform.prune().color, 2)

mixed = Node(special_side=0, children=[leaf(2), leaf(2), leaf(1), leaf(2)])
check("mixed subtree survives pruning", mixed.prune().is_leaf, False)


print("\n-- malformed input is rejected --")
try:
    decode("3")          # claims 4 children, provides none
    check("truncated input raises", False, True)
except ValueError:
    check("truncated input raises", True, True)

try:
    decode("444")        # three leaves, no parent to consume them
    check("trailing data raises", False, True)
except ValueError:
    check("trailing data raises", True, True)


print()
if FAILS:
    print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
    sys.exit(1)
print("All codec tests passed.")
