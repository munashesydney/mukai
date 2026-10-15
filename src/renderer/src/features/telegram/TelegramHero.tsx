import type { ReactNode } from 'react';
import { TelegramLogo } from '../../components/ui/TelegramLogo';

export function TelegramHero({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="telegram-hero">
      <span className="telegram-mark">
        <TelegramLogo size={39} />
      </span>
      <h1>{title}</h1>
      {children && <p>{children}</p>}
    </header>
  );
}
