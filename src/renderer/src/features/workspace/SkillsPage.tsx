import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  ChevronRight,
  Download,
  FileText,
  FolderOpen,
  Plus,
  RefreshCw,
  Search,
  Upload,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { SkillBundle, SkillDetail, SkillFile, SkillInfo } from '../../../../shared/skills';
import { skillService } from '../../services/skillService';
import { Sheet } from '../../components/ui/Sheet';
import { IconButton } from '../../components/ui/IconButton';
import { Checkbox } from '../../components/ui/Checkbox';
import { errorText } from '../../utils/errors';

const markdownBody = (value: string) => value.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
const markdownComponents = {
  img: () => <span className="ai-caption">[Image asset — see supporting files]</span>,
};
const initialSkill =
  '---\nname: my-skill\ndescription: Describe when a bot should use this skill.\n---\n\n# My skill\n\nDescribe the workflow, expected inputs, and how to verify the result.\n';
export function SkillsPage({
  workspaceId,
  folder,
  onConnectFolder,
}: {
  workspaceId: string;
  folder: string | null;
  onConnectFolder: () => void;
}) {
  const [items, setItems] = useState<SkillInfo[]>([]),
    [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SkillDetail | null>(null),
    [filePath, setFilePath] = useState('SKILL.md');
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<'edit' | 'import' | null>(null),
    [removing, setRemoving] = useState(false);
  const [draft, setDraft] = useState<SkillBundle>({ files: [] }),
    [draftPath, setDraftPath] = useState('SKILL.md'),
    [newPath, setNewPath] = useState('');
  const [url, setUrl] = useState(''),
    [preview, setPreview] = useState<SkillBundle | null>(null);
  const [editing, setEditing] = useState<SkillDetail | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const requestSequence = useRef(0);
  const cancelSelection = useCallback(() => {
    requestSequence.current++;
  }, []);
  const refresh = useCallback(async () => {
    setItems(await skillService.list(workspaceId));
  }, [workspaceId]);
  useEffect(() => {
    let live = true;
    void skillService
      .list(workspaceId)
      .then((value) => {
        if (live) setItems(value);
      })
      .catch((error) => {
        if (live) setError(errorText(error));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      cancelSelection();
    };
  }, [workspaceId, cancelSelection]);
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await refresh();
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function choose(id: string) {
    const sequence = ++requestSequence.current;
    setBusy(true);
    setError('');
    try {
      const detail = await skillService.inspect(workspaceId, id);
      if (sequence === requestSequence.current) {
        setSelected(detail);
        setFilePath('SKILL.md');
        setRemoving(false);
      }
    } catch (error) {
      if (sequence === requestSequence.current) setError(errorText(error));
    } finally {
      if (sequence === requestSequence.current) setBusy(false);
    }
  }
  function edit(skill: SkillDetail | null) {
    setEditing(skill);
    setDraft({
      files: skill?.files.map((file) => ({ ...file })) || [
        { path: 'SKILL.md', encoding: 'utf8', content: initialSkill },
      ],
      ...(skill?.source ? { source: skill.source } : {}),
    });
    setDraftPath('SKILL.md');
    setNewPath('');
    setError('');
    setDialog('edit');
  }
  function exportSkill() {
    if (!selected) return;
    const bundle: SkillBundle = {
      files: selected.files,
      ...(selected.source ? { source: selected.source } : {}),
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = selected.name + '.skill.json';
    link.click();
    URL.revokeObjectURL(url);
  }
  const visible = items.filter((item) =>
    (item.name + ' ' + item.description).toLowerCase().includes(query.toLowerCase()),
  );
  const activeFile = selected?.files.find((file) => file.path === filePath);
  const draftFile = draft.files.find((file) => file.path === draftPath);
  const close = () => {
    if (!busy) {
      setDialog(null);
      setError('');
    }
  };
  return (
    <main className="tools-page skills-page">
      <div className="tools-topline">
        <span>
          <BookOpen size={17} /> WORKSPACE SKILLS
        </span>
        <span className="ai-caption">
          {items.length} {items.length === 1 ? 'skill' : 'skills'}
        </span>
      </div>
      {error && !dialog && (
        <div className="ai-alert" role="alert">
          {error}
          <button className="text-button" disabled={busy} onClick={() => void perform(refresh)}>
            Try again
          </button>
        </div>
      )}
      {notice && (
        <p className="ai-notice" role="status">
          {notice}
        </p>
      )}
      {selected ? (
        <div className="tool-detail skill-detail">
          <button
            className="tool-detail-back"
            onClick={() => {
              setSelected(null);
              setRemoving(false);
              setError('');
            }}
          >
            <ArrowLeft size={15} /> All skills
          </button>
          <div className="tool-detail-header">
            <div className="tool-family-icon">
              <BookOpen size={23} />
            </div>
            <div>
              <h1>{selected.name}</h1>
              <span className={`tool-availability ${selected.enabled ? 'is-ready' : ''}`}>
                {selected.enabled ? 'Enabled' : 'Disabled'} · {selected.fileCount} files
              </span>
            </div>
          </div>
          <p className="tool-detail-description">{selected.description}</p>
          <div className="skill-actions">
            <label className="skill-enabled">
              <Checkbox
                checked={selected.enabled}
                disabled={busy}
                onChange={(event) =>
                  void perform(async () => {
                    setSelected(
                      await skillService.enable(workspaceId, selected.id, event.target.checked),
                    );
                  })
                }
              />
              Available to workspace bots
            </label>
            <button className="button" disabled={busy} onClick={() => edit(selected)}>
              Edit skill
            </button>
            <button className="button button--ghost" onClick={exportSkill}>
              <Download size={15} />
              Export
            </button>
          </div>
          <section className="tool-detail-section">
            <h2>Instructions & supporting files</h2>
            <div className="skill-file-browser">
              <label>
                File
                <select
                  aria-label="Skill file"
                  value={filePath}
                  onChange={(event) => setFilePath(event.target.value)}
                >
                  {selected.files.map((file) => (
                    <option key={file.path}>{file.path}</option>
                  ))}
                </select>
              </label>
              <span className="ai-caption">
                {activeFile?.encoding === 'base64'
                  ? 'Binary asset'
                  : 'Saved source · never executed on import'}
              </span>
            </div>
            {activeFile?.encoding === 'base64' ? (
              <div className="tools-empty">
                This binary asset is preserved in the skill bundle. Export the skill to download it.
              </div>
            ) : filePath.endsWith('.md') ? (
              <div className="skill-markdown">
                <ReactMarkdown components={markdownComponents}>
                  {filePath === 'SKILL.md'
                    ? markdownBody(activeFile?.content || '')
                    : activeFile?.content || ''}
                </ReactMarkdown>
              </div>
            ) : (
              <pre className="skill-source">{activeFile?.content}</pre>
            )}
          </section>
          <section className="tool-detail-section">
            <h2>Source & requirements</h2>
            <p>
              {selected.source ? (
                <>
                  <a href={selected.source.url} target="_blank" rel="noreferrer">
                    {selected.source.repository}
                  </a>{' '}
                  · <code>{selected.source.commit.slice(0, 12)}</code>
                </>
              ) : (
                'Created locally'
              )}
            </p>
            {selected.requirements.map((requirement) => (
              <p key={requirement}>{requirement}</p>
            ))}
            <small>
              Skills provide instructions. Any required tools, connectors, or dependencies must be
              configured separately.
            </small>
            <p className="ai-caption">
              Version {selected.version.slice(0, 12)} · Updated{' '}
              {new Date(selected.updatedAt).toLocaleString()}
            </p>
          </section>
          {selected.source && (
            <button
              className="button"
              disabled={busy}
              onClick={() => {
                setEditing(selected);
                setUrl(selected.source!.url);
                setPreview(null);
                setError('');
                setDialog('import');
              }}
            >
              Preview source update
            </button>
          )}
          <div className="skill-remove">
            <button className="text-button" disabled={busy} onClick={() => setRemoving(true)}>
              Remove skill
            </button>
            {removing && (
              <div className="memory-confirm">
                <p>
                  Remove {selected.name} and its files from this workspace? It will also be unloaded
                  from bot conversations.
                </p>
                <button
                  className="button button--danger"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      await skillService.remove(workspaceId, selected.id);
                      setSelected(null);
                      setRemoving(false);
                      setNotice('Skill removed.');
                    })
                  }
                >
                  Remove skill
                </button>
                <button
                  className="button button--ghost"
                  disabled={busy}
                  onClick={() => setRemoving(false)}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="skill-heading">
            <div className="skill-heading-copy">
              <h1>Skills for your bots.</h1>
              <p className="tools-intro">
                Reusable workflows for your bots. Find the right skill, then bring it into the
                conversation.
              </p>
            </div>
            <div className="skill-actions">
              <button className="button button--primary" onClick={() => edit(null)}>
                <Plus size={15} />
                Create skill
              </button>
              <button
                className="button"
                onClick={() => {
                  setEditing(null);
                  setUrl('');
                  setPreview(null);
                  setError('');
                  setDialog('import');
                }}
              >
                <Upload size={15} />
                Import skill
              </button>
              <IconButton
                label="Refresh skills"
                disabled={busy}
                onClick={() => void perform(refresh)}
              >
                <RefreshCw size={16} />
              </IconButton>
            </div>
          </div>
          <div className="tools-filter">
            <span>Workspace skills</span>
            <label>
              <Search size={16} />
              <input
                aria-label="Search skills"
                placeholder="Find a skill…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
          {loading ? (
            <p className="ai-caption" role="status">
              Loading skills…
            </p>
          ) : (
            <div className="tool-family-list">
              {visible.map((skill) => (
                <button
                  className="tool-family-card"
                  disabled={busy}
                  key={skill.id}
                  onClick={() => void choose(skill.id)}
                >
                  <div className="tool-family-icon">
                    <BookOpen size={23} />
                  </div>
                  <div className="tool-family-body">
                    <h2 className="tool-family-name">{skill.name}</h2>
                    <p>{skill.description}</p>
                    <span className={`tool-availability ${skill.enabled ? 'is-ready' : ''}`}>
                      {skill.enabled ? 'Enabled' : 'Disabled'} · {skill.fileCount}{' '}
                      {skill.fileCount === 1 ? 'file' : 'files'} ·{' '}
                      {skill.source ? 'GitHub' : 'Local'}
                    </span>
                  </div>
                  <ChevronRight className="tool-family-arrow" size={18} />
                </button>
              ))}
            </div>
          )}
          {!loading && !error && !visible.length && (
            <div className="tools-empty">
              {query ? 'No skills match your search.' : 'No skills yet.'}
            </div>
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
            Skills are shared within this workspace. Bots load only the workflows they need.
            Imported scripts and assets are saved without being executed.
          </div>
        </>
      )}
      {dialog === 'edit' && (
        <Sheet title={editing ? 'Edit skill' : 'Create skill'} onClose={close}>
          <div className="bot-editor-body capability-sheet-body">
            {error && (
              <div className="ai-alert" role="alert">
                {error}
              </div>
            )}
            <form
              className="ai-form capability-form"
              onSubmit={(event) => {
                event.preventDefault();
                void perform(async () => {
                  const saved = await skillService.save(
                    workspaceId,
                    draft,
                    editing?.id,
                    editing?.version,
                  );
                  setSelected(saved);
                  setFilePath('SKILL.md');
                  setDialog(null);
                  setNotice('Skill saved. Bots can find and load it.');
                });
              }}
            >
              <p className="ai-caption">
                SKILL.md defines the name, description, and workflow. Add references, templates, or
                scripts as supporting files.
              </p>
              <label>
                Editing file
                <select
                  aria-label="Editing skill file"
                  value={draftPath}
                  onChange={(event) => setDraftPath(event.target.value)}
                >
                  {draft.files.map((file) => (
                    <option key={file.path}>{file.path}</option>
                  ))}
                </select>
              </label>
              {draftFile?.encoding === 'base64' ? (
                <p className="ai-caption">
                  Binary asset preserved. Replace it by importing an updated skill bundle.
                </p>
              ) : (
                <label>
                  File contents
                  <textarea
                    className="skill-editor"
                    disabled={busy}
                    spellCheck={false}
                    required
                    value={draftFile?.content || ''}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        files: current.files.map((file) =>
                          file.path === draftPath ? { ...file, content: event.target.value } : file,
                        ),
                      }))
                    }
                  />
                </label>
              )}
              <div className="skill-add-file">
                <label>
                  New relative path
                  <input
                    placeholder="references/example.md"
                    value={newPath}
                    onChange={(event) => setNewPath(event.target.value)}
                  />
                </label>
                <button
                  className="button"
                  type="button"
                  disabled={busy || !newPath.trim()}
                  onClick={() => {
                    const path = newPath.trim();
                    if (draft.files.some((file) => file.path === path)) {
                      setError('This file already exists.');
                      return;
                    }
                    setDraft((current) => ({
                      ...current,
                      files: [...current.files, { path, content: '', encoding: 'utf8' }],
                    }));
                    setDraftPath(path);
                    setNewPath('');
                  }}
                >
                  Add file
                </button>
                {draftPath !== 'SKILL.md' && (
                  <IconButton
                    label="Remove supporting file"
                    disabled={busy}
                    onClick={() => {
                      setDraft((current) => ({
                        ...current,
                        files: current.files.filter((file) => file.path !== draftPath),
                      }));
                      setDraftPath('SKILL.md');
                    }}
                  >
                    <X size={16} />
                  </IconButton>
                )}
              </div>
              <div className="ai-form-actions">
                <button
                  className="button button--ghost"
                  type="button"
                  disabled={busy}
                  onClick={close}
                >
                  Cancel
                </button>
                <button className="button button--primary" disabled={busy}>
                  {busy ? 'Saving…' : 'Save skill'}
                </button>
              </div>
            </form>
          </div>
        </Sheet>
      )}
      {dialog === 'import' && (
        <Sheet title={editing ? 'Update from source' : 'Import a skill'} onClose={close}>
          <div className="bot-editor-body capability-sheet-body">
            {error && (
              <div className="ai-alert" role="alert">
                {error}
              </div>
            )}
            <form
              className="ai-form capability-form"
              onSubmit={(event) => {
                event.preventDefault();
                void perform(async () => {
                  setPreview(await skillService.preview(workspaceId, url));
                });
              }}
            >
              <label>
                GitHub skill URL
                <input
                  type="url"
                  required
                  placeholder="https://github.com/owner/repo/blob/main/skills/example/SKILL.md"
                  value={url}
                  disabled={busy}
                  onChange={(event) => {
                    setUrl(event.target.value);
                    setPreview(null);
                  }}
                />
              </label>
              <p className="ai-caption">
                Paste a SKILL.md or folder URL. Mukai imports the complete folder at a pinned
                commit, including references, scripts, and assets.
              </p>
              <div className="ai-form-actions">
                <button className="button" disabled={busy}>
                  {busy ? 'Fetching…' : 'Preview import'}
                </button>
                <button
                  className="button button--ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => importInput.current?.click()}
                >
                  Open exported bundle
                </button>
              </div>
            </form>
            <input
              hidden
              ref={importInput}
              type="file"
              accept="application/json,.json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file)
                  void perform(async () => {
                    if (file.size > 16 * 1024 * 1024)
                      throw new Error('Skill bundle exceeds 16 MB.');
                    const bundle = JSON.parse(await file.text()) as SkillBundle;
                    if (
                      !Array.isArray(bundle.files) ||
                      !bundle.files.some((file: SkillFile) => file.path === 'SKILL.md')
                    )
                      throw new Error('Choose an exported skill bundle with SKILL.md.');
                    setPreview(bundle);
                  });
              }}
            />
            {preview && (
              <div className="skill-import-preview">
                <h3>Review skill folder</h3>
                <p className="ai-caption">
                  {preview.files.length} files
                  {preview.source ? ' · Commit ' + preview.source.commit.slice(0, 12) : ''}
                </p>
                <div className="skill-markdown">
                  <ReactMarkdown components={markdownComponents}>
                    {markdownBody(
                      preview.files.find((file) => file.path === 'SKILL.md')?.content || '',
                    )}
                  </ReactMarkdown>
                </div>
                <details>
                  <summary>Included files</summary>
                  {preview.files.map((file) => (
                    <p key={file.path}>
                      <FileText size={13} /> {file.path}
                    </p>
                  ))}
                </details>
                <div className="ai-form-actions">
                  <button className="button button--ghost" disabled={busy} onClick={close}>
                    Cancel
                  </button>
                  <button
                    className="button button--primary"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const saved = await skillService.save(
                          workspaceId,
                          preview,
                          editing?.id,
                          editing?.version,
                        );
                        setSelected(saved);
                        setFilePath('SKILL.md');
                        setDialog(null);
                        setNotice('Skill folder saved. No scripts were executed.');
                      })
                    }
                  >
                    {busy ? 'Saving…' : editing ? 'Save update' : 'Import skill folder'}
                  </button>
                </div>
              </div>
            )}
          </div>
        </Sheet>
      )}
    </main>
  );
}
