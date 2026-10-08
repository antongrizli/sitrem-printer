import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorService, type SecureStorage } from '../src/main/connector-service.ts';
import type { ElectronPrintEngine } from '../src/main/print-engine.ts';
import { createPayload } from '../src/shared/label.ts';

const temporaryDirectories: string[] = [];
const secureStorage: SecureStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value),
  decryptString: (value) => value.toString(),
};
const safeHtml = '<!doctype html><style>@page{size:50mm 30mm;margin:0}</style><svg/>';

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'sitrem-printer-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function credentials(directory: string, connectorId = 'connector-1', token = 'secret'): void {
  writeFileSync(join(directory, 'connector-credentials.json'), JSON.stringify({ connectorId, token: Buffer.from(token).toString('base64') }));
  writeFileSync(join(directory, 'connector-settings.json'), JSON.stringify({ portalUrl: 'http://127.0.0.1:3000', connectorName: 'Test Connector', printerName: 'VRETTI 420B' }));
}

function printer(print = vi.fn(async () => undefined)): ElectronPrintEngine {
  return { printers: vi.fn(async () => [{ name: 'VRETTI 420B' }]), print } as unknown as ElectronPrintEngine;
}

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    // Test directories are under the operating-system temp directory and contain no user data.
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

describe('ConnectorService', () => {
  it.each(['http://localhost:3000', 'https://sitrem.example.test'])('pairs through %s without exposing the token', async (portalUrl) => {
    const fetchFn = vi.fn(async () => response(201, { connectorId: 'paired-1', token: 'machine-secret' }));
    const service = new ConnectorService({ userDataPath: temporaryDirectory(), secureStorage, printer: printer(), version: '1.0.0', os: 'darwin', fetchFn });
    await expect(service.pair({ portalUrl, connectorName: 'Reception', printerName: 'VRETTI 420B', selectedMedia: null, pairingCode: 'one-time' })).resolves.toEqual({ connectorId: 'paired-1' });
    expect(fetchFn).toHaveBeenCalledWith(`${portalUrl}/api/print/connectors/pair`, expect.any(Object));
    const status = await service.getStatus();
    expect(status.paired).toBe(true);
    expect(JSON.stringify(status)).not.toContain('machine-secret');
  });

  it('preserves compatible settings files while stripping legacy pairingCode fields', async () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, 'connector-settings.json'), JSON.stringify({ portalUrl: 'http://127.0.0.1:3000', connectorName: 'Legacy', printerName: 'VRETTI 420B', pairingCode: '' }));
    const service = new ConnectorService({ userDataPath: directory, secureStorage, printer: printer(), version: '1', os: 'darwin', fetchFn: vi.fn() });
    await expect(service.getStatus()).resolves.toMatchObject({ portalUrl: 'http://127.0.0.1:3000', connectorName: 'Legacy', paired: false });
  });

  it('persists a selected format and synchronizes it immediately when the portal supports the format endpoint', async () => {
    const directory = temporaryDirectory();
    credentials(directory);
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:3000/api/print/connectors/connector-1/media');
      expect(init?.method).toBe('PUT');
      expect(JSON.parse(String(init?.body))).toEqual({ schemaVersion: 1, clientRevision: 1, expectedServerRevision: null,
        deviceName: 'VRETTI 420B', media: { formatId: 'stock_70x25', widthMm: 70, heightMm: 25, catalogVersion: 1 } });
      return response(200, { clientRevision: 1, serverRevision: 4, isDefaultConnector: true,
        effectiveMedia: { formatId: 'stock_70x25', widthMm: 70, heightMm: 25, catalogVersion: 1 } });
    });
    const service = new ConnectorService({ userDataPath: directory, secureStorage, printer: printer(), version: '1', os: 'darwin', fetchFn });
    await service.saveSettings({ portalUrl: 'http://127.0.0.1:3000', connectorName: 'Test Connector', printerName: 'VRETTI 420B',
      selectedMedia: { formatId: 'stock_70x25', widthMm: 70, heightMm: 25, catalogVersion: 1 } });
    await expect(service.getStatus()).resolves.toMatchObject({ selectedMedia: { formatId: 'stock_70x25', widthMm: 70, heightMm: 25 },
      mediaSync: { clientRevision: 1, serverRevision: 4, state: 'synced' } });
    expect(JSON.parse(readFileSync(join(directory, 'connector-session.json'), 'utf8'))).toMatchObject({ schemaVersion: 2,
      settings: { selectedMedia: { formatId: 'stock_70x25' } }, mediaSync: { state: 'synced', serverRevision: 4 } });
  });

  it('keeps the format locally when an older Board does not provide the format endpoint', async () => {
    const directory = temporaryDirectory();
    credentials(directory);
    const service = new ConnectorService({ userDataPath: directory, secureStorage, printer: printer(), version: '1', os: 'darwin',
      fetchFn: vi.fn(async () => response(404, { error: 'not found' })) });
    await service.saveSettings({ portalUrl: 'http://127.0.0.1:3000', connectorName: 'Test Connector', printerName: 'VRETTI 420B',
      selectedMedia: { formatId: 'stock_70x25', widthMm: 70, heightMm: 25, catalogVersion: 1 } });
    await expect(service.getStatus()).resolves.toMatchObject({ selectedMedia: { formatId: 'stock_70x25' },
      mediaSync: { state: 'unsupported', message: expect.stringContaining('saved locally') } });
  });

  it('returns settings and a visible printer error when Electron printer discovery fails', async () => {
    const unavailablePrinter = { printers: vi.fn(async () => { throw new Error('spooler unavailable'); }), print: vi.fn() } as unknown as ElectronPrintEngine;
    const service = new ConnectorService({ userDataPath: temporaryDirectory(), secureStorage, printer: unavailablePrinter, version: '1', os: 'darwin', fetchFn: vi.fn() });
    await expect(service.getStatus()).resolves.toMatchObject({ printers: [], printerAvailable: false, printerError: 'Unable to read system printers: spooler unavailable' });
  });

  it('re-acknowledges a spooled journal entry before heartbeat without printing again', async () => {
    const directory = temporaryDirectory();
    credentials(directory);
    writeFileSync(join(directory, 'print-journal.json'), JSON.stringify({ 'job-old': { state: 'spooled', updatedAt: 1 } }));
    let service: ConnectorService;
    const calls: string[] = [];
    const print = vi.fn(async () => undefined);
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/claim')) { service.stop(); return response(204); }
      return response(200, { ok: true });
    });
    service = new ConnectorService({ userDataPath: directory, secureStorage, printer: printer(print), version: '1', os: 'darwin', fetchFn, delay: async () => undefined });
    service.start();
    await vi.waitFor(() => expect(calls.some((url) => url.endsWith('/claim'))).toBe(true));
    expect(calls[0]).toContain('/jobs/job-old/acknowledge');
    expect(print).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(directory, 'print-journal.json'), 'utf8'))).toMatchObject({ schemaVersion: 2, entries: [{ state: 'spooled', acknowledged: true }] });
  });

  it('heartbeats, claims, prints, and acknowledges one valid job', async () => {
    const directory = temporaryDirectory();
    credentials(directory);
    const portalFixture = JSON.parse(readFileSync(new URL('./fixtures/portal-labels.json', import.meta.url), 'utf8'))[0];
    const job = createPayload({ ...portalFixture, jobId: 'portal-job', idempotencyKey: 'order-1' });
    let claimed = false;
    let service: ConnectorService;
    const requestBodies: unknown[] = [];
    const print = vi.fn(async () => undefined);
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.body) requestBodies.push(JSON.parse(String(init.body)));
      if (url.endsWith('/heartbeat')) return response(200, { ok: true });
      if (url.endsWith('/claim') && !claimed) { claimed = true; return response(200, job); }
      if (url.endsWith('/acknowledge')) { service.stop(); return response(200, { status: 'spooled' }); }
      return response(204);
    });
    service = new ConnectorService({ userDataPath: directory, secureStorage, printer: printer(print), version: '1.2.3', os: 'darwin', fetchFn, delay: async () => undefined });
    service.start();
    await vi.waitFor(() => expect(print).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(requestBodies).toContainEqual({ result: 'spooled' }));
    expect(requestBodies).toContainEqual({ version: '1.2.3', os: 'darwin', deviceName: 'VRETTI 420B' });
    expect(JSON.parse(readFileSync(join(directory, 'print-journal.json'), 'utf8'))).toMatchObject({ schemaVersion: 2, entries: [{ state: 'spooled', acknowledged: true }] });
  });

  it('reports invalid claimed HTML instead of printing it', async () => {
    const directory = temporaryDirectory();
    credentials(directory);
    const job = createPayload({ connectorId: 'connector-1', idempotencyKey: 'order-1', html: safeHtml, widthMm: 50, heightMm: 30, orientation: 'portrait', copies: 1 });
    const invalidJob = { ...job, html: '<script>alert(1)</script>' };
    let service: ConnectorService;
    const print = vi.fn(async () => undefined);
    const bodies: Array<Record<string, string>> = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/heartbeat')) return response(200, {});
      if (url.endsWith('/claim')) return response(200, invalidJob);
      if (url.endsWith('/acknowledge')) { bodies.push(JSON.parse(String(init?.body))); service.stop(); return response(200, {}); }
      return response(204);
    });
    service = new ConnectorService({ userDataPath: directory, secureStorage, printer: printer(print), version: '1', os: 'darwin', fetchFn, delay: async () => undefined });
    service.start();
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({ result: 'error', errorCode: 'INVALID_PAYLOAD' });
    expect(print).not.toHaveBeenCalled();
  });

  it('stops polling and reports revoked after a 401', async () => {
    const directory = temporaryDirectory();
    credentials(directory);
    const service = new ConnectorService({ userDataPath: directory, secureStorage, printer: printer(), version: '1', os: 'darwin', fetchFn: vi.fn(async () => response(401, { error: 'revoked' })), delay: async () => undefined });
    service.start();
    await vi.waitFor(async () => expect((await service.getStatus()).state).toBe('revoked'));
  });
});
