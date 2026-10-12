import type { IncomingMessage } from 'node:http';

/** Browser origins are explicit; enabling web mode never enables arbitrary loopback origins. */
export function trustedLocalRequest(
  request: IncomingMessage,
  browserMode = false,
  allowFileOrigin = false,
) {
  const host = request.headers.host || '';
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return false;
  if (browserMode && Number(host.split(':')[1] || '80') !== request.socket.localPort) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  if (browserMode) return origin === `http://${host}`;
  return (
    origin === 'null' ||
    (allowFileOrigin && origin === 'file://') ||
    /^http:\/\/(127\.0\.0\.1|localhost):5173$/.test(origin)
  );
}
