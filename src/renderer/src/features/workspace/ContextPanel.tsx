import { ChevronRight, FileText, Target, X } from 'lucide-react';
import { bots } from './data';
import { Avatar } from '../../components/ui/Avatar';
import { IconButton } from '../../components/ui/IconButton';
import { ContextBotList } from '../chat/ContextBotList';
import type { Location, DialogKind, Message, Pursuit, Space } from './types';

export function ContextPanel({
  location,
  space,
  pursuit,
  pursuits,
  messages,
  onSelect,
  onDialog,
  onClose,
}: {
  location: Location;
  space?: Space;
  pursuit?: Pursuit;
  pursuits: Pursuit[];
  messages: Message[];
  onSelect: (location: Location) => void;
  onDialog: (dialog: DialogKind) => void;
  onClose: () => void;
}) {
  const bot = bots.find((a) => a.id === location.item);
  const hasDraft = messages.some((message) => message.card === 'draft');
  const participants = pursuit
    ? bots.filter(
        (a) =>
          a.id === pursuit.bot ||
          messages.some((message) => message.author === a.id) ||
          (hasDraft && a.id === 'nova'),
      )
    : bots;
  const activePursuits = bot ? pursuits.filter((p) => p.bot === bot.id && !p.paused) : [];
  return (
    <aside className="context-panel" id="conversation-details" aria-label="Conversation details">
      <div className="context-heading">
        <h2>{bot ? 'About your bot' : pursuit ? 'Pursuit details' : 'In this space'}</h2>
        <IconButton label="Close details" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      {bot ? (
        <>
          <div className="bot-about">
            <Avatar person={bot.id} size="lg" />
            <h3>{bot.name}</h3>
            <span>{bot.role}</span>
            <p>{bot.description}</p>
            <div className="bot-available">
              <i /> Available when you are
            </div>
          </div>
          {activePursuits.length > 0 && (
            <>
              <div className="context-section-label context-section-label--spaced">
                ACTIVE PURSUITS
              </div>
              {activePursuits.map((p) => (
                <button
                  className="context-pursuit-link"
                  key={p.id}
                  onClick={() => onSelect({ section: 'pursuits', item: p.id })}
                >
                  <Target size={16} />
                  <span>{p.name}</span>
                  <ChevronRight size={14} />
                </button>
              ))}
            </>
          )}
        </>
      ) : (
        <>
          {pursuit ? (
            <>
              <div className="context-section-label">THE BIGGER PICTURE</div>
              <button className="context-goal" onClick={() => onDialog('details')}>
                <span className="context-goal-top">
                  <Target size={18} />
                  <ChevronRight size={15} />
                </span>
                <h3>{pursuit.name}</h3>
                <p>{pursuit.description}</p>
                <div className="goal-progress">
                  <span style={{ width: `${pursuit.progress}%` }} />
                </div>
                <div className="goal-footer">
                  <span>{pursuit.progress}% complete</span>
                  <span>{pursuit.paused ? 'Paused' : 'In motion'}</span>
                </div>
              </button>
              <div className="context-section-label context-section-label--spaced">
                KEEPING THIS MOVING
              </div>
            </>
          ) : (
            <>
              <p className="context-description">{space?.description}</p>
              <div className="context-section-label">BOTS IN THIS SPACE</div>
            </>
          )}
          <ContextBotList
            bots={participants.map((bot) => ({
              id: bot.id,
              name: bot.name,
              avatar: bot.id,
              subtitle: bot.role,
            }))}
            onSelect={(id) => onSelect({ section: 'bots', item: id })}
          />
        </>
      )}
      {hasDraft && (
        <>
          <div className="context-section-label context-section-label--spaced">ARTIFACTS</div>
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
        </>
      )}
    </aside>
  );
}
