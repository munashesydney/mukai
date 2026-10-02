import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4318', rewrite: (path) => path.replace(/^\/api/, '') },
    },
  },
  build: { outDir: '../../dist/web', emptyOutDir: true },
});
