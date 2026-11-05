import { useId, useMemo } from 'react';
import {
  detectTimeZone,
  isTimeZone,
  workspaceClock,
  formatTimestamp,
  timeZoneNames,
} from '../../../../shared/timeZone';

export function TimeZoneField({
  value,
  onChange,
  disabled = false,
  now,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  now: number;
}) {
  const id = useId();
  const detected = detectTimeZone();
  const zones = useMemo(() => {
    const supported = timeZoneNames();
    return [...new Set(['UTC', detected, ...supported])].sort();
  }, [detected]);
  const valid = isTimeZone(value);
  return (
    <div className="timezone-field">
      <label htmlFor={id}>Workspace timezone</label>
      <input
        id={id}
        list={`${id}-zones`}
        value={value}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        required
        maxLength={100}
        placeholder="Search a city or enter America/Vancouver"
        aria-describedby={`${id}-help`}
        aria-invalid={!valid}
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id={`${id}-zones`}>
        {zones.map((zone) => (
          <option
            key={zone}
            value={zone}
            label={`${zone.split('/').at(-1)!.replaceAll('_', ' ')} · ${zone}`}
          />
        ))}
      </datalist>
      <button
        type="button"
        className="text-button"
        disabled={disabled}
        onClick={() => onChange(detected)}
      >
        Use detected timezone · {detected}
      </button>
      <p id={`${id}-help`} className="timezone-preview" role="status">
        {valid ? (
          <>
            <strong>{value.split('/').at(-1)!.replaceAll('_', ' ')}</strong>
            {' · '}
            {formatTimestamp(now, value, { dateStyle: 'full', timeStyle: 'medium' })}
            {' · UTC'}
            {workspaceClock(now, value).offset}
          </>
        ) : (
          'Choose a timezone from the suggestions or enter a valid timezone identifier.'
        )}
      </p>
    </div>
  );
}
