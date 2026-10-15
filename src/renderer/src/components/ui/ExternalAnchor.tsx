import type { AnchorHTMLAttributes } from 'react';

type Props = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick' | 'onError'> & {
  href: string;
  onError: (message: string) => void;
};

/** Keep real anchor semantics in browsers and use the validated OS opener on desktop. */
export function ExternalAnchor({ href, onError, children, ...props }: Props) {
  return (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        if (!window.mukai) return;
        event.preventDefault();
        void window.mukai
          .openExternal(href)
          .catch(() =>
            onError('Could not open the link. Check your default browser and try again.'),
          );
      }}
    >
      {children}
    </a>
  );
}
