import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  Brain,
  ChevronRight,
  FileText,
  FolderOpen,
  Globe,
  Puzzle,
  Search,
  Target,
  Terminal,
} from 'lucide-react';
import type { ToolInfo } from '../../../../shared/ai';
import { toolService } from '../../services/toolService';
import { errorText } from '../../utils/errors';
import { BrowserToggle } from '../browser/BrowserToggle';
import { CustomCapabilityPage } from './CustomCapabilityPage';
import { CustomCapabilities } from './CustomCapabilities';

function ToolIcon({ toolId, size = 23 }: { toolId: string; size?: number }) {
  if (toolId === 'memory') return <Brain size={size} />;
  if (toolId === 'manage_pursuit') return <Target size={size} />;
  if (toolId === 'browser') return <Globe size={size} />;
  if (toolId === 'terminal') return <Terminal size={size} />;
  return <FileText size={size} />;
}

function toolScopeNote(tool: ToolInfo, folder: string | null) {
  if (tool.id === 'memory') return 'Workspace memories · Private memories stay with their bot';
  if (tool.id === 'manage_pursuit') return 'Manages its own pursuits';
  if (tool.id === 'browser') return 'Mukai and Google Chrome';
  if (tool.id === 'terminal') return 'Local shell · Per-conversation processes';
  return folder ? 'Within this workspace folder' : 'Connect a folder to start';
}

function ToolDetail({
  tool,
  folder,
  onBack,
}: {
  tool: ToolInfo;
  folder: string | null;
  onBack: () => void;
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
            {tool.available ? 'Ready' : 'Needs a folder'}
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
        <p>{tool.scope === 'all-bots' ? 'Available to every bot' : 'Available to selected bots'}</p>
        <small>{toolScopeNote(tool, folder)}</small>
      </section>
    </div>
  );
}

export function ToolsPage({
  workspaceId,
  folder,
  onConnectFolder,
  selectedToolId,
  capabilitySection,
  onSelectTool,
}: {
  workspaceId: string;
  folder: string | null;
  onConnectFolder: () => void;
  selectedToolId: string | null;
  capabilitySection?: 'tool' | 'route';
  onSelectTool: (toolId: string | null) => void;
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
        />
      </main>
    );
  if (selectedToolId) {
    return (
      <main className="tools-page">
        {loading ? (
          <p className="ai-caption">Loading tool…</p>
        ) : selected ? (
          <ToolDetail tool={selected} folder={folder} onBack={() => onSelectTool(null)} />
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
        <BrowserToggle />
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
          : 'Small, useful capabilities. A little more room to do.'}
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
          query={query}
          section={capabilitySection}
          onSelect={(id) => onSelectTool('custom:' + id)}
        />
      )}
      <div className="workspace-tools-folder">
        <FolderOpen size={18} />
        <div>
          <strong>Workspace folder</strong>
          <p>{folder || 'Give your bots a local folder to work in.'}</p>
        </div>
        {!folder && (
          <button className="button" onClick={onConnectFolder}>
            Connect folder
          </button>
        )}
      </div>
      <div className="tools-bottom-note">
        Tools run locally. Your AI provider receives tool output, including page content and command
        results. File operations enforce folder boundaries. Terminal commands run with your OS
        account permissions and are not restricted to that folder.
      </div>
    </main>
  );
}
