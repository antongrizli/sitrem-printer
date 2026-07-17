import { useCallback, useEffect, useState } from 'react';
import type { ConnectorStatus } from '../../shared/contracts.ts';

export function useConnectorStatus() {
  const [status, setStatus] = useState<ConnectorStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await window.sitremConnector.getStatus();
    setStatus(next);
    setLoadError(null);
    return next;
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const next = await window.sitremConnector.getStatus();
        if (active) { setStatus(next); setLoadError(null); }
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : 'Unable to load Connector status.');
      }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  return { status, loadError, refresh };
}
