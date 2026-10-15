import { ExternalLink, Pause, Play } from 'lucide-react';
import type { TelegramAccessInput, TelegramStatus } from '../../../../shared/telegram';
import { ExternalAnchor } from '../../components/ui/ExternalAnchor';
import { IconButton } from '../../components/ui/IconButton';
import { TelegramHero } from './TelegramHero';
import { TelegramWorkspaceAccess } from './TelegramWorkspaceAccess';

export function TelegramConnected({
  status,
  botUrl,
  pending,
  onToggle,
  onAccess,
  onError,
}: {
  status: TelegramStatus;
  botUrl: string | null;
  pending: boolean;
  onToggle: () => void;
  onAccess: (workspaces: TelegramAccessInput['workspaces']) => void;
  onError: (message: string) => void;
}) {
  return (
    <section className="telegram-overview telegram-stage">
      <TelegramHero title={status.enabled ? 'Telegram is connected' : 'Telegram is paused'} />
      <div className="telegram-connected-account">
        <span className="telegram-dot" />
        <span>
          {status.owner?.username ? '@' + status.owner.username : status.owner?.firstName}
        </span>
        <IconButton
          label={status.enabled ? 'Pause connection' : 'Resume connection'}
          disabled={pending}
          onClick={onToggle}
        >
          {status.enabled ? <Pause size={18} /> : <Play size={18} />}
        </IconButton>
      </div>
      {botUrl && (
        <ExternalAnchor
          className="button button--primary telegram-primary"
          href={botUrl}
          onError={onError}
        >
          Open Telegram <ExternalLink size={16} />
        </ExternalAnchor>
      )}
      <TelegramWorkspaceAccess
        workspaces={status.workspaces}
        selection={status.workspaces
          .filter((item) => item.enabled)
          .map((item) => ({ workspaceId: item.id, botId: item.botId }))}
        onChange={onAccess}
        disabled={pending}
      />
    </section>
  );
}
