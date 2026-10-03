import { Target } from 'lucide-react';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { TitleBar } from '../components/layout/TitleBar';
import { NavigationRail } from '../components/layout/NavigationRail';
import { WorkspaceSidebar } from '../components/layout/WorkspaceSidebar';
import { ConversationHeader } from '../features/chat/ConversationHeader';
import { ActivityView } from '../features/chat/ConversationViews';
import { SearchDialog } from '../features/workspace/SearchDialog';
import { WorkspaceDialogs } from '../features/workspace/WorkspaceDialogs';
import { ToolsPage } from '../features/workspace/ToolsPage';
import { useWorkspace } from '../features/workspace/useWorkspace';
import { useAIWorkspace } from '../features/ai/useAIWorkspace';
import { useSpaces } from '../features/workspace/useSpaces';
import { SpaceChat } from '../features/chat/SpaceChat';
import { SpaceDetails } from '../features/chat/SpaceDetails';
import { usePursuits } from '../features/pursuits/usePursuits';
import { PursuitPage } from '../features/pursuits/PursuitPage';
import { BotChat } from '../features/ai/BotChat';
import { useBotConversations } from '../features/ai/useBotConversations';
import { BotEditor } from '../features/ai/BotEditor';
import { SettingsPage } from '../features/settings/SettingsPage';
import { WorkspaceEditor } from '../features/workspace/WorkspaceEditor';
import type { Bot, Workspace } from '../../../shared/ai';
import type { DialogKind, Location, Section, SettingsSection } from '../features/workspace/types';
import { BrowserPanel } from '../features/browser/BrowserPanel';
import { BrowserLayout, BrowserWorkspace } from '../features/browser/BrowserWorkspace';

export function App() {
  const ai = useAIWorkspace();
  return (
    <BrowserWorkspace key={ai.workspaceId} workspaceId={ai.workspaceId}>
      <WorkspaceApp ai={ai} />
    </BrowserWorkspace>
  );
}
function WorkspaceApp({ ai }: { ai: ReturnType<typeof useAIWorkspace> }) {
  const workspace = useWorkspace(ai.workspaceId);
  const spaceState = useSpaces(ai.workspaceId);
  const pursuitState = usePursuits(ai.workspaceId);
  const botChats = useBotConversations(ai.workspaceId);
  const [editingWorkspace, setEditingWorkspace] = useState<Workspace | 'new' | null>(null);
  const [editingBot, setEditingBot] = useState<Bot | 'new' | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [tab, setTab] = useState('Messages');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.innerWidth <= 760);
  const [savedOpen, setSavedOpen] = useState(false);
  const { location, navigate, replace } = workspace;
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 760px)');
    const onResize = (event: MediaQueryListEvent) => {
      setSidebarCollapsed(event.matches);
      if (event.matches) setDetailsOpen(false);
    };
    narrow.addEventListener('change', onResize);
    return () => narrow.removeEventListener('change', onResize);
  }, []);
  const select = useCallback(
    (next: Location) => {
      navigate(next);
      setTab('Messages');
      setSavedOpen(false);
      if (window.innerWidth <= 760) setSidebarCollapsed(true);
    },
    [navigate],
  );
  const space = spaceState.spaces.find((s) => s.id === location.item);
  const pursuit =
    pursuitState.pursuits.find((p) => p.id === location.item) || pursuitState.pursuits[0];
  const bot = ai.bots.find((a) => a.id === location.item) || ai.bots[0];
  const ownedChats = botChats.conversations.filter((chat) => chat.ownerBotId === bot?.id);
  let rememberedChat = '';
  try {
    rememberedChat = localStorage.getItem(`mukai.active-conversation.${bot?.id}`) || '';
  } catch {
    /* Server history remains available. */
  }
  const botConversation =
    ownedChats.find((chat) => chat.id === location.conversationId) ||
    ownedChats.find((chat) => chat.id === rememberedChat) ||
    ownedChats[0];
  useEffect(() => {
    if (
      location.section === 'bots' &&
      bot &&
      botConversation &&
      location.conversationId !== botConversation.id
    )
      replace({ section: 'bots', item: bot.id, conversationId: botConversation.id });
  }, [location.section, location.conversationId, bot, botConversation, replace]);
  async function createBotConversation(botId: string) {
    const conversation = await botChats.create(botId);
    select({ section: 'bots', item: botId, conversationId: conversation.id });
  }
  const openDialog = (kind: DialogKind) => {
    if (kind === 'create-bot') setEditingBot('new');
    else setDialog(kind);
  };
  const openSettings = (settingsSection: SettingsSection = 'workspace') =>
    select({ section: 'settings', item: settingsSection });
  const openPursuit = () =>
    select({ section: 'pursuits', item: pursuitState.pursuits[0]?.id || 'empty' });
  const navigateSection = (section: Section) =>
    select({
      section,
      item:
        section === 'spaces'
          ? spaceState.spaces[0]?.id || 'empty'
          : section === 'pursuits'
            ? pursuitState.pursuits[0]?.id || 'empty'
            : section === 'bots'
              ? bot?.id || 'scout'
              : section === 'settings'
                ? 'workspace'
                : 'workspace-tools',
    });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setDialog(null);
        setSearchOpen((previous) => !previous);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    setTab('Messages');
    setSavedOpen(false);
    setDetailsOpen(false);
  }, [location]);

  return (
    <BrowserLayout>
      <TitleBar
        workspaceName={ai.workspace?.name}
        onSearch={() => setSearchOpen(true)}
        onBack={workspace.back}
        onForward={workspace.forward}
        canBack={workspace.canBack}
        canForward={workspace.canForward}
        onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
      />
      <div className="app-body">
        <NavigationRail
          workspaceName={ai.workspace?.name}
          section={location.section}
          onNavigate={navigateSection}
          onSettings={() => openSettings('workspace')}
          onCreate={() =>
            location.section === 'tools'
              ? setEditingWorkspace('new')
              : location.section === 'bots'
                ? setEditingBot('new')
                : setDialog('create-space')
          }
        />
        {location.section !== 'settings' && (
          <WorkspaceSidebar
            workspace={ai.workspace}
            workspaces={ai.workspaces}
            onWorkspace={ai.selectWorkspace}
            onCreateWorkspace={() => setEditingWorkspace('new')}
            location={location.section === 'bots' && bot ? { ...location, item: bot.id } : location}
            spaces={spaceState.spaces}
            pursuits={pursuitState.pursuits}
            pursuitsLoading={pursuitState.loading}
            pursuitsError={pursuitState.error}
            onSelect={select}
            collapsed={sidebarCollapsed}
            bots={ai.bots}
            botConversations={botChats.conversations}
            onCreateConversation={createBotConversation}
            onDialog={openDialog}
            onSettings={() => openSettings('workspace')}
          />
        )}
        {location.section === 'settings' ? (
          <SettingsPage
            section={
              location.item === 'appearance' || location.item === 'providers'
                ? location.item
                : 'workspace'
            }
            onSection={(next) => navigate({ section: 'settings', item: next })}
            onClose={() => {
              if (workspace.canBack) workspace.back();
              else select({ section: 'bots', item: bot?.id || 'scout' });
            }}
            workspace={ai.workspace}
            onConnectFolder={() => {
              if (ai.workspace) setEditingWorkspace(ai.workspace);
            }}
            onProvidersChanged={() => void ai.refresh()}
          />
        ) : location.section === 'tools' ? (
          <ToolsPage
            workspaceId={ai.workspaceId}
            folder={ai.workspace?.folder || null}
            onConnectFolder={() => {
              if (ai.workspace) setEditingWorkspace(ai.workspace);
            }}
          />
        ) : location.section === 'bots' ? (
          ai.loading || botChats.loading ? (
            <main className="conversation ai-main-state">
              <p>Loading your bots…</p>
            </main>
          ) : ai.error ? (
            <main className="conversation ai-main-state">
              <h2>Couldn’t connect to Mukai</h2>
              <p role="alert">{ai.error}</p>
              <button className="button" onClick={() => void ai.refresh()}>
                Try again
              </button>
            </main>
          ) : bot && !botConversation ? (
            <main className="conversation ai-main-state">
              <p role={botChats.error ? 'alert' : undefined}>
                {botChats.error || 'Loading conversations…'}
              </p>
              <button className="button" onClick={botChats.refresh}>
                Try again
              </button>
            </main>
          ) : bot && botConversation ? (
            <BotChat
              key={botConversation.id}
              bot={bot}
              conversation={botConversation}
              onNewConversation={() => createBotConversation(bot.id)}
              providers={ai.providers}
              onEdit={() => setEditingBot(bot)}
              onProviders={() => openSettings('providers')}
            />
          ) : (
            <main className="conversation ai-main-state">
              <h2>Make room for a new bot.</h2>
              <p>Create a companion with its own instructions and model.</p>
              <button className="button button--primary" onClick={() => setEditingBot('new')}>
                Create a bot
              </button>
            </main>
          )
        ) : location.section === 'spaces' ? (
          <div className="conversation-layout">
            <main className="conversation">
              {spaceState.loading ? (
                <p className="ai-caption">Loading spaces…</p>
              ) : spaceState.error ? (
                <div className="ai-main-state">
                  <p role="alert">{spaceState.error}</p>
                  <button className="button" onClick={() => void spaceState.refresh()}>
                    Try again
                  </button>
                </div>
              ) : space ? (
                <Fragment key={space.id}>
                  <ConversationHeader
                    location={location}
                    space={space}
                    tab={tab}
                    onTab={(next) => {
                      setTab(next);
                      setSavedOpen(false);
                    }}
                    detailsOpen={detailsOpen}
                    onDetails={() => setDetailsOpen(!detailsOpen)}
                    onSettings={() => openSettings('workspace')}
                    onSaved={() => setSavedOpen(true)}
                    members={ai.bots.filter((bot) => space.botIds.includes(bot.id))}
                  />
                  {tab === 'Activity' && !savedOpen ? (
                    <ActivityView onPursuit={openPursuit} onDraft={() => setDialog('draft')} />
                  ) : (
                    <SpaceChat
                      space={space}
                      providers={ai.providers}
                      onProviders={() => openSettings('providers')}
                      bots={ai.bots}
                      tab={tab}
                      savedOpen={savedOpen}
                      onCloseSaved={() => setSavedOpen(false)}
                    />
                  )}
                </Fragment>
              ) : (
                <div className="ai-chat-empty">
                  <h2>Create a space.</h2>
                  <p>Choose its bots, then start a conversation.</p>
                  <button
                    className="button button--primary"
                    onClick={() => setDialog('create-space')}
                  >
                    Create space
                  </button>
                </div>
              )}
            </main>
            {detailsOpen && space && (
              <SpaceDetails
                space={space}
                bots={ai.bots}
                onClose={() => setDetailsOpen(false)}
                onSelectBot={(id) => select({ section: 'bots', item: id })}
              />
            )}
          </div>
        ) : pursuitState.loading ? (
          <main className="conversation ai-main-state">
            <p>Loading pursuits…</p>
          </main>
        ) : pursuitState.error ? (
          <main className="conversation ai-main-state">
            <p role="alert">{pursuitState.error}</p>
            <button className="button" onClick={() => void pursuitState.refresh().catch(() => {})}>
              Try again
            </button>
          </main>
        ) : pursuit ? (
          <PursuitPage
            key={pursuit.id}
            id={pursuit.id}
            bots={ai.bots}
            onOwner={(id) => select({ section: 'bots', item: id })}
          />
        ) : (
          <main className="conversation ai-chat-empty">
            <Target size={36} />
            <h2>A little intention, on a schedule.</h2>
            <p>
              Ask a bot to create a pursuit with an objective, success criteria, and a wake-up
              schedule. That bot will own its runs.
            </p>
            {bot && (
              <button className="button" onClick={() => select({ section: 'bots', item: bot.id })}>
                Talk to {bot.name}
              </button>
            )}
          </main>
        )}
      </div>
      {searchOpen && (
        <SearchDialog
          spaces={spaceState.spaces}
          pursuits={pursuitState.pursuits}
          onSelect={select}
          onClose={() => setSearchOpen(false)}
          bots={ai.bots}
        />
      )}
      <BrowserPanel />
      <WorkspaceDialogs
        key={dialog}
        kind={dialog}
        onClose={() => setDialog(null)}
        bots={ai.bots}
        onCreateSpace={async (name, description, botIds) => {
          const created = await spaceState.create(name, description, botIds);
          select({ section: 'spaces', item: created.id });
        }}
      />
      {editingBot && (
        <BotEditor
          workspaceId={ai.workspaceId}
          bot={editingBot === 'new' ? undefined : editingBot}
          providers={ai.providers}
          onClose={() => setEditingBot(null)}
          onSaved={(saved) => {
            setEditingBot(null);
            void ai.refresh();
            select({ section: 'bots', item: saved.id });
          }}
          onDeleted={() => {
            setEditingBot(null);
            void ai.refresh();
            select({ section: 'bots', item: 'scout' });
          }}
        />
      )}
      {editingWorkspace && (
        <WorkspaceEditor
          workspace={editingWorkspace === 'new' ? undefined : editingWorkspace}
          onClose={() => setEditingWorkspace(null)}
          onSaved={(saved) => {
            setEditingWorkspace(null);
            if (saved.id === ai.workspaceId) void ai.refresh();
            else ai.selectWorkspace(saved.id);
          }}
        />
      )}
    </BrowserLayout>
  );
}
