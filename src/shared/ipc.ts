/**
 * IPC channel names intentionally have no runtime dependencies. The preload
 * runs in Electron's sandbox, where it must not load Node packages such as
 * Zod. Keep this module small and dependency-free.
 */
export const IPC_CHANNELS = {
  getStatus: 'connector:get-status',
  pair: 'connector:pair',
  saveSettings: 'connector:save-settings',
  testPrint: 'connector:test-print',
  getLogs: 'connector:get-logs',
  openPrinterSettings: 'connector:open-printer-settings',
  statusChanged: 'connector:status-changed',
  diagnostics: 'connector:diagnostics',
} as const;
