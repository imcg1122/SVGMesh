import { defineConfig } from 'vite';

// GitHub Pages serves project sites from /<repo>/, so assets need that base.
// Override with BASE_PATH=/ when serving from a custom domain or root.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/SVGMesh/',
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
  },
});
