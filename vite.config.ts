import { defineConfig } from 'vite';

export default defineConfig({
  base: '/scrubby-dub/',
  build: {
    outDir: 'docs',
    emptyOutDir: true,
  },
});
