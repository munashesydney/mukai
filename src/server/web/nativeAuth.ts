import type { IncomingMessage } from 'node:http';
import { localBrowserRequest, nativeClientRequest } from './origin';
import { matches } from './session';

const authenticated = new WeakSet<IncomingMessage>();

/** Capture bearer authentication before browser cookies are translated into API credentials. */
export function authenticateNativeApiRequest(request: IncomingMessage, token: string) {
  // Packaged Electron may omit Origin on fetch while sending file:// on WebSocket.
  const native =
    nativeClientRequest(request) || (!request.headers.origin && localBrowserRequest(request));
  if (!native || !matches(request.headers.authorization || '', `Bearer ${token}`)) return false;
  authenticated.add(request);
  return true;
}

export function nativeAuthenticatedRequest(request: IncomingMessage) {
  return authenticated.has(request);
}
