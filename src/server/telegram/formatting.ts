import { fromMarkdown } from 'mdast-util-from-markdown';
import { parseResponseReference } from '../../shared/responseReferences';

interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  alt?: string | null;
  lang?: string | null;
  ordered?: boolean | null;
  start?: number | null;
  identifier?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}
export interface TelegramEntity {
  type: 'bold' | 'italic' | 'code' | 'pre' | 'text_link' | 'blockquote';
  offset: number;
  length: number;
  url?: string;
  language?: string;
}

/** Convert CommonMark to explicit Telegram entities; never interpret model output as HTML. */
export function telegramFormatting(
  original: string,
  markdown = true,
): {
  text: string;
  entities?: TelegramEntity[];
} {
  const boundary = original.indexOf('\n\n');
  // Workspace/bot names are literal labels, even when they contain Markdown punctuation.
  const prefix = boundary < 0 ? '' : original.slice(0, boundary + 2);
  const body = original.slice(prefix.length);
  const labels: TelegramEntity[] = [...prefix.matchAll(/^(Workspace|Bot) (.+)$/gm)].map(
    (match) => ({
      type: 'bold',
      offset: match.index + match[1].length + 1,
      length: match[2].length,
    }),
  );
  const plain = () => ({ text: original, ...(labels.length ? { entities: labels } : {}) });
  if (!markdown) return plain();
  try {
    const root = fromMarkdown(body);
    const definitions = new Map(
      root.children.flatMap((node) =>
        node.type === 'definition' ? [[node.identifier.toUpperCase(), node.url] as const] : [],
      ),
    );
    let text = prefix;
    let fileReference = false;
    const entities: TelegramEntity[] = [...labels];
    const safeUrl = (url?: string) => !!url && /^(https?:\/\/|mailto:)/i.test(url);
    const appendChildren = (node: MarkdownNode, separator = '', depth = 0) => {
      node.children?.forEach((child, index) => {
        if (index) text += separator;
        visit(child, depth + 1);
      });
    };
    const visit = (node: MarkdownNode, depth: number) => {
      if (depth > 24) throw new Error('Markdown nesting limit');
      const offset = text.length;
      let type: TelegramEntity['type'] | undefined;
      const url =
        node.url ?? (node.identifier ? definitions.get(node.identifier.toUpperCase()) : undefined);
      switch (node.type) {
        case 'root':
          appendChildren(node, '\n\n', depth);
          break;
        case 'paragraph':
          appendChildren(node, '', depth);
          break;
        case 'strong':
        case 'heading':
          type = 'bold';
          appendChildren(node, '', depth);
          break;
        case 'emphasis':
          type = 'italic';
          appendChildren(node, '', depth);
          break;
        case 'inlineCode':
          type = 'code';
          text += node.value ?? '';
          break;
        case 'code':
          type = 'pre';
          text += node.value ?? '';
          break;
        case 'blockquote':
          type = 'blockquote';
          appendChildren(node, '\n\n', depth);
          break;
        case 'link':
        case 'linkReference':
          if (safeUrl(url)) type = 'text_link';
          else if (url && parseResponseReference(url)) fileReference = true;
          appendChildren(node, '', depth);
          break;
        case 'image':
        case 'imageReference':
          text += node.alt || 'Image';
          if (safeUrl(url)) type = 'text_link';
          else if (url && parseResponseReference(url)) fileReference = true;
          break;
        case 'list':
          node.children?.forEach((child, index) => {
            if (index) text += '\n';
            text += node.ordered ? `${(node.start ?? 1) + index}. ` : '• ';
            visit(child, depth + 1);
          });
          break;
        case 'listItem':
          appendChildren(node, '\n', depth);
          break;
        case 'break':
          text += '\n';
          break;
        case 'thematicBreak':
          text += '—';
          break;
        case 'definition':
          break;
        case 'text': {
          const value = node.value ?? '';
          let cursor = 0;
          for (const match of value.matchAll(
            /^(Workspace|Bot|Update|From|Tool|Status|Conversation):[ \t]+([^\n]+)/gm,
          )) {
            text += value.slice(cursor, match.index) + match[1] + ' ';
            entities.push({ type: 'bold', offset: text.length, length: match[2].length });
            text += match[2];
            cursor = match.index + match[0].length;
          }
          text += value.slice(cursor);
          break;
        }
        default:
          // Unknown syntax, raw HTML, and unresolved references stay visible as literal text.
          text += node.value ?? body.slice(node.position?.start.offset, node.position?.end.offset);
      }
      if (type && text.length > offset)
        entities.push({
          type,
          offset,
          length: text.length - offset,
          ...(type === 'text_link' ? { url } : {}),
          ...(type === 'pre' && node.lang && /^[\w+-]{1,32}$/.test(node.lang)
            ? { language: node.lang }
            : {}),
        });
    };
    visit(root, 0);
    // Telegram forbids code inside emphasis/link entities and nested block quotations.
    const supported = entities
      .filter(
        (entity) =>
          !entities.some(
            (child) =>
              child !== entity &&
              child.offset < entity.offset + entity.length &&
              child.offset + child.length > entity.offset &&
              ((['bold', 'italic', 'text_link'].includes(entity.type) &&
                ['code', 'pre'].includes(child.type)) ||
                (entity.type === 'blockquote' &&
                  child.type === 'blockquote' &&
                  child.offset <= entity.offset &&
                  child.length >= entity.length)),
          ),
      )
      .sort((a, b) => a.offset - b.offset || b.length - a.length);
    if (
      (supported.length <= labels.length && !fileReference) ||
      supported.length > 100 ||
      text.length > 4096 ||
      !text.trim()
    )
      return plain();
    return { text, entities: supported };
  } catch {
    return plain();
  }
}
