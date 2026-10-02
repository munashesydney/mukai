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
import { agents } from '../features/workspace/data';
import type { DialogKind, Location, Section } from '../features/workspace/types';

export function App() {
  const workspace = useWorkspace();
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
  const agent = agents.find((a) => a.id === location.item);
  const messages = workspace.messages[location.item] ?? [];
  const openPursuit = () => select({ section: 'pursuits', item: 'grow-mrr' });
  const navigateSection = (section: Section) =>
    select({
      section,
      item:
        section === 'spaces'
          ? workspace.spaces[0].id
          : section === 'pursuits'
            ? workspace.pursuits[0].id
            : section === 'agents'
              ? 'nova'
              : 'integrations',
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
        onSearch={() => setSearchOpen(true)}
        onBack={workspace.back}
        onForward={workspace.forward}
        canBack={workspace.canBack}
        canForward={workspace.canForward}
        onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
      />
      <div className="app-body">
        <NavigationRail
          section={location.section}
          onNavigate={navigateSection}
          onSettings={() => setDialog('settings')}
          onCreate={() => setDialog('create-space')}
        />
        <WorkspaceSidebar
          location={location}
          spaces={workspace.spaces}
          pursuits={workspace.pursuits}
          onSelect={select}
          onDialog={setDialog}
          collapsed={sidebarCollapsed}
        />
        {location.section === 'tools' ? (
          <ToolsPage />
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
                onDialog={setDialog}
                onSaved={() => setSavedOpen(true)}
              />
              {savedOpen ? (
                <SavedView
                  messages={messages}
                  onClose={() => setSavedOpen(false)}
                  onDialog={setDialog}
                  bookmarks={workspace.bookmarks}
                  onBookmark={workspace.toggleBookmark}
                  reactions={workspace.reactions}
                  onReact={workspace.toggleReaction}
                  onPursuit={openPursuit}
                />
              ) : tab === 'Files' ? (
                <FilesView messages={messages} onDialog={setDialog} />
              ) : tab === 'Activity' ? (
                <ActivityView onPursuit={openPursuit} onDraft={() => setDialog('draft')} />
              ) : (
                <MessageFeed
                  key={`feed-${location.item}`}
                  messages={messages}
                  onDialog={setDialog}
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
                    agent
                      ? `Message ${agent.name}…`
                      : pursuit
                        ? 'Talk about this pursuit…'
                        : `Message #${space?.name ?? 'your agents'}…`
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
                onDialog={setDialog}
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
        />
      )}
      <WorkspaceDialogs
        key={dialog}
        kind={dialog}
        pursuit={pursuit}
        onClose={() => setDialog(null)}
        onCreateSpace={workspace.createSpace}
        onCreatePursuit={workspace.createPursuit}
        onTogglePaused={workspace.togglePaused}
      />
    </div>
  );
}
