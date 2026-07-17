import type { ConnectorApi } from '../../shared/contracts.ts';

declare global {
  interface Window {
    sitremConnector: ConnectorApi;
  }
}

export {};
