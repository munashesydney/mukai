import { SkillsPage } from '../features/workspace/SkillsPage';
import { Target, Plus } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { TitleBar } from '../components/layout/TitleBar';
import { NavigationRail } from '../components/layout/NavigationRail';
import { WorkspaceSidebar } from '../components/layout/WorkspaceSidebar';
import { SearchDialog } from '../features/workspace/SearchDialog';
import { WorkspaceDialogs } from '../features/workspace/WorkspaceDialogs';
import { ToolsPage } from '../features/workspace/ToolsPage';
import { useWorkspace } from '../features/workspace/useWorkspace';
import { useAIWorkspace } from '../features/ai/useAIWorkspace';
import { useSpaces } from '../features/workspace/useSpaces';
import { SpaceConversation } from '../features/chat/SpaceConversation';
import { usePursuits } from '../features/pursuits/usePursuits';
import { PursuitPage } from '../features/pursuits/PursuitPage';
import { BotChat } from '../features/ai/BotChat';
import { BotHierarchyPage } from '../features/ai/BotHierarchyPage';
import { PendingApprovalsPage } from '../features/ai/PendingApprovalsPage';
import { approvalStore, useApprovals } from '../features/ai/approvalStore';
import { approvalLocation } from '../features/ai/approvalLocation';
import { useBotConversations } from '../features/ai/useBotConversations';
import { BotEditor } from '../features/ai/BotEditor';
import { SettingsPage } from '../features/settings/SettingsPage';
import { WorkspaceEditor } from '../features/workspace/WorkspaceEditor';
import type { Bot, Workspace } from '../../../shared/ai';
import type { DialogKind, Location, Section, SettingsSection } from '../features/workspace/types';
import { BrowserPanel } from '../features/browser/BrowserPanel';
import { BrowserLayout, BrowserWorkspace } from '../features/browser/BrowserWorkspace';
import { ConversationNavigation } from '../features/ai/ConversationNavigation';
import { ComputerPanel } from '../features/computer/ComputerPanel';
import { useNotifications } from '../features/notifications/useNotifications';
import { NotificationsPage } from '../features/notifications/NotificationsPage';
import { TelegramPage } from '../features/telegram/TelegramPage';

function WorkspaceLayout({
  children,
  onOpen,
}: {
  children: ReactNode;
  onOpen: (conversationId: string) => void;
}) {
  return (
    <ConversationNavigation.Provider value={onOpen}>
      <BrowserLayout>{children}</BrowserLayout>
    </ConversationNavigation.Provider>
  );
}

export function App() {
  const ai = useAIWorkspace();
  if (!ai.workspace) return <EmptyWorkspaces ai={ai} />;
  return (
    <BrowserWorkspace key={ai.workspaceId} workspaceId={ai.workspaceId}>
      <WorkspaceApp ai={ai} />
    </BrowserWorkspace>
  );
}
function EmptyWorkspaces({ ai }: { ai: ReturnType<typeof useAIWorkspace> }) {
  const [creating, setCreating] = useState(false);
  return (
    <div className="app-shell">
      <TitleBar
        workspaceName="Mukai"
        disabled
        onSearch={() => {}}
        onBack={() => {}}
        onForward={() => {}}
        canBack={false}
        canForward={false}
        onToggleSidebar={() => {}}
      />
      <div className="app-body">
        <div className="workspace-navigation is-compact">
          <NavigationRail
            disabled
            workspaceName="Mukai"
            onNavigate={() => {}}
            onSettings={() => {}}
            onCreate={() => {}}
          />
        </div>
        <div className="workspace-content">
          <main className="conversation ai-main-state workspace-onboarding workspace-first-run">
            {ai.loading ? (
              <p role="status">Loading your workspaces…</p>
            ) : ai.error ? (
              <>
                <h2>Couldn’t connect to Mukai</h2>
                <p role="alert">{ai.error}</p>
                <button className="button" onClick={() => void ai.refresh()}>
                  Try again
                </button>
              </>
            ) : (
              <>
                <span className="context-section-label">WELCOME TO MUKAI</span>
                <h2>Create your first workspace.</h2>
                <p>
                  A home for your bots, ideas, and the work ahead. Each workspace keeps its own
                  conversations and files together.
                </p>
                <button className="button button--primary" onClick={() => setCreating(true)}>
                  <Plus size={17} /> Create workspace
                </button>
                <small>Choose a project folder or a Linux computer to get started.</small>
              </>
            )}
          </main>
        </div>
      </div>
      {creating && (
        <WorkspaceEditor
          onClose={() => setCreating(false)}
          onSaved={(saved) => {
            setCreating(false);
            ai.selectWorkspace(saved.id);
          }}
        />
      )}
    </div>
  );
}
function WorkspaceApp({ ai }: { ai: ReturnType<typeof useAIWorkspace> }) {
  useLayoutEffect(() => {
    approvalStore.setWorkspace(ai.workspaceId);
  }, [ai.workspaceId]);
  const approvals = useApprovals();
  const workspace = useWorkspace(ai.workspaceId);
  const spaceState = useSpaces(ai.workspaceId);
  const pursuitState = usePursuits(ai.workspaceId);
  const botChats = useBotConversations(ai.workspaceId);
  const botPairs = useBotConversations(ai.workspaceId, 'bot');
  const notifications = useNotifications(ai.workspaceId);
  const [editingWorkspace, setEditingWorkspace] = useState<Workspace | 'new' | null>(null);
  const [editingBot, setEditingBot] = useState<Bot | 'new' | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [tab, setTab] = useState('Messages');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.innerWidth <= 760);
  const [savedOpen, setSavedOpen] = useState(false);
  const [computerOpen, setComputerOpen] = useState(false);
  const viewingComputer =
    computerOpen && ai.workspace?.computer === 'qemu' && !ai.workspace.deleting;
  const { location, navigate, replace } = workspace;
  const hasBots = ai.bots.length > 0;
  useEffect(() => {
    if (
      !ai.loading &&
      !hasBots &&
      location.section !== 'bots' &&
      location.section !== 'settings' &&
      location.section !== 'telegram'
    )
      replace({ section: 'bots', item: 'empty' });
  }, [ai.loading, hasBots, location.section, replace]);
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
      if (
        !hasBots &&
        next.section !== 'bots' &&
        next.section !== 'settings' &&
        next.section !== 'telegram'
      )
        return;
      navigate(next);
      setTab('Messages');
      setSavedOpen(false);
      if (window.innerWidth <= 760) setSidebarCollapsed(true);
    },
    [navigate, hasBots],
  );
  const space = spaceState.spaces.find((s) => s.id === location.item);
  const botPair = botPairs.conversations.find((chat) => chat.id === location.conversationId);
  const pairBot = ai.bots.find((bot) => bot.id === botPair?.botIds[1]);
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
      location.item !== 'hierarchy' &&
      location.item !== 'bot-conversations' &&
      location.view !== 'pending-approvals' &&
      bot &&
      botConversation &&
      location.conversationId !== botConversation.id
    )
      replace({ section: 'bots', item: bot.id, conversationId: botConversation.id });
  }, [
    location.section,
    location.item,
    location.conversationId,
    location.view,
    bot,
    botConversation,
    replace,
  ]);
  async function createBotConversation(botId: string) {
    const conversation = await botChats.create(botId);
    select({ section: 'bots', item: botId, conversationId: conversation.id });
  }
  async function openBotConversation(botId: string) {
    const existing = botChats.conversations
      .filter((chat) => chat.ownerBotId === botId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (existing) select({ section: 'bots', item: botId, conversationId: existing.id });
    else await createBotConversation(botId);
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
      if (event.target instanceof Element && event.target.closest('.computer-canvas')) return;
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
    <WorkspaceLayout
      onOpen={(conversationId) => {
        botPairs.refresh();
        select({ section: 'bots', item: 'bot-conversations', conversationId });
      }}
    >
      <TitleBar
        computerOpen={viewingComputer}
        onComputer={
          ai.workspace?.computer === 'qemu' && !ai.workspace.deleting
            ? () => {
                if (
                  !computerOpen &&
                  ((location.section !== 'bots' && location.section !== 'spaces') ||
                    location.item === 'hierarchy' ||
                    location.view === 'pending-approvals') &&
                  bot
                )
                  select({ section: 'bots', item: bot.id, conversationId: botConversation?.id });
                setDetailsOpen(false);
                setComputerOpen(!computerOpen);
              }
            : undefined
        }
        workspaceName={ai.workspace?.name}
        onSearch={() => setSearchOpen(true)}
        onBack={workspace.back}
        onForward={workspace.forward}
        canBack={workspace.canBack}
        canForward={workspace.canForward}
        onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
      />
      <div className={`app-body ${viewingComputer ? 'computer-mode' : ''}`}>
        <div
          className={`workspace-navigation ${sidebarCollapsed || location.section === 'settings' || location.section === 'notifications' || location.section === 'telegram' ? 'is-compact' : ''}`}
          inert={viewingComputer}
          aria-hidden={viewingComputer}
        >
          <NavigationRail
            notificationCount={notifications.total}
            unreadNotifications={notifications.unread}
            hasPendingApprovals={approvals.pending.length > 0}
            hasBots={hasBots}
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
          {location.section !== 'settings' &&
            location.section !== 'notifications' &&
            location.section !== 'telegram' && (
              <WorkspaceSidebar
                workspace={ai.workspace}
                workspaces={ai.workspaces}
                onWorkspace={ai.selectWorkspace}
                onCreateWorkspace={() => setEditingWorkspace('new')}
                location={
                  location.section === 'bots' &&
                  location.item !== 'hierarchy' &&
                  location.item !== 'bot-conversations' &&
                  bot
                    ? { ...location, item: bot.id }
                    : location
                }
                spaces={spaceState.spaces}
                pursuits={pursuitState.pursuits}
                pursuitsLoading={pursuitState.loading}
                pursuitsError={pursuitState.error}
                onSelect={select}
                collapsed={sidebarCollapsed}
                bots={ai.bots}
                botConversations={botChats.conversations}
                botPairConversations={botPairs.conversations}
                botPairLoading={botPairs.loading}
                botPairError={botPairs.error}
                onRefreshBotPairs={botPairs.refresh}
                onCreateConversation={createBotConversation}
                onDialog={openDialog}
                onSettings={() => openSettings('workspace')}
              />
            )}
        </div>
        <div className="workspace-content">
          {location.section === 'settings' ? (
            <SettingsPage
              section={
                location.item === 'appearance' ||
                location.item === 'updates' ||
                location.item === 'providers' ||
                location.item === 'environment' ||
                location.item === 'routes' ||
                location.item === 'limits' ||
                location.item === 'memory'
                  ? location.item
                  : 'workspace'
              }
              onSection={(next) => navigate({ section: 'settings', item: next })}
              workspace={ai.workspace}
              onDeleteWorkspace={ai.deleteWorkspace}
              onConnectFolder={() => {
                if (ai.workspace) setEditingWorkspace(ai.workspace);
              }}
              onProvidersChanged={() => void ai.refresh()}
            />
          ) : location.section === 'telegram' ? (
            <TelegramPage />
          ) : location.section === 'notifications' ? (
            <NotificationsPage
              workspaceId={ai.workspaceId}
              inbox={notifications}
              onGoToBots={() => navigateSection('bots')}
              onOpenSoftwareUpdates={() => openSettings('updates')}
              onOpen={(conversation) => {
                botChats.include(conversation);
                select({
                  section: 'bots',
                  item: conversation.ownerBotId!,
                  conversationId: conversation.id,
                });
              }}
            />
          ) : location.section === 'tools' && location.item === 'skills' ? (
            <SkillsPage
              key={ai.workspaceId}
              workspaceId={ai.workspaceId}
              folder={ai.workspace?.folder || null}
              onConnectFolder={() => {
                if (ai.workspace) setEditingWorkspace(ai.workspace);
              }}
            />
          ) : location.section === 'tools' ? (
            <ToolsPage
              vm={ai.workspace?.computer === 'qemu' && !ai.workspace.deleting}
              bots={ai.bots}
              workspaceId={ai.workspaceId}
              folder={ai.workspace?.folder || null}
              onConnectFolder={() => {
                if (ai.workspace) setEditingWorkspace(ai.workspace);
              }}
              selectedToolId={
                ['workspace-tools', 'custom-tools', 'custom-routes'].includes(location.item)
                  ? null
                  : location.item
              }
              capabilitySection={
                location.item === 'custom-tools'
                  ? 'tool'
                  : location.item === 'custom-routes'
                    ? 'route'
                    : undefined
              }
              onSelectTool={(toolId) =>
                select({ section: 'tools', item: toolId ?? 'workspace-tools' })
              }
            />
          ) : location.section === 'bots' && location.item === 'hierarchy' ? (
            <BotHierarchyPage
              bots={ai.bots}
              loading={ai.loading}
              error={ai.error}
              onOpen={(id) => select({ section: 'bots', item: id })}
              onCreate={() => setEditingBot('new')}
            />
          ) : location.section === 'bots' && location.view === 'pending-approvals' && bot ? (
            <PendingApprovalsPage
              bot={bot}
              onOpen={(request) => select(approvalLocation(request))}
            />
          ) : location.section === 'bots' && location.item === 'bot-conversations' ? (
            botPair && pairBot ? (
              <BotChat
                key={botPair.id}
                bot={pairBot}
                bots={ai.bots}
                conversation={botPair}
                providers={ai.providers}
                onNewConversation={() => createBotConversation(pairBot.id)}
                onEdit={() => setEditingBot(pairBot)}
                onProviders={() => openSettings('providers')}
                onBotChanged={ai.updateBot}
                onOpenBot={openBotConversation}
                onViewComputer={() => setComputerOpen(true)}
              />
            ) : (
              <main className="conversation ai-main-state">
                <p role={botPairs.error ? 'alert' : undefined}>
                  {botPairs.error ||
                    (botPairs.loading
                      ? 'Loading bot conversations…'
                      : 'Choose a conversation between two bots.')}
                </p>
                {botPairs.error && (
                  <button className="button" onClick={botPairs.refresh}>
                    Try again
                  </button>
                )}
              </main>
            )
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
                bots={ai.bots}
                conversation={botConversation}
                onNewConversation={() => createBotConversation(bot.id)}
                providers={ai.providers}
                onEdit={() => setEditingBot(bot)}
                onProviders={() => openSettings('providers')}
                onBotChanged={ai.updateBot}
                onOpenBot={openBotConversation}
                onViewComputer={() => setComputerOpen(true)}
              />
            ) : (
              <main className="conversation ai-main-state workspace-onboarding">
                <span className="context-section-label">YOUR WORKSPACE STARTS HERE</span>
                <h2>Meet your first bot.</h2>
                <p>
                  A thinking partner for your ideas, pursuits, and the work ahead. Give it a name
                  and make it yours.
                </p>
                <button className="button button--primary" onClick={() => setEditingBot('new')}>
                  <Plus size={17} /> Add your first bot
                </button>
                <small>
                  Your first bot leads the workspace and starts with all tools.
                  <br />
                  You can connect an AI provider after creating it.
                </small>
              </main>
            )
          ) : location.section === 'spaces' ? (
            space && !spaceState.loading && !spaceState.error ? (
              <SpaceConversation
                key={space.id}
                space={space}
                bots={ai.bots}
                providers={ai.providers}
                location={location}
                tab={tab}
                onTab={(next) => {
                  setTab(next);
                  setSavedOpen(false);
                }}
                savedOpen={savedOpen}
                onSaved={() => setSavedOpen(true)}
                onCloseSaved={() => setSavedOpen(false)}
                detailsOpen={detailsOpen}
                onDetails={() => setDetailsOpen(!detailsOpen)}
                onCloseDetails={() => setDetailsOpen(false)}
                onSelectBot={(id) => select({ section: 'bots', item: id })}
                onProviders={() => openSettings('providers')}
                onSettings={() => openSettings('workspace')}
                onOpenBot={openBotConversation}
                onViewComputer={() => setComputerOpen(true)}
                onPursuit={openPursuit}
                onDraft={() => setDialog('draft')}
              />
            ) : (
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
              </div>
            )
          ) : pursuitState.loading ? (
            <main className="conversation ai-main-state">
              <p>Loading pursuits…</p>
            </main>
          ) : pursuitState.error ? (
            <main className="conversation ai-main-state">
              <p role="alert">{pursuitState.error}</p>
              <button
                className="button"
                onClick={() => void pursuitState.refresh().catch(() => {})}
              >
                Try again
              </button>
            </main>
          ) : pursuit ? (
            <PursuitPage
              key={`${pursuit.id}:${location.runId || ''}`}
              id={pursuit.id}
              runId={location.runId}
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
                <button
                  className="button"
                  onClick={() => select({ section: 'bots', item: bot.id })}
                >
                  Talk to {bot.name}
                </button>
              )}
            </main>
          )}
        </div>
        {ai.workspace?.computer === 'qemu' && !ai.workspace.deleting && (
          <ComputerPanel
            workspaceId={ai.workspaceId}
            open={viewingComputer}
            onClose={() => setComputerOpen(false)}
          />
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
      {ai.workspace?.computer !== 'qemu' && <BrowserPanel />}
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
          isFirst={!hasBots}
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
    </WorkspaceLayout>
  );
}
