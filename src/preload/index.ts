import { contextBridge, ipcRenderer } from 'electron';
import { createConnectorApi } from './api.ts';

contextBridge.exposeInMainWorld('sitremConnector', createConnectorApi((channel, ...arguments_) => ipcRenderer.invoke(channel, ...arguments_)));
