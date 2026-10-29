import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultDataDir } from './src/server/config';
import { apiPort, backendOrigin, isDevUiOrigin, webDevPort } from './src/shared/devOrigins';

const env = process.env;

export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  server: {
    // Default 5273, not the Desktop renderer port, so `npm run dev` and `npm run dev:web`
    // can both run against one backend. MUKAI_WEB_PORT overrides it.
    port: webDevPort(env),
    strictPort: true,
    proxy: {
      '/api': {
        // The Desktop app owns 47831; a standalone `npm run dev:server` can use PORT.
        // This UI never starts a backend of its own, so no port or data-directory fight.
        target: `http://127.0.0.1:${apiPort(env)}`,
        // Present the request the way the backend's own web UI does: the backend ties its
        // Host and Origin checks to the port it actually listens on.
        changeOrigin: true,
        ws: true,
        // `/api/...` is forwarded as-is, the same request the built web UI makes.
        configure: (proxy) => {
          proxy.on('proxyReq', (request) => {
            // Only local dev pages get the local token. A request from any other page keeps its
            // own origin and no credentials, so the backend answers 401 instead of acting on it.
            const origin = String(request.getHeader('origin') || '');
            if (origin && !isDevUiOrigin(origin, env)) return;
            request.setHeader('Origin', backendOrigin(env));
            try {
              request.setHeader(
                'Authorization',
                `Bearer ${readFileSync(join(defaultDataDir(), 'api.token')).toString('hex')}`,
              );
            } catch {
              /* The server returns an authentication error until it is started. */
            }
          });
          proxy.on('error', (error) => {
            console.error(
              `[dev:web] No Mukai backend at ${backendOrigin(env)} (${(error as Error).message}). ` +
                'Start `npm run dev` for the Desktop backend, or `npm run dev:server` for a ' +
                'standalone one.',
            );
          });
        },
      },
    },
  },
  build: { outDir: '../../dist/web', emptyOutDir: true },
});
