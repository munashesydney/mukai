import { useState } from 'react';
import {
  ArrowUpRight,
  Check,
  Search,
  Puzzle,
  CodeXml,
  Mail,
  CalendarDays,
  FileText,
  MessageCircle,
  Globe,
  X,
} from 'lucide-react';
import { Modal } from '../../components/ui/Modal';

const integrations = [
  {
    id: 'telegram',
    name: 'Telegram',
    category: 'Communication',
    icon: MessageCircle,
    color: 'blue',
    description: 'Bring your channels and conversations into the picture.',
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'Development',
    icon: CodeXml,
    color: 'navy',
    description: 'Keep your projects, code, and next release in view.',
  },
  {
    id: 'notion',
    name: 'Notion',
    category: 'Knowledge',
    icon: FileText,
    color: 'neutral',
    description: 'Give your notes and ideas a little more room to work.',
  },
  {
    id: 'gmail',
    name: 'Gmail',
    category: 'Communication',
    icon: Mail,
    color: 'coral',
    description: 'Find the useful things hiding in your inbox.',
  },
  {
    id: 'calendar',
    name: 'Google Calendar',
    category: 'Planning',
    icon: CalendarDays,
    color: 'purple',
    description: 'Make time for the things you want to move forward.',
  },
  {
    id: 'web',
    name: 'Web',
    category: 'Discovery',
    icon: Globe,
    color: 'teal',
    description: 'Let curiosity lead the way. Explore what’s out there.',
  },
];

export function ToolsPage() {
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<string>();
  const [selected, setSelected] = useState<string[]>([]);
  const tool = integrations.find((tool) => tool.id === preview);
  return (
    <main className="tools-page">
      <div className="tools-topline">
        <span>
          <Puzzle size={17} /> YOUR TOOLKIT
        </span>
        <span className="preview-label">UI preview</span>
      </div>
      <h1>
        A little more connected.
        <br />
        <span>A lot more possible.</span>
      </h1>
      <p className="tools-intro">
        The tools you already use, together with the agents
        <br className="desktop-break" /> helping you move things forward.
      </p>
      <div className="tools-filter">
        <span>
          Explore integrations <small>{integrations.length}</small>
        </span>
        <label>
          <Search size={16} />
          <input
            placeholder="Find a tool…"
            aria-label="Search integrations"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button aria-label="Clear search" onClick={() => setQuery('')}>
              <X size={14} />
            </button>
          )}
        </label>
      </div>
      <div className="integration-grid">
        {integrations
          .filter((tool) => (tool.name + tool.category).toLowerCase().includes(query.toLowerCase()))
          .map((tool) => (
            <button key={tool.id} className="integration-card" onClick={() => setPreview(tool.id)}>
              <div className="integration-card-top">
                <span className={`integration-icon integration-icon--${tool.color}`}>
                  <tool.icon size={25} />
                </span>
                {selected.includes(tool.id) ? (
                  <span className="preview-selected">
                    <Check size={13} />
                    Added to preview
                  </span>
                ) : (
                  <ArrowUpRight size={17} />
                )}
              </div>
              <h2>{tool.name}</h2>
              <span className="integration-category">{tool.category}</span>
              <p>{tool.description}</p>
              <span className="integration-action">
                Explore integration <ArrowUpRight size={13} />
              </span>
            </button>
          ))}
      </div>
      {!integrations.some((tool) =>
        (tool.name + tool.category).toLowerCase().includes(query.toLowerCase()),
      ) && <div className="tools-empty">No tools match “{query}”. Try another search.</div>}
      <div className="tools-bottom-note">
        <ShieldNote />
        Connections will always be yours to choose.
      </div>
      {tool && (
        <Modal title={`${tool.name} integration`} onClose={() => setPreview(undefined)}>
          <div className="agent-preview">
            <span className={`integration-icon integration-icon--${tool.color}`}>
              <tool.icon size={32} />
            </span>
            <h3>{tool.name}, meet Mukai.</h3>
            <p>
              {tool.description} This is a UI preview. Adding a tool here updates the interface;
              account authorization and live connections will come later.
            </p>
          </div>
          <div className="modal-footer">
            <span>No account connection required.</span>
            <button
              className="button button--primary"
              onClick={() => {
                setSelected((previous) =>
                  previous.includes(tool.id)
                    ? previous.filter((id) => id !== tool.id)
                    : [...previous, tool.id],
                );
                setPreview(undefined);
              }}
            >
              {selected.includes(tool.id) ? 'Remove from preview' : 'Add to preview'}
              <Check size={15} />
            </button>
          </div>
        </Modal>
      )}
    </main>
  );
}
function ShieldNote() {
  return <span className="tiny-status" />;
}
