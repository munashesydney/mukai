/**
 * Loopback dev ports shared by the Vite configs and the backend, so the Desktop app and the
 * browser UI can run at the same time against one backend instead of colliding on a port.
 * Environment is always passed in: this module is shared with renderer code, so it never reads
 * process state itself.
 */

export const DEFAULT_API_PORT = 47831;
/** electron-vite renderer dev server used by `npm run dev`. */
export const DESKTOP_DEV_PORT = 5173;
/** `npm run dev:web`, kept off the Desktop port so both UIs can run together. */
export const WEB_DEV_PORT = 5273;

export type DevEnv = Record<string, string | undefined>;

const LOOPBACK_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}$/;

const validPort = (value: string | undefined): number | undefined => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : undefined;
};

/** Port of an exact loopback http origin, otherwise undefined. */
const loopbackPort = (value: string): number | undefined =>
  LOOPBACK_ORIGIN.test(value) ? validPort(value.slice(value.lastIndexOf(':') + 1)) : undefined;

/** Port the standalone backend binds (`npm run dev:server`). */
export const apiPort = (env: DevEnv): number =>
  validPort(env.MUKAI_API_PORT) ?? validPort(env.PORT) ?? DEFAULT_API_PORT;

/** Port the browser dev UI serves (`npm run dev:web`). */
export const webDevPort = (env: DevEnv): number => validPort(env.MUKAI_WEB_PORT) ?? WEB_DEV_PORT;

/**
 * Origin the backend considers same-origin: what its own served web UI sends. The browser dev
 * proxy presents itself as this origin, because it runs on this machine and authenticates with
 * the same local bearer token.
 */
export const backendOrigin = (env: DevEnv): string => `http://127.0.0.1:${apiPort(env)}`;

/**
 * Loopback ports whose `http://127.0.0.1:<port>` / `http://localhost:<port>` origin a
 * Desktop-owned backend accepts as its own machine.
 * `MUKAI_DEV_ORIGINS` adds entries as a comma-separated list of ports or loopback http origins;
 * anything else is ignored.
 */
export function devOriginPorts(env: DevEnv): number[] {
  const ports = new Set<number>([DESKTOP_DEV_PORT, webDevPort(env)]);
  for (const entry of (env.MUKAI_DEV_ORIGINS ?? '').split(',')) {
    const value = entry.trim();
    if (!value) continue;
    const port = validPort(value) ?? loopbackPort(value);
    if (port) ports.add(port);
  }
  return [...ports];
}

/** True only for an exact loopback http origin on an allowed dev UI port. */
export function isDevUiOrigin(origin: string, env: DevEnv): boolean {
  const port = loopbackPort(origin);
  return port !== undefined && devOriginPorts(env).includes(port);
}

/**
 * Origins a Desktop-owned backend treats as this machine: the dev UIs, plus the backend's own
 * origin, which the browser dev proxy presents on the UI's behalf because it runs here and
 * authenticates with the same local bearer token. Accepting that one extra origin is a
 * cross-site-request check only — every route still requires the token.
 */
export function isDevOrigin(origin: string, env: DevEnv): boolean {
  return isDevUiOrigin(origin, env) || origin === backendOrigin(env);
}
