import { X } from 'lucide-react';
import type { Bot } from '../../../../shared/ai';
import type { Conversation } from '../../../../shared/conversations';
import { IconButton } from '../../components/ui/IconButton';
import { ContextBotList } from './ContextBotList';
export function SpaceDetails({
  space,
  bots,
  onClose,
  onSelectBot,
}: {
  space: Conversation;
  bots: Bot[];
  onClose: () => void;
  onSelectBot: (id: string) => void;
}) {
  const members = bots.filter((bot) => space.botIds.includes(bot.id));
  return (
    <aside
      className="context-panel space-details"
      id="conversation-details"
      aria-label="Space details"
    >
      <div className="context-heading">
        <h2>In this space</h2>
        <IconButton label="Close details" onClick={onClose}>
          <X size={16} />
        </IconButton>
      </div>
      <div className="context-section-label">BOTS IN THIS SPACE</div>
      <ContextBotList
        bots={members.map((bot) => ({ ...bot, subtitle: bot.role }))}
        onSelect={onSelectBot}
      />
      {!members.length && <p className="context-description">No bots belong to this space.</p>}
    </aside>
  );
}
