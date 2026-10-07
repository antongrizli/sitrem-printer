import { useCallback, useEffect, useState } from 'react';
import { ConnectorStatusSchema, type ConnectorStatus } from '../../shared/contracts.ts';

export function useConnectorStatus() {
  const [status, setStatus] = useState<ConnectorStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = ConnectorStatusSchema.parse(await window.sitremConnector.getStatus());
    setStatus(next);
    setLoadError(null);
    return next;
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const next = ConnectorStatusSchema.parse(await window.sitremConnector.getStatus());
        if (active) { setStatus(next); setLoadError(null); }
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : 'Unable to load Connector status.');
      }
    };
    let loading = false;
    const refreshStatus = async () => { if (loading) return; loading = true; try { await load(); } finally { loading = false; } };
    void refreshStatus();
    const unsubscribe = window.sitremConnector.onStatusChanged?.(() => { void refreshStatus(); });
    const timer = window.setInterval(() => { void refreshStatus(); }, unsubscribe ? 10_000 : 2_000);
    return () => { active = false; unsubscribe?.(); window.clearInterval(timer); };
  }, []);

  return { status, loadError, refresh };
}
