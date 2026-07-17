import { describe, expect, it, vi } from 'vitest';
import { createConnectorApi } from '../src/preload/api.ts';
import { IPC_CHANNELS } from '../src/shared/contracts.ts';

describe('typed preload API', () => {
  it('exposes only the declared methods and maps each to one IPC channel', async () => {
    const invoke = vi.fn(async (_channel: string, ..._arguments: unknown[]) => ({ ok: true }));
    const api = createConnectorApi(invoke);
    expect(Object.keys(api).sort()).toEqual(['getLogs', 'getStatus', 'openPrinterSettings', 'pair', 'saveSettings', 'testPrint']);

    await api.getStatus();
    await api.pair({ portalUrl: 'http://localhost:3000', connectorName: 'Connector', printerName: 'Printer', pairingCode: 'code' });
    await api.saveSettings({ portalUrl: 'http://localhost:3000', connectorName: 'Connector', printerName: 'Printer' });
    await api.testPrint({ widthMm: 50, heightMm: 30 });
    await api.getLogs();
    await api.openPrinterSettings();

    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      IPC_CHANNELS.getStatus,
      IPC_CHANNELS.pair,
      IPC_CHANNELS.saveSettings,
      IPC_CHANNELS.testPrint,
      IPC_CHANNELS.getLogs,
      IPC_CHANNELS.openPrinterSettings,
    ]);
    expect(new Set(Object.values(IPC_CHANNELS)).size).toBe(Object.values(IPC_CHANNELS).length);
  });
});
