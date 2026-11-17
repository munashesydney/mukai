import { useState } from 'react';
import type { RecallTrace } from '../../../../shared/memory';
import { useWorkspaceTime } from '../timezone/WorkspaceTimeContext';
import { MemoryPagination } from './MemoryPagination';
import { MemoryTabHeading } from './MemoryTabHeading';

const pageSize = 10;

export function MemoryRecalls({ recalls }: { recalls: RecallTrace[] }) {
  const { dateTime: time } = useWorkspaceTime();
  const [requestedPage, setPage] = useState(1);
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(recalls.length / pageSize)));
  return (
    <section>
      <MemoryTabHeading
        title="Recall"
        description="Memories supplied to bots before recent replies."
      />
      <div className="memory-record-list memory-recalls">
        {recalls.slice((page - 1) * pageSize, page * pageSize).map((recall) => (
          <details key={recall.id}>
            <summary className="memory-record-row">
              <div>
                <strong>
                  {recall.facts.length} {recall.facts.length === 1 ? 'memory' : 'memories'} recalled
                </strong>
                <small>{time(recall.createdAt)}</small>
                <p>{recall.query || 'Memory lookup'}</p>
              </div>
            </summary>
            <div className="memory-recall-detail">
              <h4>Search query</h4>
              <p className="memory-source-text">{recall.query}</p>
              <h4>Memories supplied</h4>
              {recall.facts.map((fact) => (
                <p key={fact.id}>
                  {fact.text}
                  <small>{fact.reasons.join(' · ')}</small>
                </p>
              ))}
              {!recall.facts.length && <p>No relevant memories were supplied.</p>}
            </div>
          </details>
        ))}
        {!recalls.length && (
          <p className="memory-empty">
            Recall records will appear here after a bot looks up memories for a reply.
          </p>
        )}
      </div>
      <MemoryPagination
        page={page}
        size={pageSize}
        total={recalls.length}
        label="Recall records"
        onPage={setPage}
      />
    </section>
  );
}
