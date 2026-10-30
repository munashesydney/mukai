import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultDataDir } from './src/server/config';

// Vite decides whether a build is production from one thing only —
// `const isProduction = process.env.NODE_ENV === "production"` in
// vite/dist/node/chunks/config.js — not from the `build` command. So a shell that
// already exported NODE_ENV=development (which is the case for every build started
// from inside a running Mukai app, or from a dev server's own watcher) ships a
// development page, and both halves of that break the browser UI:
//   1. `import.meta.env.DEV` bakes to true, so BrowserAuthGate takes its
//      desktop-dev bypass: no setup code, no session cookie, and every `/api`
//      call answers `401 API authentication required` — the "Cannot reach Mukai's
//      server" banner then blames a backend that is running fine.
//   2. `jsxDev: !isProduction` switches the JSX transform to
//      react/jsx-dev-runtime, whose `jsxDEV` does not exist in the production React
//      that gets bundled: the page throws on mount and renders a blank screen.
// Vite's documented answer is to set NODE_ENV in the config rather than the
// script (keeps it working on Windows cmd, no cross-env dependency). Gating on the
// command keeps `vite serve` / `npm run dev:web` on development semantics.
export default defineConfig(({ command }) => {
  if (command === 'build') process.env.NODE_ENV = 'production';
  return {
    root: 'src/renderer',
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:47831',
          ws: true,
          // The prefix stays on. `/api` is part of the server's public interface —
          // `web/handler.ts` authenticates `/api/auth/*` and `/api/session` there and
          // strips the prefix on its way to the route table — so a request that
          // arrives as `/approvals` is a static-file miss and answers 404 Not found.
          // Rewriting it here sent every dev-mode call to a path that does not exist.
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
  };
});
