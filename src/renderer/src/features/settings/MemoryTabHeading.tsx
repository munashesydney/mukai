import type { ReactNode } from 'react';

export function MemoryTabHeading({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="memory-section-toolbar">
      <div>
        <h2>{title}</h2>
        <p className="memory-run-meta">{description}</p>
      </div>
      {actions}
    </div>
  );
}
