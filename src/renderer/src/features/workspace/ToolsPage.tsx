import { useCallback, useEffect, useState } from 'react';
import { FileText, FolderOpen, Puzzle, Search, Target } from 'lucide-react';
import type { ToolInfo } from '../../../../shared/ai';
import { toolService } from '../../services/toolService';
import { errorText } from '../../utils/errors';

export function ToolsPage({
  workspaceId,
  folder,
  onConnectFolder,
}: {
  workspaceId: string;
  folder: string | null;
  onConnectFolder: () => void;
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
  return (
    <main className="tools-page">
      <div className="tools-topline">
        <span>
          <Puzzle size={17} /> YOUR TOOLKIT
        </span>
        <span className="ai-caption">
          {tools.length} tool {tools.length === 1 ? 'family' : 'families'}
        </span>
      </div>
      <h1>Tools for your bots.</h1>
      <p className="tools-intro">Small, useful capabilities. A little more room to do.</p>
      <div className="tools-filter">
        <span>Workspace tools</span>
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
      {error && (
        <div className="ai-alert" role="alert">
          {error}
          <button className="text-button" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      )}
      {loading ? (
        <p className="ai-caption">Loading tools…</p>
      ) : (
        <div className="tool-family-list">
          {visible.map((tool) => (
            <article key={tool.id} className="tool-family-card">
              <div className="tool-family-icon">
                {tool.id === 'manage_pursuit' ? <Target size={23} /> : <FileText size={23} />}
              </div>
              <div className="tool-family-body">
                <div className="tool-family-title">
                  <h2>{tool.name}</h2>
                  <span className={`tool-availability ${tool.available ? 'is-ready' : ''}`}>
                    {tool.available ? 'Ready' : 'Needs a folder'}
                  </span>
                </div>
                <p>{tool.description}</p>
                <div className="tool-action-chips">
                  {tool.actions.map((action) => (
                    <code key={action}>
                      {action}
                      {tool.counts[action] ? <span> ×{tool.counts[action]}</span> : null}
                    </code>
                  ))}
                </div>
                <small>
                  {tool.scope === 'all-bots'
                    ? 'Available to every bot'
                    : 'Available to selected bots'}{' '}
                  ·{' '}
                  {tool.id === 'manage_pursuit'
                    ? 'Manages its own pursuits'
                    : folder
                      ? 'Within this workspace folder'
                      : 'Connect a folder to start'}
                </small>
              </div>
            </article>
          ))}
        </div>
      )}
      {!loading && !visible.length && <div className="tools-empty">No tools match “{query}”.</div>}
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
        File operations run locally. Your chosen AI provider receives file content returned by
        tools. Links, credential files, and paths outside this folder are blocked.
      </div>
    </main>
  );
}
