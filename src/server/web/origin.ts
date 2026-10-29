import type { IncomingMessage } from 'node:http';
import { isDevOrigin } from '../../shared/devOrigins';

/** Served browsers use same-origin requests; native Desktop retains its loopback policy. */
export function trustedLocalRequest(
  request: IncomingMessage,
  browserMode = false,
  allowFileOrigin = false,
) {
  const host = request.headers.host || '';
  if (browserMode && !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
    try {
      const address = new URL('http://' + host);
      if (
        !host ||
        address.host !== host ||
        address.username ||
        address.password ||
        address.pathname !== '/'
      )
        return false;
      const origin = request.headers.origin;
      if (!origin) return true;
      const source = new URL(origin);
      return (
        ['http:', 'https:'].includes(source.protocol) &&
        source.origin === origin &&
        source.host === host
      );
    } catch {
      return false;
    }
  }
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return false;
  if (browserMode && Number(host.split(':')[1] || '80') !== request.socket.localPort) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  if (browserMode) return origin === `http://${host}` || origin === `https://${host}`;
  return (
    origin === 'null' ||
    (allowFileOrigin && origin === 'file://') ||
    // Dev-UI origins, so the Desktop renderer and the browser UI can share one backend.
    isDevOrigin(origin, process.env)
  );
}

export function localBrowserRequest(request: IncomingMessage) {
  return (
    /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(request.headers.host || '') &&
    trustedLocalRequest(request, true)
  );
}
