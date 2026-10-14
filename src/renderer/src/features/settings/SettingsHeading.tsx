import type { ReactNode } from 'react';

export function SettingsHeading({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="settings-panel-heading">
      <div className="settings-heading-copy">
        <span className="settings-eyebrow">{eyebrow}</span>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      {actions && <div className="settings-heading-actions">{actions}</div>}
    </header>
  );
}
