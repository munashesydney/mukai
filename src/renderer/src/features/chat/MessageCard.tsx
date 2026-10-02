import { ArrowUpRight, Target, FileText, ChevronRight } from 'lucide-react';

export function MessageCard({ kind, onOpen }: { kind: 'pursuit' | 'draft'; onOpen: () => void }) {
  if (kind === 'pursuit')
    return (
      <button className="message-card pursuit-card" onClick={onOpen}>
        <span className="card-symbol card-symbol--teal">
          <Target size={20} />
        </span>
        <span className="card-copy">
          <small>PURSUIT STARTED</small>
          <strong>Grow MRR to $2,000</strong>
        </span>
        <ArrowUpRight size={17} className="card-arrow" />
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
