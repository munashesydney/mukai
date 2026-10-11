import { useCallback, useState } from 'react';
import { ListTree } from 'lucide-react';
import type { Bot, ProviderSettings } from '../../../../shared/ai';
import type { Conversation } from '../../../../shared/conversations';
import type { FileChangeSummary } from '../../../../shared/fileChanges';
import type { Location } from '../workspace/types';
import { IconButton } from '../../components/ui/IconButton';
import { useChat } from '../ai/chatStore';
import { useChatActivity } from '../ai/useChatActivity';
import { ChatActivityDrawer } from '../ai/ChatActivityDrawer';
import { DiffDrawer } from '../ai/DiffDrawer';
import { ConversationHeader } from './ConversationHeader';
import { SpaceChat } from './SpaceChat';
import { SpaceDetails } from './SpaceDetails';
import { ActivityView } from './ConversationViews';

export function SpaceConversation({
  space,
  bots,
  providers,
  location,
  tab,
  onTab,
  savedOpen,
  onSaved,
  onCloseSaved,
  detailsOpen,
  onDetails,
  onCloseDetails,
  onSelectBot,
  onProviders,
  onSettings,
  onOpenBot,
  onViewComputer,
  onPursuit,
  onDraft,
}: {
  space: Conversation;
  bots: Bot[];
  providers: ProviderSettings[];
  location: Location;
  tab: string;
  onTab: (tab: string) => void;
  savedOpen: boolean;
  onSaved: () => void;
  onCloseSaved: () => void;
  detailsOpen: boolean;
  onDetails: () => void;
  onCloseDetails: () => void;
  onSelectBot: (id: string) => void;
  onProviders: () => void;
  onSettings: () => void;
  onOpenBot: (id: string) => Promise<void>;
  onViewComputer: () => void;
  onPursuit: () => void;
  onDraft: () => void;
}) {
  const state = useChat(`space:${space.id}`);
  const respondingBotId =
    [...state.messages].reverse().find((message) => message.role === 'assistant')?.botId ||
    space.botIds[0] ||
    '';
  const activity = useChatActivity(space.id, state.messages, bots, respondingBotId);
  const activityOpen = activity.open && !detailsOpen;
  const [review, setReview] = useState<{
    changes: FileChangeSummary[];
    selectedId: string;
  } | null>(null);
  const openReview = useCallback(
    (changes: FileChangeSummary[], selectedId: string) => setReview({ changes, selectedId }),
    [],
  );
  return (
    <div className={`conversation-layout ${activityOpen ? 'has-chat-activity' : ''}`}>
      <main className="conversation">
        <ConversationHeader
          location={location}
          space={space}
          tab={tab}
          onTab={onTab}
          detailsOpen={detailsOpen}
          onDetails={() => {
            activity.setOpen(false);
            onDetails();
          }}
          onSettings={onSettings}
          onSaved={onSaved}
          members={bots.filter((bot) => space.botIds.includes(bot.id))}
          headerActions={
            activity.count > 0 ? (
              <IconButton
                label={activityOpen ? 'Hide chat activity' : 'Show chat activity'}
                className={activityOpen ? 'is-on' : ''}
                aria-expanded={activityOpen}
                aria-controls="chat-activity-drawer"
                onClick={() => {
                  activity.setOpen(!activityOpen);
                  onCloseDetails();
                }}
              >
                <ListTree size={18} />
              </IconButton>
            ) : undefined
          }
        />
        {tab === 'Activity' && !savedOpen ? (
          <ActivityView onPursuit={onPursuit} onDraft={onDraft} />
        ) : (
          <SpaceChat
            space={space}
            bots={bots}
            providers={providers}
            tab={tab}
            savedOpen={savedOpen}
            onCloseSaved={onCloseSaved}
            onProviders={onProviders}
            onOpenBot={onOpenBot}
            onReview={openReview}
          />
        )}
      </main>
      {activityOpen && (
        <ChatActivityDrawer
          data={activity}
          bots={bots}
          workspaceId={space.workspaceId}
          onClose={() => activity.setOpen(false)}
          onReview={openReview}
          onOpenBot={onOpenBot}
          onViewComputer={onViewComputer}
        />
      )}
      {detailsOpen && (
        <SpaceDetails
          space={space}
          bots={bots}
          onClose={onCloseDetails}
          onSelectBot={onSelectBot}
        />
      )}
      {review && (
        <DiffDrawer
          changes={review.changes}
          selectedId={review.selectedId}
          onSelect={(selectedId) => setReview({ ...review, selectedId })}
          onClose={() => setReview(null)}
        />
      )}
    </div>
  );
}
