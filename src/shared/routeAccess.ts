/* eslint-disable no-control-regex -- Reject control characters in redirect destinations. */
/** Only custom-route paths may be used as browser login destinations. */
export function customRouteReturnTo(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096 || /[\\\x00-\x20\x7f]/.test(value)) return;
  try {
    const decoded = decodeURIComponent(value);
    if (/[\\\x00-\x1f\x7f]/.test(decoded)) return;
    const url = new URL(value, 'http://mukai.invalid');
    if (url.origin !== 'http://mukai.invalid' || !url.pathname.startsWith('/custom/')) return;
    // Reject encoded separators and dot-segment normalization, too.
    const plain = new URL(decoded, 'http://mukai.invalid');
    if (plain.origin !== url.origin || !plain.pathname.startsWith('/custom/')) return;
    return url.pathname + url.search + url.hash;
  } catch {
    return;
  }
}
export const routeEnvironmentNames = ['MUKAI_ROUTES_URL', 'MUKAI_ROUTES_TOKEN'] as const;
export interface RouteEnvironment {
  env: Record<string, string>;
}
