/**
 * Why this page cannot reach Mukai's server, in terms the user can act on.
 *
 * A rejected `fetch()` hands the renderer one opaque `TypeError`, and every
 * distinct cause — no server listening, a page still open in a browser tab from
 * a dev server that has since exited, a page on an origin the server will not
 * answer, a desktop window whose preload never loaded — surfaced as the same
 * banner telling the user to start a backend that was usually already running.
 *
 * The renderer cannot see the network stack, but it does know three things that
 * separate those cases: the exact address it tried, the origin of the page it is
 * running in, and whether the desktop bridge is present. These helpers turn
 * those facts into a message that names the likely cause and the next step.
 */
import type { DesktopBridge } from '../../../shared/contracts';

/** What the transport actually asked for, resolved as far as the page allows. */
export interface ConnectionTarget {
  /** Exactly what the caller built, e.g. `/api/approvals?workspaceId=…`. */
  raw: string;
  /** The same address made absolute, when a document base was available. */
  url?: URL;
}

/** Suggested next step, appended to the diagnoses that have no better one. */
const CONNECT_HINT = 'Start the backend with `mukai serve` and try again.';

/**
 * `window` is read through `globalThis` because these helpers also run under
 * Node (vitest), where a bare `window` reference throws instead of reading
 * undefined, and because a renderer can legitimately have neither location nor
 * bridge — in which case it tells us nothing about the connection.
 */
type View = { location?: Location; mukai?: DesktopBridge };

function view(): View | undefined {
  return (globalThis as { window?: View }).window;
}

function protocol(): string | undefined {
  return view()?.location?.protocol;
}

function origin(): string | undefined {
  const value = view()?.location?.origin;
  return typeof value === 'string' && value ? value : undefined;
}

function hasBridge(): boolean {
  return view()?.mukai !== undefined;
}

/**
 * A `file://` window with no bridge never got its preload, so it has no server
 * address to reach and no CORS-free channel to reach it on. That is a different
 * repair from "start the backend", which is what the banner used to claim.
 */
function bridgeMissing(): boolean {
  return protocol() === 'file:' && !hasBridge();
}

/** Names what was tried, in a form the user can compare against their own ports. */
export function describeTarget(target: ConnectionTarget): string {
  const { url, raw } = target;
  if (!url) return raw;
  if (url.protocol === 'file:') return 'the desktop bridge';
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return url.host;
  return url.origin;
}

/**
 * Explains a request that never produced a response.
 *
 * `cause` is what `fetch` attached underneath the `TypeError` (typically
 * `ECONNREFUSED` or `ENOTFOUND`); the difference between "nothing is listening"
 * and "that name did not resolve" changes what to do next, so it is carried into
 * the message.
 */
export function diagnoseTransportFailure(target: ConnectionTarget, cause?: unknown): string {
  const prefix = `Cannot reach Mukai’s server at ${describeTarget(target)}.`;
  const reason = describeCause(cause);
  const withReason = (detail: string): string => (reason ? `${detail} (${reason})` : `${detail}`);

  if (bridgeMissing()) {
    return (
      'Cannot reach Mukai’s server: this window has no Mukai bridge, so it was never told where ' +
      'its server lives — its preload did not load. Restart the Mukai window.'
    );
  }
  if (refused(cause)) {
    return `${prefix} ${withReason('Nothing is listening on that port')}. ${CONNECT_HINT}`;
  }
  if (notResolvable(cause)) {
    return `${prefix} ${withReason('That address does not resolve from this page')}. ${CONNECT_HINT}`;
  }
  const mismatch = originMismatch(target);
  if (mismatch) {
    return (
      `${prefix} The cross-origin request from ${mismatch.page} could not complete` +
      `${reason ? `: ${reason}` : ''}. Check the browser console for network or CORS details. ` +
      (hasBridge()
        ? 'If this persists, restart the Mukai window.'
        : 'Check that the backend is running and accepts this page’s origin.')
    );
  }
  return `${prefix} The request could not complete${reason ? `: ${reason}` : ''}. ${CONNECT_HINT}`;
}

/**
 * Explains a response that arrived but holds no Mukai data.
 *
 * The common shape is whatever serves the page answering an `/api/...` path with
 * its own `index.html` because no proxy is configured for the API: the UI then
 * reads a page of markup where it expected an object, and the only clue the user
 * saw was a JavaScript parse error.
 */
export function diagnoseNonJsonResponse(input: {
  target: ConnectionTarget;
  status: number;
  bodyText: string;
  contentType?: string | null;
}): string {
  const { target, status, bodyText } = input;
  const described = describeTarget(target);
  const path = target.url?.pathname ?? target.raw;
  if (/^\s*<(?:!doctype html|html|head|body|script)\b/i.test(bodyText)) {
    return (
      `${described} answered ${path} with an HTML page instead of Mukai data (status ${status}). ` +
      `Whatever is serving this address is not Mukai’s server, or has no proxy for /api. ` +
      `Open the page from the address \`mukai serve\` printed, or start the server with \`mukai serve\`.`
    );
  }
  return (
    `Mukai’s server at ${described} sent something that is not Mukai data for ${path} ` +
    `(status ${status}${input.contentType ? `, ${input.contentType}` : ', no content type'}). ${CONNECT_HINT}`
  );
}

/**
 * The page/server origin pair, when a request leaves the page's own origin.
 *
 * Different origins alone do not establish a CORS rejection. Desktop mode allows
 * dev pages on port 5173, while browser mode has a same-origin policy. Even an
 * allowed origin can fail because of a missing allowed header or a dead server;
 * fetch does not expose enough information to distinguish those cases.
 *
 * A packaged desktop window is exempt: it is loaded from `file://`, reports no
 * origin at all, and is trusted on that basis.
 */
function originMismatch(target: ConnectionTarget): { page: string; server: string } | undefined {
  const page = origin();
  const url = target.url;
  if (!page || page === 'null' || !url) return undefined;
  if (url.origin === page) return undefined;
  return { page, server: url.origin };
}

/**
 * Adds page context to a bodyless 403 without guessing whether authentication,
 * origin policy, or an intermediary refused the request.
 */
export function originBlockedMessage(target: ConnectionTarget): string | undefined {
  const mismatch = originMismatch(target);
  if (!mismatch) return undefined;
  return (
    `The server at ${mismatch.server} returned 403 (Forbidden) for a request from ` +
    `${mismatch.page}. Check authentication and origin permissions.`
  );
}

function describeCause(cause: unknown): string {
  if (!cause) return '';
  if (cause instanceof Error) {
    const code = (cause as Error & { code?: string }).code;
    return code || cause.message || String(cause);
  }
  if (typeof cause === 'string') return cause;
  const code = (cause as { code?: unknown })?.code;
  return typeof code === 'string' ? code : '';
}

function refused(cause: unknown): boolean {
  return /ECONNREFUSED|CONNECTION REFUSED|REFUSED/i.test(describeCause(cause));
}

function notResolvable(cause: unknown): boolean {
  return /ENOTFOUND|EAI_AGAIN|GETADDRINFO/i.test(describeCause(cause));
}
