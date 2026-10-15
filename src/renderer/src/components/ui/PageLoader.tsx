import { LoaderCircle } from 'lucide-react';

export function PageLoader({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="page-loader" role="status" aria-label={label}>
      <LoaderCircle size={28} className="is-spinning" aria-hidden="true" />
    </div>
  );
}
