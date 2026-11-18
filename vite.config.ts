import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      output: {
        entryFileNames: 'index.js',
        assetFileNames: 'style.css',
      },
    },
    minify: false,
    sourcemap: false,
  },
  css: {
    output: 'style.css',
  },
  test: {
    globals: true,
    environment: 'node',
  },
});
