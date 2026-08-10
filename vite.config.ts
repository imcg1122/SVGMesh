import { defineConfig } from 'vite';

// GitHub Pages serves project sites from /<repo>/, so assets need that base.
// Change this if the repo is renamed or moved to a custom domain.
export default defineConfig({
  base: '/SVGMesh/',
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
