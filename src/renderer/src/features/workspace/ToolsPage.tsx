import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  Brain,
  BookOpen,
  ChevronRight,
  FileText,
  FolderOpen,
  Globe,
  Image,
  Puzzle,
  Search,
  Target,
  Terminal,
  Users,
  MessageCircleQuestion,
  Monitor,
} from 'lucide-react';
import type { Bot, ToolInfo } from '../../../../shared/ai';
import { ToolAssignments } from './ToolAssignments';
import { toolService } from '../../services/toolService';
import { errorText } from '../../utils/errors';
import { BrowserToggle } from '../browser/BrowserToggle';
import { CustomCapabilityPage } from './CustomCapabilityPage';
import { CustomCapabilities } from './CustomCapabilities';

function ToolIcon({ toolId, size = 23 }: { toolId: string; size?: number }) {
  if (toolId === 'skills') return <BookOpen size={size} />;
  if (toolId === 'memory') return <Brain size={size} />;
  if (toolId === 'communicate') return <MessageCircleQuestion size={size} />;
  if (toolId === 'conversations') return <Search size={size} />;
  if (toolId === 'manage_pursuit') return <Target size={size} />;
  if (toolId === 'manage_bot') return <Users size={size} />;
  if (toolId === 'browser') return <Globe size={size} />;
  if (toolId === 'computer_use') return <Monitor size={size} />;
  if (toolId === 'image') return <Image size={size} />;
  if (toolId === 'web_search') return <Search size={size} />;
  if (toolId === 'terminal') return <Terminal size={size} />;
  return <FileText size={size} />;
}

function toolScopeNote(tool: ToolInfo, folder: string | null, vm = false) {
  if (vm && ['terminal', 'browser', 'image', 'file_operations', 'computer_use'].includes(tool.id))
    return 'Runs inside the workspace Linux VM';
  if (vm && tool.id.startsWith('register_custom_')) return 'Modules run inside the Linux VM';
  if (tool.id === 'skills') return 'Workspace workflows · Loaded per bot and conversation';
  if (tool.id === 'memory') return 'Workspace memories · Shared by every bot in this workspace';
  if (tool.id === 'communicate') return 'Questions, approvals and autonomous updates';
  if (tool.id === 'conversations') return 'Workspace conversation and message history';
  if (tool.id === 'manage_pursuit') return 'Manages its own pursuits';
  if (tool.id === 'manage_bot')
    return 'Required for all bots · Actions depend on bot and conversation';
  if (tool.id === 'browser') return 'Mukai and Google Chrome';
  if (tool.id === 'computer_use') return 'Local desktop · Mouse, keyboard and screenshots';
  if (tool.id === 'image')
    return 'Local images · Includes files outside the workspace · Vision model required to view';
  if (tool.id === 'web_search') return 'Public web search and page content · No API key required';
  if (tool.id === 'terminal') return 'Local shell · Per-conversation processes';
  return folder ? 'Within this workspace folder' : 'Connect a folder to start';
}

function ToolDetail({
  tool,
  folder,
  onBack,
  workspaceId,
  bots,
  vm = false,
}: {
  tool: ToolInfo;
  folder: string | null;
  onBack: () => void;
  workspaceId: string;
  bots: Bot[];
  vm?: boolean;
}) {
  return (
    <div className="tool-detail">
      <button className="tool-detail-back" onClick={onBack}>
        <ArrowLeft size={15} /> All tools
      </button>
      <div className="tool-detail-header">
        <div className="tool-family-icon">
          <ToolIcon toolId={tool.id} />
        </div>
        <div>
          <h1>{tool.name}</h1>
          <span className={`tool-availability ${tool.available ? 'is-ready' : ''}`}>
            {tool.available ? 'Ready' : vm ? 'Unavailable in VM v1' : 'Unavailable'}
          </span>
        </div>
      </div>
      <p className="tool-detail-description">{tool.description}</p>
      <section className="tool-detail-section">
        <h2>Actions</h2>
        <div className="tool-action-chips">
          {tool.actions.map((action) => (
            <code key={action}>
              {action}
              {tool.counts[action] ? <span> ×{tool.counts[action]}</span> : null}
            </code>
          ))}
        </div>
      </section>
      <section className="tool-detail-section">
        <h2>Availability</h2>
        <p>{tool.scope === 'all-bots' ? 'Shared with every bot' : 'Available to assigned bots'}</p>
        <small>{toolScopeNote(tool, folder, vm)}</small>
      </section>
      <ToolAssignments
        workspaceId={workspaceId}
        bots={bots}
        toolId={tool.id}
        shared={tool.scope === 'all-bots'}
      />
    </div>
  );
}

export function ToolsPage({
  bots,
  workspaceId,
  folder,
  onConnectFolder,
  selectedToolId,
  capabilitySection,
  onSelectTool,
  vm = false,
}: {
  bots: Bot[];
  workspaceId: string;
  folder: string | null;
  onConnectFolder: () => void;
  selectedToolId: string | null;
  capabilitySection?: 'tool' | 'route';
  onSelectTool: (toolId: string | null) => void;
  vm?: boolean;
}) {
  const [tools, setTools] = useState<ToolInfo[]>([]),
    [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      setTools(await toolService.list(workspaceId));
      setError('');
    } catch (error) {
      setError(errorText(error));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const visible = tools.filter((tool) =>
    (tool.name + tool.description).toLowerCase().includes(query.toLowerCase()),
  );
  const selected = selectedToolId ? tools.find((tool) => tool.id === selectedToolId) : undefined;
  if (selectedToolId?.startsWith('custom:'))
    return (
      <main className="tools-page">
        <CustomCapabilityPage
          key={workspaceId + selectedToolId}
          workspaceId={workspaceId}
          id={selectedToolId.slice(7)}
          onBack={() => onSelectTool(null)}
          bots={bots}
        />
      </main>
    );
  if (selectedToolId) {
    return (
      <main className="tools-page">
        {loading ? (
          <p className="ai-caption">Loading tool…</p>
        ) : selected ? (
          <ToolDetail
            tool={selected}
            folder={folder}
            onBack={() => onSelectTool(null)}
            workspaceId={workspaceId}
            bots={bots}
            vm={vm}
          />
        ) : (
          <div className="tool-detail">
            <button className="tool-detail-back" onClick={() => onSelectTool(null)}>
              <ArrowLeft size={15} /> All tools
            </button>
            <div className="tools-empty">That tool isn’t available in this workspace.</div>
          </div>
        )}
      </main>
    );
  }
  return (
    <main className="tools-page">
      <div className="tools-topline">
        <span>
          <Puzzle size={17} /> YOUR TOOLKIT
        </span>
        <span
          className="ai-caption"
          aria-hidden={Boolean(capabilitySection)}
          hidden={false}
          style={{ visibility: capabilitySection ? 'hidden' : 'visible' }}
        >
          {tools.length} tool {tools.length === 1 ? 'family' : 'families'}
        </span>
        {!vm && <BrowserToggle />}
      </div>
      <h1>
        {capabilitySection === 'tool'
          ? 'Custom tools.'
          : capabilitySection === 'route'
            ? 'Routes.'
            : 'Tools for your bots.'}
      </h1>
      <p className="tools-intro">
        {capabilitySection
          ? 'Saved workspace modules, ready for your bots.'
          : 'Your main bot starts with every tool. Open a tool to choose which bots can use it.'}
      </p>
      <div className="tools-filter">
        <span>
          {capabilitySection === 'tool'
            ? 'Custom tools'
            : capabilitySection === 'route'
              ? 'Routes'
              : 'Workspace tools'}
        </span>
        <label>
          <Search size={16} />
          <input
            placeholder="Find a tool…"
            aria-label="Search tools"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>
      {!capabilitySection && error && (
        <div className="ai-alert" role="alert">
          {error}
          <button className="text-button" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      )}
      {!capabilitySection &&
        (loading ? (
          <p className="ai-caption">Loading tools…</p>
        ) : (
          <div className="tool-family-list">
            {visible.map((tool) => (
              <button
                key={tool.id}
                className="tool-family-card"
                onClick={() => onSelectTool(tool.id)}
              >
                <div className="tool-family-icon">
                  <ToolIcon toolId={tool.id} />
                </div>
                <div className="tool-family-body">
                  <h2 className="tool-family-name">{tool.name}</h2>
                  <p>{tool.description}</p>
                </div>
                <ChevronRight className="tool-family-arrow" size={18} />
              </button>
            ))}
          </div>
        ))}
      {!capabilitySection && !loading && !visible.length && (
        <div className="tools-empty">No tools match “{query}”.</div>
      )}
      {capabilitySection && (
        <CustomCapabilities
          workspaceId={workspaceId}
          vm={vm}
          query={query}
          section={capabilitySection}
          onSelect={(id) => onSelectTool('custom:' + id)}
        />
      )}
      <div className="workspace-tools-folder">
        <FolderOpen size={18} />
        <div>
          <strong>Workspace folder</strong>
          <p>
            {vm
              ? '/home/mukai/workspace · Linux VM'
              : folder || 'Give your bots a local folder to work in.'}
          </p>
        </div>
        {!vm && !folder && (
          <button className="button" onClick={onConnectFolder}>
            Connect folder
          </button>
        )}
      </div>
      <div className="tools-bottom-note">
        {vm ? (
          'Computer tools run inside the Linux VM. Your AI provider receives tool output. No host folders are mounted.'
        ) : (
          <>
            Tools run locally. Your AI provider receives tool output, including page content and
            command results. File operations enforce folder boundaries. Terminal commands run with
            your OS account permissions and are not restricted to that folder.
          </>
        )}
      </div>
    </main>
  );
}
