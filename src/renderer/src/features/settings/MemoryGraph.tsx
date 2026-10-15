import { useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { MemoryGraph as Graph, MemoryFact } from '../../../../shared/memory';
import { layoutMemoryGraph, memoryEdgePath } from './memoryGraphLayout';

export function MemoryGraph({
  graph,
  onSelect,
}: {
  graph: Graph;
  onSelect: (fact: MemoryFact) => void;
}) {
  const [focus, setFocus] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; pan: typeof pan } | null>(null);
  const markerId = useId();
  const selectEntity = (id: string) => {
    setFocus(id);
    setPan({ x: 0, y: 0 });
    setZoom(1);
  };
  const visible = useMemo(() => layoutMemoryGraph(graph, focus), [graph, focus]);
  return (
    <div className="memory-graph">
      <div className="memory-graph-toolbar">
        <span>
          {focus ? 'Selected neighborhood' : 'Recent relationships'} · {visible.nodes.length}{' '}
          entities
        </span>
        <div>
          <button
            className="button button--ghost"
            onClick={() => setZoom(Math.max(0.6, zoom - 0.2))}
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            className="button button--ghost"
            onClick={() => setZoom(Math.min(6, zoom + 0.2))}
            aria-label="Zoom in"
          >
            +
          </button>
          <button
            className="button button--ghost"
            onClick={() => {
              setFocus(null);
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
          >
            Reset
          </button>
        </div>
      </div>
      {!visible.nodes.length ? (
        <div className="memory-empty">
          Your relationships will appear here as memories are added.
        </div>
      ) : (
        <div
          className="memory-graph-canvas"
          tabIndex={0}
          role="region"
          aria-label="Memory graph canvas. Use arrow keys to pan."
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            const directions: Record<string, [number, number]> = {
              ArrowLeft: [40, 0],
              ArrowRight: [-40, 0],
              ArrowUp: [0, 40],
              ArrowDown: [0, -40],
            };
            const direction = directions[event.key];
            if (!direction) return;
            event.preventDefault();
            setPan((previous) => ({ x: previous.x + direction[0], y: previous.y + direction[1] }));
          }}
        >
          <svg
            viewBox={`0 0 ${visible.width} ${visible.height}`}
            role="group"
            onPointerDown={(event) => {
              if (event.button !== 0 || (event.target as Element).closest('[role="button"]'))
                return;
              drag.current = { x: event.clientX, y: event.clientY, pan };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!drag.current) return;
              const matrix = event.currentTarget.getScreenCTM();
              if (!matrix) return;
              setPan({
                x: drag.current.pan.x + (event.clientX - drag.current.x) / matrix.a,
                y: drag.current.pan.y + (event.clientY - drag.current.y) / matrix.d,
              });
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
            aria-label="Memory relationship graph. Select an entity to focus, or a relationship to inspect its source."
          >
            <defs>
              <marker
                id={markerId}
                viewBox="0 0 10 10"
                refX="10"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
              </marker>
            </defs>
            <g
              transform={`translate(${pan.x} ${pan.y}) translate(${visible.width / 2} ${visible.height / 2}) scale(${zoom}) translate(${-visible.width / 2} ${-visible.height / 2})`}
            >
              {visible.edges.map((edge) => {
                const source = visible.positions.get(edge.subjectId)!,
                  target = visible.positions.get(edge.objectId)!;
                const siblings = visible.edges.filter(
                  (other) =>
                    (other.subjectId === edge.subjectId && other.objectId === edge.objectId) ||
                    (other.subjectId === edge.objectId && other.objectId === edge.subjectId),
                );
                const path = memoryEdgePath(source, target, siblings.indexOf(edge));
                return (
                  <g
                    key={edge.id}
                    className={`memory-graph-edge ${edge.validTo ? 'is-historical' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`${edge.subject} ${edge.relation} ${edge.object}`}
                    onClick={() => onSelect(edge)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onSelect(edge);
                      }
                    }}
                  >
                    <title>{edge.text}</title>
                    <path d={path} markerEnd={`url(#${markerId})`} />
                    <path className="memory-graph-hit" d={path} />
                    <text
                      x={(source.x + target.x) / 2}
                      y={(source.y + target.y) / 2 - 5}
                      textAnchor="middle"
                    >
                      {edge.relation.replace(/_/g, ' ').slice(0, 24)}
                    </text>
                  </g>
                );
              })}
              {visible.nodes.map((node) => (
                <g
                  key={node.id}
                  className={`memory-graph-node ${node.id === focus ? 'is-selected' : ''} ${node.ownerId ? 'is-private' : ''}`}
                  transform={`translate(${node.x} ${node.y})`}
                  style={{ '--memory-node-color': node.color } as CSSProperties}
                  role="button"
                  tabIndex={0}
                  aria-label={`Focus ${node.name}`}
                  onClick={() => selectEntity(node.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      selectEntity(node.id);
                    }
                  }}
                >
                  <title>
                    {node.name} · {node.type}
                    {node.ownerId ? ' · private' : ''}
                  </title>
                  <circle className="memory-node-halo" r={node.radius + 6} />
                  <circle r={node.radius} />
                  <text className="memory-node-label" y={node.radius + 17} textAnchor="middle">
                    {node.name.length > 22 ? node.name.slice(0, 20) + '…' : node.name}
                  </text>
                </g>
              ))}
            </g>
          </svg>
        </div>
      )}
      <p className="memory-caption">
        Select a connection for evidence and history. Select an entity to focus. Dashed connections
        are historical. Drag to pan and use + or − to zoom. Hover a connection to see its
        relationship.{' '}
        {visible.truncated ? 'Showing a bounded view; search to narrow the graph.' : ''}
      </p>
    </div>
  );
}
