import { ArrowUpRight, ChevronRight, FileText, Target, X, Sparkles } from 'lucide-react';
import { agents } from './data';
import { Avatar } from '../../components/ui/Avatar';
import { IconButton } from '../../components/ui/IconButton';
import type { Location, DialogKind } from './types';

export function ContextPanel({
  location,
  onSelect,
  onDialog,
  onClose,
}: {
  location: Location;
  onSelect: (location: Location) => void;
  onDialog: (dialog: DialogKind) => void;
  onClose: () => void;
}) {
  const agent = agents.find((a) => a.id === location.item);
  return (
    <aside className="context-panel" aria-label="Conversation details">
      <div className="context-heading">
        <h2>{agent ? 'About your agent' : 'In this space'}</h2>
        <IconButton label="Close details" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      {agent ? (
        <div className="agent-about">
          <Avatar person={agent.id} size="lg" />
          <h3>{agent.name}</h3>
          <span>{agent.role}</span>
          <p>{agent.description}</p>
          <div className="agent-available">
            <i /> Available when you are
          </div>
        </div>
      ) : (
        <>
          <div className="context-section-label">THE PEOPLE BEHIND THE PROGRESS</div>
          <div className="context-agent-list">
            {agents.map((a) => (
              <button key={a.id} onClick={() => onSelect({ section: 'agents', item: a.id })}>
                <Avatar person={a.id} size="sm" />
                <span>
                  <strong>{a.name}</strong>
                  <small>{a.role}</small>
                </span>
                <i className="agent-online" />
              </button>
            ))}
          </div>
        </>
      )}
      <div className="context-section-label context-section-label--spaced">THE BIGGER PICTURE</div>
      <button
        className="context-goal"
        onClick={() => onSelect({ section: 'pursuits', item: 'grow-mrr' })}
      >
        <span className="context-goal-top">
          <Target size={18} />
          <ArrowUpRight size={15} />
        </span>
        <h3>
          Small steps.
          <br />
          Real momentum.
        </h3>
        <p>Grow MRR to $2,000</p>
        <div className="goal-amount">
          $1,062 <span>/ $2,000</span>
        </div>
        <div className="goal-progress">
          <span />
        </div>
        <div className="goal-footer">
          <span>53% of the way there</span>
          <span>↗</span>
        </div>
      </button>
      <div className="context-section-label context-section-label--spaced">ON THE TABLE</div>
      <button className="context-file" onClick={() => onDialog('draft')}>
        <span className="file-mini">
          <FileText size={18} />
        </span>
        <span>
          <strong>Setup guide</strong>
          <small>Draft by Nova</small>
        </span>
        <ChevronRight size={15} />
      </button>
      <div className="context-footer">
        <Sparkles size={16} />
        <p>
          You bring the intention.
          <br />
          <strong>We’ll help with the next step.</strong>
        </p>
      </div>
    </aside>
  );
}
