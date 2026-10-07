import { contextBridge, ipcRenderer } from 'electron';
import { createConnectorApi } from './api.ts';

const api = createConnectorApi((channel, ...arguments_) => ipcRenderer.invoke(channel, ...arguments_));
api.onStatusChanged = (listener) => {
  const notify = () => listener();
  ipcRenderer.on('connector:status-changed', notify);
  return () => ipcRenderer.removeListener('connector:status-changed', notify);
};
api.diagnostics = () => ipcRenderer.invoke('connector:diagnostics') as Promise<string>;
contextBridge.exposeInMainWorld('sitremConnector', api);
