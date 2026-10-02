import { useCallback, useEffect, useState } from 'react';
import { TitleBar } from '../components/layout/TitleBar';
import { NavigationRail } from '../components/layout/NavigationRail';
import { WorkspaceSidebar } from '../components/layout/WorkspaceSidebar';
import { ConversationHeader } from '../features/chat/ConversationHeader';
import { MessageFeed } from '../features/chat/MessageFeed';
import { Composer } from '../features/chat/Composer';
import { FilesView, ActivityView, SavedView } from '../features/chat/ConversationViews';
import { ContextPanel } from '../features/workspace/ContextPanel';
import { SearchDialog } from '../features/workspace/SearchDialog';
import { WorkspaceDialogs } from '../features/workspace/WorkspaceDialogs';
import { ToolsPage } from '../features/workspace/ToolsPage';
import { useWorkspace } from '../features/workspace/useWorkspace';
import { useAIWorkspace } from '../features/ai/useAIWorkspace';
import { BotChat } from '../features/ai/BotChat';
import { BotEditor } from '../features/ai/BotEditor';
import { SettingsDialog } from '../features/settings/SettingsDialog';
import { WorkspaceEditor } from '../features/workspace/WorkspaceEditor';
import type { Bot, Workspace } from '../../../shared/ai';
import type { DialogKind, Location, Section } from '../features/workspace/types';

export function App() {
  const ai = useAIWorkspace();
  return <WorkspaceApp key={ai.workspaceId} ai={ai} />;
}
function WorkspaceApp({ ai }: { ai: ReturnType<typeof useAIWorkspace> }) {
  const workspace = useWorkspace(ai.workspaceId);
  const [editingWorkspace, setEditingWorkspace] = useState<Workspace | 'new' | null>(null);
  const [editingBot, setEditingBot] = useState<Bot | 'new' | null>(null);
  const [settingsSection, setSettingsSection] = useState<'workspace' | 'providers'>('workspace');
  const [searchOpen, setSearchOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [tab, setTab] = useState('Messages');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => window.innerWidth <= 760);
  const [savedOpen, setSavedOpen] = useState(false);
  const { location, navigate } = workspace;
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
  const space = workspace.spaces.find((s) => s.id === location.item);
  const pursuit = workspace.pursuits.find((p) => p.id === location.item);
  const bot = ai.bots.find((a) => a.id === location.item) || ai.bots[0];
  const openDialog = (kind: DialogKind) => {
    if (kind === 'create-bot') setEditingBot('new');
    else {
      if (kind === 'settings') setSettingsSection('workspace');
      setDialog(kind);
    }
  };
  const messages = workspace.messages[location.item] ?? [];
  const openPursuit = () => select({ section: 'pursuits', item: 'grow-mrr' });
  const navigateSection = (section: Section) =>
    select({
      section,
      item:
        section === 'spaces'
          ? workspace.spaces[0]?.id || 'empty'
          : section === 'pursuits'
            ? workspace.pursuits[0]?.id || 'empty'
            : section === 'bots'
              ? bot?.id || 'scout'
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
    <div className="app-shell">
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
          onSettings={() => {
            setSettingsSection('workspace');
            setDialog('settings');
          }}
          onCreate={() =>
            location.section === 'tools'
              ? setEditingWorkspace('new')
              : location.section === 'bots'
                ? setEditingBot('new')
                : setDialog('create-space')
          }
        />
        <WorkspaceSidebar
          workspace={ai.workspace}
          workspaces={ai.workspaces}
          onWorkspace={ai.selectWorkspace}
          onCreateWorkspace={() => setEditingWorkspace('new')}
          location={
            location.section === 'bots' && bot ? { section: 'bots', item: bot.id } : location
          }
          spaces={workspace.spaces}
          pursuits={workspace.pursuits}
          onSelect={select}
          collapsed={sidebarCollapsed}
          bots={ai.bots}
          onDialog={openDialog}
        />
        {location.section === 'tools' ? (
          <ToolsPage
            workspaceId={ai.workspaceId}
            folder={ai.workspace?.folder || null}
            onConnectFolder={() => {
              if (ai.workspace) setEditingWorkspace(ai.workspace);
            }}
          />
        ) : location.section === 'bots' ? (
          ai.loading ? (
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
          ) : bot ? (
            <BotChat
              key={bot.id}
              bot={bot}
              providers={ai.providers}
              onEdit={() => setEditingBot(bot)}
              onProviders={() => {
                setSettingsSection('providers');
                setDialog('settings');
              }}
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
        ) : (
          <div className="conversation-layout">
            <main className="conversation">
              <ConversationHeader
                key={location.item}
                location={location}
                space={space}
                pursuit={pursuit}
                tab={tab}
                onTab={(next) => {
                  setTab(next);
                  setSavedOpen(false);
                }}
                detailsOpen={detailsOpen}
                onDetails={() => setDetailsOpen(!detailsOpen)}
                onDialog={openDialog}
                onSaved={() => setSavedOpen(true)}
              />
              {savedOpen ? (
                <SavedView
                  messages={messages}
                  onClose={() => setSavedOpen(false)}
                  onDialog={openDialog}
                  bookmarks={workspace.bookmarks}
                  onBookmark={workspace.toggleBookmark}
                  reactions={workspace.reactions}
                  onReact={workspace.toggleReaction}
                  onPursuit={openPursuit}
                />
              ) : tab === 'Artifacts' ? (
                <FilesView messages={messages} onDialog={openDialog} />
              ) : tab === 'Activity' ? (
                <ActivityView onPursuit={openPursuit} onDraft={() => setDialog('draft')} />
              ) : (
                <MessageFeed
                  key={`feed-${location.item}`}
                  messages={messages}
                  onDialog={openDialog}
                  onPursuit={openPursuit}
                  bookmarks={workspace.bookmarks}
                  onBookmark={workspace.toggleBookmark}
                  reactions={workspace.reactions}
                  onReact={workspace.toggleReaction}
                />
              )}
              {tab === 'Messages' && !savedOpen && (
                <Composer
                  key={`composer-${location.item}`}
                  placeholder={
                    pursuit ? 'Talk about this pursuit…' : `Message ${space?.name ?? 'your bots'}…`
                  }
                  onSend={workspace.sendMessage}
                />
              )}
              {workspace.storageFailed && (
                <div className="storage-warning" role="status">
                  Device storage is full or unavailable. New changes will last for this session.
                </div>
              )}
            </main>
            {detailsOpen && (
              <ContextPanel
                location={location}
                space={space}
                pursuit={pursuit}
                pursuits={workspace.pursuits}
                messages={messages}
                onSelect={select}
                onDialog={openDialog}
                onClose={() => setDetailsOpen(false)}
              />
            )}
          </div>
        )}
      </div>
      {searchOpen && (
        <SearchDialog
          spaces={workspace.spaces}
          pursuits={workspace.pursuits}
          onSelect={select}
          onClose={() => setSearchOpen(false)}
          bots={ai.bots}
        />
      )}
      <WorkspaceDialogs
        key={dialog}
        kind={dialog === 'settings' ? null : dialog}
        pursuit={pursuit}
        onClose={() => setDialog(null)}
        onCreateSpace={workspace.createSpace}
        onCreatePursuit={workspace.createPursuit}
        onTogglePaused={workspace.togglePaused}
      />
      {dialog === 'settings' && (
        <SettingsDialog
          workspace={ai.workspace}
          onConnectFolder={() => {
            setDialog(null);
            if (ai.workspace) setEditingWorkspace(ai.workspace);
          }}
          initialSection={settingsSection}
          onClose={() => setDialog(null)}
          onProvidersChanged={() => void ai.refresh()}
        />
      )}
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
    </div>
  );
}
