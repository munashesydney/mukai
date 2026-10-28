import { useEffect, useRef, useState } from 'react';
import type { ChatActivity, ChatMessage } from '../../../../shared/ai';
import { Avatar } from '../../components/ui/Avatar';

function SpawnedBot({ activity, stopped }: { activity: ChatActivity; stopped: boolean }) {
  const bot = activity.delegation!;
  const running = bot.status === 'streaming' || (!bot.status && activity.status === 'running');
  const [departed, setDeparted] = useState(!running);
  const row = useRef<HTMLDivElement>(null);
  const wasRunning = useRef(running);
  useEffect(() => {
    const element = row.current;
    if (running || !wasRunning.current || !element || stopped) return;
    wasRunning.current = false;
    const from = element.getBoundingClientRect();
    // Release the row immediately so the remaining bots stay aligned to the left.
    Object.assign(element.style, {
      position: 'fixed',
      left: `${from.left}px`,
      top: `${from.top}px`,
      width: `${from.width}px`,
      pointerEvents: 'none',
      zIndex: '20',
    });
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const animation = element.animate(
      [
        { transform: 'translateY(0)', opacity: 1 },
        {
          transform: 'translateY(-28px)',
          opacity: 0,
        },
      ],
      { duration: reduced ? 1 : 280, easing: 'cubic-bezier(.2,0,.2,1)', fill: 'forwards' },
    );
    animation.onfinish = () => setDeparted(true);
    return () => animation.cancel();
  }, [running, stopped]);
  if (departed || stopped) return null;
  return (
    <div
      className={`spawned-bot${running ? '' : ' spawned-bot--returning'}`}
      ref={row}
      role="status"
      aria-label={running ? `${bot.botName} is working` : `${bot.botName} returned a result`}
    >
      <Avatar person={bot.avatar || 'mukai-logo'} size="xs" />
      <span className="spawned-bot-name">{bot.botName}</span>
      <span className="spawned-bot-caption">{running ? 'Working' : 'Result received'}</span>
      <span className="typing-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

export function SpawnedBots({ message }: { message: ChatMessage }) {
  const children = (message.activity || []).filter(
    (item) => item.action === 'send_message' && item.delegation,
  );
  if (!children.length) return null;
  const stopped = ['stopped', 'failed', 'interrupted'].includes(message.status);
  return (
    <div className="spawned-bots" aria-label="Delegated bots">
      {children.map((item) => (
        <SpawnedBot
          key={`${item.id}:${item.delegation!.requestId}`}
          activity={item}
          stopped={stopped}
        />
      ))}
    </div>
  );
}
