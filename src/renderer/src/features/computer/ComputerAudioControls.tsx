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
  const [enabled, setEnabled] = useState(() => {
    try {
      return localStorage.getItem('mukai.vm.sound') !== 'muted';
    } catch {
      return true;
    }
  });
  const enabledRef = useRef(enabled);
  const [state, setState] = useState<ComputerAudioState>('connecting');
  const [message, setMessage] = useState('');
  const [volume, setVolume] = useState(70);
  const stopStream = useCallback(() => {
    generation.current++;
    stream.current?.stop();
    stream.current = null;
  }, []);
  const volumeRef = useRef(volume);
  const start = useCallback(() => {
    stopStream();
    const current = generation.current;
    setMessage('');
    setState('connecting');
    try {
      stream.current = startComputerAudio({
        open: (signal) => computerService.audio(workspaceId, signal),
        volume: volumeRef.current / 100,
        state(next, detail) {
          if (generation.current !== current) return;
          setState(next);
          setMessage(detail || '');
        },
      });
    } catch {
      setState('failed');
      setMessage('Sound could not start. Use a browser with Web Audio support and try again.');
    }
  }, [workspaceId, stopStream]);
  useEffect(() => {
    if (enabledRef.current && open && available) start();
    else stopStream();
    return stopStream;
  }, [workspaceId, open, available, start, stopStream]);
  useEffect(() => {
    if (!enabled || !open || !available || !['blocked', 'connecting'].includes(state)) return;
    const resume = () => {
      void stream.current?.resume().catch(() => {});
    };
    document.addEventListener('pointerdown', resume, true);
    document.addEventListener('keydown', resume, true);
    return () => {
      document.removeEventListener('pointerdown', resume, true);
      document.removeEventListener('keydown', resume, true);
    };
  }, [enabled, open, available, state]);
  const toggle = () => {
    if (enabled && state === 'blocked') {
      void stream.current?.resume().catch(() => {});
      return;
    }
    if (enabled && state === 'failed') {
      start();
      return;
    }
    const next = !enabled;
    try {
      localStorage.setItem('mukai.vm.sound', next ? 'enabled' : 'muted');
    } catch {
      /* Sound remains usable without persistent storage. */
    }
    enabledRef.current = next;
    setEnabled(next);
    if (!next) stopStream();
    else start(); // Resume synchronously in this click's activation context.
  };
  const active = enabled && state !== 'failed';
  return (
    <span className="computer-audio-controls">
      <button
        className={`computer-control ${active ? 'is-active' : ''}`}
        disabled={!open || !available}
        onClick={toggle}
        aria-pressed={active}
        title={message || 'Play sound from this workspace'}
      >
        {active ? <Volume2 size={14} /> : <VolumeX size={14} />}
        <span>
          {enabled && state === 'failed'
            ? 'Retry sound'
            : state === 'blocked' && enabled
              ? 'Click for sound'
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
            volumeRef.current = next;
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
