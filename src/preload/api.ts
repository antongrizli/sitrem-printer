import { IPC_CHANNELS } from '../shared/ipc.ts';
import type { ConnectorApi } from '../shared/contracts.ts';

export type IpcInvoke = (channel: string, ...arguments_: unknown[]) => Promise<unknown>;

export function createConnectorApi(invoke: IpcInvoke): ConnectorApi {
  return {
    getStatus: () => invoke(IPC_CHANNELS.getStatus) as ReturnType<ConnectorApi['getStatus']>,
    pair: (input) => invoke(IPC_CHANNELS.pair, input) as ReturnType<ConnectorApi['pair']>,
    resolveMediaConflict: (choice) => invoke(IPC_CHANNELS.resolveMediaConflict, choice) as Promise<void>,
    saveSettings: (input) => invoke(IPC_CHANNELS.saveSettings, input) as ReturnType<ConnectorApi['saveSettings']>,
    testPrint: (size) => invoke(IPC_CHANNELS.testPrint, size) as ReturnType<ConnectorApi['testPrint']>,
    getLogs: () => invoke(IPC_CHANNELS.getLogs) as ReturnType<ConnectorApi['getLogs']>,
    openPrinterSettings: () => invoke(IPC_CHANNELS.openPrinterSettings) as ReturnType<ConnectorApi['openPrinterSettings']>,
  };
}
