import { useEffect, useState } from 'react';
import type { Workspace } from '../../../../shared/ai';
import { effectiveTimeZone, isTimeZone } from '../../../../shared/timeZone';
import { TimeZoneField } from '../timezone/TimeZoneField';
import { workspaceService } from '../../services/workspaceService';
import { errorText } from '../../utils/errors';
import { SettingsHeading } from './SettingsHeading';
import '../../styles/timezone.css';

export function TimezonePanel({
  workspace,
  onSaved,
}: {
  workspace: Workspace;
  onSaved: (workspace: Workspace) => void;
}) {
  const [timeZone, setTimeZone] = useState(effectiveTimeZone(workspace.timeZone));
  const [now, setNow] = useState(Date.now);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  async function save() {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const saved = await workspaceService.saveTimeZone(workspace.id, timeZone);
      onSaved(saved);
      setNotice('Timezone saved. Workspace times and your bots now use ' + saved.timeZone + '.');
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <SettingsHeading
        eyebrow={workspace.name}
        title="Timezone"
        description="Set the local time for this workspace and its bots."
      />
      <form
        className="timezone-settings ai-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <TimeZoneField
          value={timeZone}
          now={now}
          disabled={saving}
          onChange={(value) => {
            setTimeZone(value);
            setNotice('');
          }}
        />
        <p>
          Chats, deadlines, and run history display in this timezone. Your bots use it for “today,”
          “tomorrow,” and times you specify without a timezone.
        </p>
        <p>
          The selection stays with this workspace when your device timezone changes. Existing
          scheduled runs keep their scheduled instant.
        </p>
        <button
          type="submit"
          className="button button--primary"
          disabled={saving || !isTimeZone(timeZone) || timeZone === workspace.timeZone}
        >
          {saving ? 'Saving…' : 'Save timezone'}
        </button>
        {error && (
          <p role="alert" className="ai-alert">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="ai-notice">
            {notice}
          </p>
        )}
      </form>
    </>
  );
}
