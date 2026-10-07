import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultDataDir } from './src/server/config';

export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:47831',
        rewrite: (path) => path.replace(/^\/api/, ''),
        configure: (proxy) =>
          proxy.on('proxyReq', (request) => {
            const origin = String(request.getHeader('origin') || '');
            if (origin && !/^http:\/\/(localhost|127\.0\.0\.1):5173$/.test(origin)) return;
            try {
              request.setHeader(
                'Authorization',
                `Bearer ${readFileSync(join(defaultDataDir(), 'api.token')).toString('hex')}`,
              );
            } catch {
              /* The server returns an authentication error until it is started. */
            }
          }),
      },
    },
  },
  build: { outDir: '../../dist/web', emptyOutDir: true },
});
