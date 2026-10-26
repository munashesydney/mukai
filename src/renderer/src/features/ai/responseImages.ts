import { fromMarkdown } from 'mdast-util-from-markdown';
import { parseResponseReference } from '../../../../shared/responseReferences';

export type ResponseImage = { key: string; href: string; label: string };
type Node = {
  type: string;
  url?: string;
  alt?: string | null;
  identifier?: string;
  value?: string;
  children?: Node[];
};

export function responseImageKey(href: string) {
  const target = parseResponseReference(href);
  return !target
    ? null
    : target.type === 'file'
      ? `file:${target.path.replaceAll('\\', '/').replace(/^(\.\/)+/, '')}`
      : `${target.type}:${target.id}`;
}

/** Parse Markdown so examples, code, and remote URLs cannot become gallery entries. */
export function responseImages(text: string): ResponseImage[] {
  const root = fromMarkdown(text);
  const definitions = new Map<string, string>();
  const references: (ResponseImage & { image: boolean })[] = [];
  const label = (node: Node): string =>
    node.alt || node.value || node.children?.map(label).join('') || '';
  function walk(node: Node, visit: (node: Node) => void) {
    visit(node);
    node.children?.forEach((child) => walk(child, visit));
  }
  walk(root, (node) => {
    if (
      node.type === 'definition' &&
      node.identifier &&
      node.url &&
      !definitions.has(node.identifier)
    )
      definitions.set(node.identifier, node.url);
  });
  walk(root, (node) => {
    if (!['image', 'link', 'imageReference', 'linkReference'].includes(node.type)) return;
    const href = node.url || definitions.get(node.identifier || '');
    const key = href && responseImageKey(href);
    if (!href || !key) return;
    const target = parseResponseReference(href)!;
    const name =
      label(node) || (target.type === 'file' ? target.path.split(/[\\/]/).at(-1)! : 'Image');
    references.push({
      key,
      href,
      label: name,
      image:
        node.type.startsWith('image') ||
        /\.(png|jpe?g|webp)$/i.test(target.type === 'file' ? target.path : name),
    });
  });
  const imageKeys = new Set(references.filter((entry) => entry.image).map((entry) => entry.key));
  const seen = new Set<string>();
  return references
    .filter((entry) => {
      if (!imageKeys.has(entry.key) || seen.has(entry.key)) return false;
      seen.add(entry.key);
      return true;
    })
    .map(({ key, href, label }) => ({ key, href, label }));
}
