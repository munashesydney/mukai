import { fromMarkdown } from 'mdast-util-from-markdown';
import { parseResponseReference } from '../../shared/responseReferences';
import type { TelegramMediaFile, TelegramMediaReference } from './types';

export const telegramFileLimit = 50 * 1024 * 1024;
export const telegramMediaLimit = 20;
type Node = {
  type: string;
  url?: string;
  alt?: string | null;
  identifier?: string;
  value?: string;
  children?: Node[];
};

/** Only explicit answer links are deliverables. Code, prose paths and tool payloads are not. */
export function telegramMediaReferences(answer: string): TelegramMediaReference[] {
  const root = fromMarkdown(answer);
  const definitions = new Map<string, string>();
  const result: TelegramMediaReference[] = [];
  const seen = new Set<string>();
  const label = (node: Node): string =>
    node.alt || node.value || node.children?.map(label).join('') || '';
  const walk = (node: Node, visit: (node: Node) => void) => {
    visit(node);
    node.children?.forEach((child) => walk(child, visit));
  };
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
    if (!['image', 'imageReference', 'link', 'linkReference'].includes(node.type)) return;
    const href = node.url || definitions.get(node.identifier || '');
    if (!href || href.length > 4500) return;
    const reference = parseResponseReference(href);
    let key: string;
    if (reference) {
      key =
        reference.type === 'file'
          ? `file:${reference.path.replaceAll('\\', '/').replace(/^(\.\/)+/, '')}`
          : `${reference.type}:${reference.id}`;
      if (reference.type === 'file' && process.platform === 'win32') key = key.toLowerCase();
    } else {
      let url: URL;
      try {
        url = new URL(href);
      } catch {
        return;
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
      // Normal web citations remain links. Images can use extensionless download URLs.
      if (
        !node.type.startsWith('image') &&
        !/\.(png|jpe?g|webp|gif|avif|svg|mp3|m4a|wav|ogg|opus|flac|mp4|mov|webm|mkv|pdf|docx?|xlsx?|pptx?|csv|txt|md|json|zip)$/i.test(
          url.pathname,
        )
      )
        return;
      url.hash = '';
      key = url.href;
    }
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ href, label: label(node) || 'File' });
  });
  return result;
}

export type TelegramMediaMethod =
  'sendPhoto' | 'sendAudio' | 'sendVideo' | 'sendAnimation' | 'sendDocument';
export const telegramMediaField = {
  sendPhoto: 'photo',
  sendAudio: 'audio',
  sendVideo: 'video',
  sendAnimation: 'animation',
  sendDocument: 'document',
} as const;

export function telegramMediaMethod(file: TelegramMediaFile): TelegramMediaMethod {
  if (/^image\/(png|jpeg|webp)$/.test(file.mediaType) && file.bytes.length <= 10 * 1024 * 1024)
    return 'sendPhoto';
  if (file.bytes.toString('ascii', 0, 6).match(/^GIF8[79]a$/)) return 'sendAnimation';
  if (['audio/mpeg', 'audio/mp4'].includes(file.mediaType)) return 'sendAudio';
  if (file.mediaType === 'video/mp4') return 'sendVideo';
  return 'sendDocument';
}

export function telegramMediaLabel(label: string, limit = 700) {
  return label
    .replace(/[\p{Cc}\u2028\u2029]/gu, ' ')
    .slice(0, limit)
    .replace(/[\uD800-\uDBFF]$/, '');
}
