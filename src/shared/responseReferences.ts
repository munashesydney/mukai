export type ResponseReference =
  | { type: 'artifact' | 'attachment'; id: string; line?: number }
  | { type: 'file'; path: string; line?: number };

export const artifactHref = (id: string) => `mukai://artifact/${encodeURIComponent(id)}`;
export const attachmentHref = (id: string) => `mukai://attachment/${encodeURIComponent(id)}`;
export type SavedFileReference = { artifactId: string; reference: string };
const controls = (text: string) =>
  [...text].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

/** Explicit links only: prose/code spans are never interpreted as filesystem commands. */
export function parseResponseReference(href: string): ResponseReference | null {
  if (!href || href.length > 4500 || controls(href)) return null;
  const lineMatch = /#L([1-9]\d{0,6})$/.exec(href);
  const line = lineMatch ? Number(lineMatch[1]) : undefined;
  const target = lineMatch ? href.slice(0, lineMatch.index) : href;
  try {
    const internal = /^mukai:\/\/(artifact|attachment|file)\/(.+)$/i.exec(target);
    if (internal) {
      const value = decodeURIComponent(internal[2]);
      if (controls(value)) return null;
      if (internal[1].toLowerCase() === 'file') return { type: 'file', path: value, line };
      if (!/^[a-zA-Z0-9_-]{1,200}$/.test(value)) return null;
      return { type: internal[1].toLowerCase() as 'artifact' | 'attachment', id: value, line };
    }
    // Relative paths and native absolute paths are scoped by the backend, never opened as URLs.
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\\\\|#)/i.test(target) && !/^[a-z]:[\\/]/i.test(target))
      return null;
    if (!target || target.includes('?') || target.includes('#')) return null;
    const path = decodeURIComponent(target);
    if (controls(path)) return null;
    return { type: 'file', path, line };
  } catch {
    return null;
  }
}
