import { SettingsHeading } from './SettingsHeading';
import { useEffect, useState } from 'react';
import { limitsService } from '../../services/limitsService';
import { errorText } from '../../utils/errors';
import {
  DEFAULT_PURSUIT_CONCURRENCY,
  MAX_PURSUIT_CONCURRENCY,
  DEFAULT_AI_CONCURRENCY,
  MAX_AI_CONCURRENCY,
} from '../../../../shared/limits';
import { Tooltip } from '../../components/ui/Tooltip';
import { useAIActivity } from '../../services/aiActivityStore';

export function LimitsPanel() {
  const pressure = useAIActivity().memoryPressure || [];
  const [saved, setSaved] = useState<number | null>(null);
  const [aiSaved, setAISaved] = useState<number | null>(null);
  const [aiValue, setAIValue] = useState(String(DEFAULT_AI_CONCURRENCY));
  const [value, setValue] = useState(String(DEFAULT_PURSUIT_CONCURRENCY));
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let disposed = false;
    void limitsService
      .get()
      .then((result) => {
        if (!disposed) {
          setAISaved(result.aiConcurrency);
          setAIValue(String(result.aiConcurrency));
          setSaved(result.pursuitConcurrency);
          setValue(String(result.pursuitConcurrency));
          setError('');
        }
      })
      .catch((caught) => {
        if (!disposed) setError(errorText(caught));
      });
    return () => {
      disposed = true;
    };
  }, [retry]);
  const parsed = Number(value);
  const valid =
    /^\d+$/.test(value) &&
    Number.isInteger(parsed) &&
    parsed >= 1 &&
    parsed <= MAX_PURSUIT_CONCURRENCY;
  const aiParsed = Number(aiValue);
  const aiValid =
    /^\d+$/.test(aiValue) &&
    Number.isInteger(aiParsed) &&
    aiParsed >= 1 &&
    aiParsed <= MAX_AI_CONCURRENCY;
  async function save() {
    if (!valid || !aiValid || saved === null || saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const result = await limitsService.save({
        pursuitConcurrency: parsed,
        aiConcurrency: aiParsed,
      });
      setSaved(result.pursuitConcurrency);
      setAISaved(result.aiConcurrency);
      setNotice('Saved. The shared schedulers now use these limits.');
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="limits-panel">
      <SettingsHeading
        eyebrow="SHARED ACROSS YOUR WORKSPACES"
        title="Limits"
        description="Choose how much AI work Mukai can run at once across all workspaces."
      />
      {error && (
        <div role="alert" className="ai-alert">
          {error}
          {saved === null && (
            <button className="text-button" onClick={() => setRetry((current) => current + 1)}>
              Try again
            </button>
          )}
        </div>
      )}
      <form
        className="limits-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="limits-card">
          <div className="limits-card-heading">
            <div>
              <h4>Concurrent AIs</h4>
              <p>
                One shared pool for chats, pursuits, memory reviews, and compaction across every
                workspace.
              </p>
              {pressure.map((item) => (
                <p key={item.providerId} className="ai-caption" role="status">
                  Memory recovery: {item.providerName} temporarily allows {item.effectiveLimit}{' '}
                  {item.effectiveLimit === 1 ? 'AI' : 'AIs'}. Your saved maximum stays{' '}
                  {item.configuredLimit}; capacity restores after successful requests.
                </p>
              ))}
            </div>
          </div>
          <div className="limits-field">
            <div className="limits-field-heading">
              <label htmlFor="ai-concurrency">Maximum concurrent AIs</label>
              <Tooltip
                label="About the AI limit"
                content="Limits active AI generation across all workspaces. Tools, approvals and delegated waits do not occupy an AI slot. Queued requests continue automatically. Lowering the limit lets existing requests finish; raising it makes more slots available immediately."
              />
            </div>
            <div className="limits-stepper">
              <button
                type="button"
                className="button"
                aria-label="Decrease AI limit"
                disabled={aiSaved === null || saving || aiParsed <= 1}
                onClick={() => {
                  setAIValue(
                    String(Math.max(1, (aiValid ? aiParsed : DEFAULT_AI_CONCURRENCY) - 1)),
                  );
                  setNotice('');
                }}
              >
                −
              </button>
              <input
                id="ai-concurrency"
                type="text"
                inputMode="numeric"
                pattern="[0-9]+"
                value={aiValue}
                disabled={aiSaved === null || saving}
                aria-invalid={!aiValid}
                aria-describedby="ai-limit-help"
                onChange={(event) => {
                  setAIValue(event.target.value);
                  setNotice('');
                }}
              />
              <button
                type="button"
                className="button"
                aria-label="Increase AI limit"
                disabled={aiSaved === null || saving || aiParsed >= MAX_AI_CONCURRENCY}
                onClick={() => {
                  setAIValue(
                    String(
                      Math.min(
                        MAX_AI_CONCURRENCY,
                        (aiValid ? aiParsed : DEFAULT_AI_CONCURRENCY) + 1,
                      ),
                    ),
                  );
                  setNotice('');
                }}
              >
                +
              </button>
            </div>
            <p id="ai-limit-help" className="ai-caption">
              Between 1 and {MAX_AI_CONCURRENCY} AIs. Default: {DEFAULT_AI_CONCURRENCY}.
            </p>
            {!aiValid && (
              <p role="alert" className="ai-alert">
                Enter a whole number between 1 and {MAX_AI_CONCURRENCY}.
              </p>
            )}
          </div>
        </div>
        <div className="limits-card">
          <div className="limits-card-heading">
            <div>
              <h4>Concurrent pursuit runs</h4>
              <p>One shared pool for all bots and workspaces.</p>
            </div>
          </div>
          <div className="limits-field">
            <div className="limits-field-heading">
              <label htmlFor="pursuit-concurrency">Maximum active runs</label>
              <Tooltip
                label="About the pursuit limit"
                content="A pursuit uses a slot while its bot is working. Waiting for approval or an answer releases that slot. Once you respond, the run queues for a slot before continuing. Lowering the limit lets existing work finish; new and resumed work waits until capacity is available."
              />
            </div>
            <div className="limits-stepper">
              <button
                type="button"
                className="button"
                aria-label="Decrease pursuit limit"
                disabled={saved === null || saving || parsed <= 1}
                onClick={() => {
                  setValue(String(Math.max(1, (valid ? parsed : DEFAULT_PURSUIT_CONCURRENCY) - 1)));
                  setNotice('');
                }}
              >
                −
              </button>
              <input
                id="pursuit-concurrency"
                type="text"
                inputMode="numeric"
                pattern="[0-9]+"
                value={value}
                disabled={saved === null || saving}
                aria-describedby="pursuit-limit-help"
                aria-invalid={!valid}
                onChange={(event) => {
                  setValue(event.target.value);
                  setNotice('');
                }}
              />
              <button
                type="button"
                className="button"
                aria-label="Increase pursuit limit"
                disabled={saved === null || saving || parsed >= MAX_PURSUIT_CONCURRENCY}
                onClick={() => {
                  setValue(
                    String(
                      Math.min(
                        MAX_PURSUIT_CONCURRENCY,
                        (valid ? parsed : DEFAULT_PURSUIT_CONCURRENCY) + 1,
                      ),
                    ),
                  );
                  setNotice('');
                }}
              >
                +
              </button>
            </div>
            <p id="pursuit-limit-help" className="ai-caption">
              {saved === null
                ? 'Loading limit…'
                : `Between 1 and ${MAX_PURSUIT_CONCURRENCY} runs. Default: ${DEFAULT_PURSUIT_CONCURRENCY}.`}
            </p>
            {!valid && (
              <p role="alert" className="ai-alert">
                Enter a whole number between 1 and {MAX_PURSUIT_CONCURRENCY}.
              </p>
            )}
          </div>
        </div>
        <button
          type="submit"
          className="button button--primary"
          disabled={
            !valid ||
            !aiValid ||
            saved === null ||
            (parsed === saved && aiParsed === aiSaved) ||
            saving
          }
        >
          {saving ? 'Saving…' : 'Save limit'}
        </button>
        {notice && (
          <p className="ai-notice" role="status">
            {notice}
          </p>
        )}
      </form>
    </section>
  );
}
