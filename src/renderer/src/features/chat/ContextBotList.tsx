import { Avatar } from '../../components/ui/Avatar';

interface ContextBot {
  id: string;
  name: string;
  avatar: 'atlas' | 'nova' | 'scout';
  subtitle: string;
}

export function ContextBotList({
  bots,
  onSelect,
}: {
  bots: ContextBot[];
  onSelect: (id: string) => void;
}) {
  return (
    <div className="context-bot-list">
      {bots.map((bot) => (
        <button key={bot.id} onClick={() => onSelect(bot.id)}>
          <Avatar person={bot.avatar} size="sm" />
          <span className="context-bot-copy">
            <strong>{bot.name}</strong>
            <small title={bot.subtitle}>{bot.subtitle}</small>
          </span>
          <i className="bot-online" aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}
