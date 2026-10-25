import { createContext, memo, useContext, useMemo, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Bot } from '../../../../shared/ai';
import { botHandle } from '../../../../shared/mentions';
import { parseResponseReference } from '../../../../shared/responseReferences';
import { closedChartFence } from '../../../../shared/responseCharts';
import { ResponseReference } from './ResponseReference';
import { ChartLoading, ResponseChartBlock } from './ResponseChart';
import '../../styles/responseRichContent.css';

const mentionHref = '#mukai-mention-';
const remarkPlugins = [remarkGfm];
const noMentionBots: Bot[] = [];
const MarkdownSource = createContext({ text: '', streaming: false });
function MarkdownPre({ node, children }: ExtraProps & { children?: ReactNode }) {
  const { text, streaming } = useContext(MarkdownSource);
  const code = node?.children[0];
  if (
    code?.type === 'element' &&
    Array.isArray(code.properties.className) &&
    code.properties.className.includes('language-mukai-chart')
  ) {
    const start = node?.position?.start.offset,
      end = node?.position?.end.offset;
    if (start === undefined || end === undefined || !closedChartFence(text.slice(start, end)))
      return streaming ? <ChartLoading /> : <p role="alert">This chart block was not completed.</p>;
    return (
      <ResponseChartBlock
        source={code.children.map((child) => (child.type === 'text' ? child.value : '')).join('')}
      />
    );
  }
  return <pre>{children}</pre>;
}

function linkMentions(text: string, bots: Bot[]) {
  if (!bots.length) return text;
  const byHandle = new Map(bots.map((bot) => [botHandle(bot), bot]));
  return text.replace(/(^|\s)@([\p{L}\p{N}_-]+)/gu, (match, prefix, handle) => {
    const bot = byHandle.get(handle.toLowerCase());
    return bot ? `${prefix}[@${handle}](${mentionHref}${bot.id})` : match;
  });
}

// Markdown parsing is the most expensive work in a chat feed. Memoizing keeps
// completed messages from re-parsing while the composer or a stream updates.
export const MessageMarkdown = memo(function MessageMarkdown({
  text,
  mentionBots = noMentionBots,
  onMention,
  streaming = false,
}: {
  text: string;
  mentionBots?: Bot[];
  onMention?: (bot: Bot) => void;
  streaming?: boolean;
}) {
  const renderedText = linkMentions(text, mentionBots);
  const components = useMemo(
    () => ({
      a: ({ href, children }: { href?: string; children?: ReactNode }) => {
        const mentioned = href?.startsWith(mentionHref)
          ? mentionBots.find((bot) => bot.id === href.slice(mentionHref.length))
          : undefined;
        if (mentioned) {
          return (
            <button
              type="button"
              className="mention-link"
              onClick={() => onMention?.(mentioned)}
              aria-label={`Open a new conversation with ${mentioned.name}`}
            >
              {children}
            </button>
          );
        }
        if (href && parseResponseReference(href))
          return (
            <ResponseReference key={href} href={href}>
              {children}
            </ResponseReference>
          );
        return /^https?:\/\//i.test(href || '') ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => {
              if (window.mukai && href) {
                event.preventDefault();
                void window.mukai.openExternal(href).catch(() => {});
              }
            }}
          >
            {children}
          </a>
        ) : (
          <span>{children}</span>
        );
      },
      img: ({ alt, src }: { alt?: string; src?: string }) =>
        src && parseResponseReference(src) ? (
          <ResponseReference key={src} href={src} image label={alt || 'Image'} />
        ) : (
          <span>{alt ? `[${alt}]` : '[Image link]'}</span>
        ),
      pre: MarkdownPre,
    }),
    [mentionBots, onMention],
  );
  return (
    <div className="ai-markdown">
      <MarkdownSource.Provider value={{ text: renderedText, streaming }}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          components={components}
          urlTransform={(url) => (parseResponseReference(url) ? url : defaultUrlTransform(url))}
        >
          {renderedText}
        </ReactMarkdown>
      </MarkdownSource.Provider>
    </div>
  );
});
