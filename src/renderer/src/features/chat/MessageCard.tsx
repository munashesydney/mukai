import { ArrowUpRight, Target, FileText, ChevronRight } from 'lucide-react';

export function MessageCard({ kind, onOpen }: { kind: 'pursuit' | 'draft'; onOpen: () => void }) {
  if (kind === 'pursuit')
    return (
      <button className="message-pursuit-link" onClick={onOpen}>
        <Target size={15} />
        <span>Grow MRR to $2,000</span>
        <ArrowUpRight size={13} />
      </button>
    );
  return (
    <button className="message-card draft-card" onClick={onOpen}>
      <span className="card-symbol card-symbol--purple">
        <FileText size={21} />
      </span>
      <span className="card-copy">
        <strong>
          A simpler setup guide <span className="draft-badge">Draft</span>
        </strong>
        <span>3 steps to get up and running</span>
      </span>
      <span className="card-open">
        View draft <ChevronRight size={14} />
      </span>
    </button>
  );
}
