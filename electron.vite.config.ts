import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { DESKTOP_DEV_PORT } from './src/shared/devOrigins';

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    plugins: [react()],
    build: { minify: true },
    // Hold the port the backend trusts instead of sliding to the next one when the browser
    // dev UI is already running; a clash then fails loudly instead of silently changing origin.
    server: { port: DESKTOP_DEV_PORT, strictPort: true },
  },
});
