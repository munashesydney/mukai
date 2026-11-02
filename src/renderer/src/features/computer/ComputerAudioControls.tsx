import { useCallback, useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { computerService } from '../../services/computerService';
import { startComputerAudio, type ComputerAudioState } from './computerAudio';

export function ComputerAudioControls({
  workspaceId,
  open,
  available,
}: {
  workspaceId: string;
  open: boolean;
  available: boolean;
}) {
  const stream = useRef<ReturnType<typeof startComputerAudio> | null>(null);
  const generation = useRef(0);
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<ComputerAudioState>('connecting');
  const [message, setMessage] = useState('');
  const [volume, setVolume] = useState(70);
  const stopStream = useCallback(() => {
    generation.current++;
    stream.current?.stop();
    stream.current = null;
  }, []);
  useEffect(() => {
    stopStream();
    setEnabled(false);
    setMessage('');
    return stopStream;
  }, [workspaceId, open, stopStream]);
  const toggle = () => {
    stopStream();
    if (enabled && state !== 'failed') {
      setEnabled(false);
      setMessage('');
      return;
    }
    const current = generation.current;
    setEnabled(true);
    setMessage('');
    try {
      stream.current = startComputerAudio({
        open: (signal) => computerService.audio(workspaceId, signal),
        volume: volume / 100,
        state(next, detail) {
          if (generation.current !== current) return;
          setState(next);
          setMessage(detail || '');
        },
      });
    } catch {
      setState('failed');
      setMessage(
        'Sound could not start. Use a browser with Web Audio support and try enabling sound again.',
      );
    }
  };
  const active = enabled && state !== 'failed';
  return (
    <span className="computer-audio-controls">
      <button
        className={`computer-control ${active ? 'is-active' : ''}`}
        disabled={!open || (!available && (!enabled || state === 'failed'))}
        onClick={toggle}
        aria-pressed={active}
        title={message || 'Play sound from this workspace'}
      >
        {active ? <Volume2 size={14} /> : <VolumeX size={14} />}
        <span>
          {enabled && state === 'failed'
            ? 'Retry sound'
            : !enabled
              ? 'Enable sound'
              : state === 'playing'
                ? 'Mute'
                : 'Connecting sound…'}
        </span>
      </button>
      {active && (
        <input
          className="computer-audio-volume"
          aria-label="Workspace volume"
          title={`Volume ${volume}%`}
          type="range"
          min={0}
          max={100}
          step={1}
          value={volume}
          onChange={(event) => {
            const next = Number(event.target.value);
            setVolume(next);
            stream.current?.volume(next / 100);
          }}
        />
      )}
      {enabled && state === 'failed' && (
        <span className="computer-audio-error" role="status">
          {message}
        </span>
      )}
    </span>
  );
}
