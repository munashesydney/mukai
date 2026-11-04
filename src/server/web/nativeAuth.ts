import type { IncomingMessage } from 'node:http';
import { localBrowserRequest, nativeClientRequest, trustedLocalRequest } from './origin';
import { matches } from './session';

const authenticated = new WeakSet<IncomingMessage>();

/** Authenticate native HTTP calls before browser cookies become API credentials. */
export function authenticateNativeApiRequest(request: IncomingMessage, token: string) {
  // Packaged Electron may omit Origin on fetch while sending file:// on WebSocket.
  // Remote native clients also omit Origin. Require the explicit owner token and
  // the existing Host validation; Origin-bearing browsers retain their policy.
  const native =
    nativeClientRequest(request) || (!request.headers.origin && trustedLocalRequest(request, true));
  if (!native || !matches(request.headers.authorization || '', `Bearer ${token}`)) return false;
  // Only local renderers get native viewer tickets. Remote API authentication
  // does not change the desktop/audio WebSocket origin and cookie requirements.
  if (nativeClientRequest(request) || localBrowserRequest(request)) authenticated.add(request);
  return true;
}

/** Local native-renderer credentials, used by the desktop/audio ticket policy. */
export function nativeAuthenticatedRequest(request: IncomingMessage) {
  return authenticated.has(request);
}
