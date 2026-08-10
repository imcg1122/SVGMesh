/**
 * three-mesh-bvh patches methods onto Three.js prototypes at runtime.
 * These declarations tell TypeScript about them.
 */

import type { MeshBVH } from 'three-mesh-bvh';

declare module 'three' {
  interface BufferGeometry {
    boundsTree?: MeshBVH;
    computeBoundsTree(options?: object): void;
    disposeBoundsTree(): void;
  }
}

export {};
