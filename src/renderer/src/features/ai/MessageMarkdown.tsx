import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Bot } from '../../../../shared/ai';
import { botHandle } from '../../../../shared/mentions';

const mentionHref = '#mukai-mention-';

function linkMentions(text: string, bots: Bot[]) {
  if (!bots.length) return text;
  const byHandle = new Map(bots.map((bot) => [botHandle(bot), bot]));
  return text.replace(/(^|\s)@([\p{L}\p{N}_-]+)/gu, (match, prefix, handle) => {
    const bot = byHandle.get(handle.toLowerCase());
    return bot ? `${prefix}[@${handle}](${mentionHref}${bot.id})` : match;
  });
}

export function MessageMarkdown({
  text,
  mentionBots = [],
  onMention,
}: {
  text: string;
  mentionBots?: Bot[];
  onMention?: (bot: Bot) => void;
}) {
  const renderedText = linkMentions(text, mentionBots);
  return (
    <div className="ai-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
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
          img: ({ alt }) => <span>{alt ? `[${alt}]` : '[Image link]'}</span>,
        }}
      >
        {renderedText}
      </ReactMarkdown>
    </div>
  );
}
