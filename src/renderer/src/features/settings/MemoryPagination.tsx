import { ChevronLeft, ChevronRight } from 'lucide-react';

export function MemoryPagination({
  page,
  size,
  total,
  label,
  onPage,
  loading = false,
}: {
  page: number;
  size: number;
  total: number;
  label: string;
  onPage: (page: number) => void;
  loading?: boolean;
}) {
  if (!total) return null;
  const last = Math.ceil(total / size);
  return (
    <nav className="memory-pagination" aria-label={`${label} pages`}>
      <span aria-live="polite">
        {(page - 1) * size + 1}–{Math.min(page * size, total)} of {total.toLocaleString()}
      </span>
      {total > size && (
        <div>
          <button
            className="button button--ghost"
            disabled={loading || page <= 1}
            aria-label={`Previous page of ${label.toLowerCase()}`}
            onClick={() => onPage(page - 1)}
          >
            <ChevronLeft size={15} />
            Previous
          </button>
          <button
            className="button button--ghost"
            disabled={loading || page >= last}
            aria-label={`Next page of ${label.toLowerCase()}`}
            onClick={() => onPage(page + 1)}
          >
            Next
            <ChevronRight size={15} />
          </button>
        </div>
      )}
    </nav>
  );
}
