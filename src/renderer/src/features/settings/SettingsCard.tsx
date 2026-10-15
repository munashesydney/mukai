import type { ReactNode } from 'react';

export function SettingsCard({
  title,
  description,
  icon,
  children,
  className = '',
}: {
  title: string;
  description: string;
  icon: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`settings-card ${className}`}>
      <div className="settings-card-heading">
        <span className="settings-card-icon">{icon}</span>
        <div>
          <h4>{title}</h4>
          <p>{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}
