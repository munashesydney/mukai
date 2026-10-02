import { useCallback, useEffect, useState } from 'react';
import type { Bot, ProviderSettings } from '../../../../shared/ai';
import { botService } from '../../services/botService';
import { providerService } from '../../services/providerService';
import { errorText } from '../../utils/errors';

export function useAIWorkspace() {
  const [bots, setBots] = useState<Bot[]>([]);
  const [providers, setProviders] = useState<ProviderSettings[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      const [nextBots, nextProviders] = await Promise.all([
        botService.list(),
        providerService.list(),
      ]);
      setBots(nextBots);
      setProviders(nextProviders);
      setError('');
    } catch (error) {
      setError(errorText(error));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { bots, providers, loading, error, refresh };
}
