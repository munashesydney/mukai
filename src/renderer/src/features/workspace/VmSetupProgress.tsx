import type { QemuSetup } from '../../../../shared/computer';

const titles: Record<NonNullable<QemuSetup['phase']>, string> = {
  idle: 'Linux VM setup',
  checking: 'Checking your computer',
  installing: 'Installing prerequisites',
  downloading: 'Downloading Linux',
  preparing: 'Installing Linux tools',
  verifying: 'Verifying the VM',
  ready: 'Linux VM is ready',
  'reboot-required': 'Windows restart required',
  failed: 'Setup needs attention',
};
export function VmSetupProgress({
  setup,
  error,
  onRetry,
}: {
  setup?: QemuSetup;
  error: string;
  onRetry: () => void;
}) {
  const phase = setup?.phase || 'checking';
  const active = ['checking', 'installing', 'downloading', 'preparing', 'verifying'].includes(
    phase,
  );
  const total = setup?.totalBytes;
  const downloaded = setup?.downloadedBytes || 0;
  return (
    <div className="vm-setup-progress">
      <div role="status" aria-live="polite">
        <strong>{titles[phase]}</strong>
        <p>
          {setup?.available
            ? 'The VM starts when a bot first uses it.'
            : setup?.message || setup?.reason || 'Checking VM setup…'}
        </p>
      </div>
      {active && (
        <progress
          aria-label={titles[phase]}
          max={total || 1}
          value={phase === 'downloading' && total ? downloaded : undefined}
        />
      )}
      {phase === 'downloading' && downloaded > 0 && (
        <small>
          {(downloaded / 1024 ** 2).toFixed(1)} MiB
          {total
            ? ` of ${(total / 1024 ** 2).toFixed(1)} MiB (${Math.floor((downloaded / total) * 100)}%)`
            : ' downloaded'}
        </small>
      )}
      {!setup?.available && (
        <small>
          First use installs QEMU and downloads Linux, Node.js and Chrome. Allow several minutes and
          at least 12 GiB of free disk space. Your OS may ask for administrator approval.
        </small>
      )}
      {setup?.detail && (
        <details open={phase === 'failed'}>
          <summary>Setup details</summary>
          <pre>{setup.detail}</pre>
        </details>
      )}
      {!setup?.available && ['idle', 'failed', 'reboot-required'].includes(phase) && (
        <button type="button" className="button" onClick={onRetry}>
          {phase === 'idle' ? 'Set up Linux VM' : 'Retry setup'}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
