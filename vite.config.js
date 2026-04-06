import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  server: {
    port: 3002,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        babylon: resolve(__dirname, 'babylon.html'),
      },
    },
  },
  assetsInclude: ['**/*.pmx', '**/*.pmd', '**/*.vmd', '**/*.vpd', '**/*.bpmx', '**/*.bvmd'],
  optimizeDeps: {
    exclude: ['babylon-mmd'],
  },
});
