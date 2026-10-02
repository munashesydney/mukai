import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function MessageMarkdown({ text }: { text: string }) {
  return (
    <div className="ai-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) =>
            /^https?:\/\//i.test(href || '') ? (
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
            ),
          img: ({ alt }) => <span>{alt ? `[${alt}]` : '[Image link]'}</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
