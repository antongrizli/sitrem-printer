import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorService } from '../src/main/connector-service.ts';
import { JournalStore, StorageError } from '../src/main/storage.ts';
import { PortalClient } from '../src/main/portal-client.ts';
import { PrintCoordinator, ElectronPrintEngine, type PrintWebContents } from '../src/main/print-engine.ts';
import { JobProcessor } from '../src/main/job-processor.ts';
import { createPayload } from '../src/shared/label.ts';
import { validateSettingsSender } from '../src/main/ipc-security.ts';

const directories: string[] = [];
const temp = () => { const path = mkdtempSync(join(tmpdir(), 'sitrem-safety-')); directories.push(path); return path; };
afterEach(() => { vi.useRealTimers(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const secureStorage = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() };
const identity = { portalUrl: 'https://a.example.test', connectorId: 'connector-1', token: 'SECRET-A' };
const settings = { portalUrl: identity.portalUrl, connectorName: 'Desk', printerName: 'Printer' };
const job = () => createPayload({ connectorId: identity.connectorId, idempotencyKey: 'order-1', html: '<div>ticket</div>', widthMm: 50, heightMm: 30, orientation: 'portrait', copies: 1 });
const ok = () => new Response('{}', { status: 200 });

describe('portal request boundaries', () => {
  it('classifies empty error responses and honors retry-after', async () => {
    const client = new PortalClient(identity, vi.fn(async () => new Response('', { status: 429, headers: { 'retry-after': '5' } })));
    await expect(client.request('/claim')).rejects.toMatchObject({ status: 429, retryAfterMs: 5000 });
  });
  it('rejects oversized responses and disables redirect following', async () => {
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('x'.repeat(2_000_001)));
    await expect(new PortalClient(identity, fetchFn).request('/claim')).rejects.toThrow('exceeds allowed size');
    expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
  });
});

describe('identity and durability', () => {
  it('preserves old settings and token after failed re-pairing', async () => {
    const path = temp();
    writeFileSync(join(path, 'connector-settings.json'), JSON.stringify(settings));
    writeFileSync(join(path, 'connector-credentials.json'), JSON.stringify({ connectorId: identity.connectorId, token: Buffer.from(identity.token).toString('base64') }));
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 403 }));
    const service = new ConnectorService({ userDataPath: path, secureStorage, printer: { printers: async () => [], print: async () => {} }, version: '1', os: 'win32', fetchFn });
    await expect(service.pair({ ...settings, portalUrl: 'https://b.example.test', pairingCode: 'code' })).rejects.toThrow('403');
    expect(await service.getStatus()).toMatchObject({ portalUrl: identity.portalUrl, paired: true });
    expect(fetchFn.mock.calls[0]?.[0]).toContain('b.example.test');
    expect(JSON.stringify(fetchFn.mock.calls)).not.toContain('SECRET-A');
    expect(JSON.parse(readFileSync(join(path, 'connector-session.json'), 'utf8')).settings.portalUrl).toBe(identity.portalUrl);
  });
  it('blocks network claims and calibration on a corrupted journal', async () => {
    const path = temp();
    writeFileSync(join(path, 'print-journal.json'), '{broken');
    const fetchFn = vi.fn();
    const print = vi.fn();
    const service = new ConnectorService({ userDataPath: path, secureStorage, printer: { printers: async () => [], print }, version: '1', os: 'win32', fetchFn });
    service.start();
    expect(await service.getStatus()).toMatchObject({ state: 'attention' });
    await expect(service.testPrint({ widthMm: 50, heightMm: 30 })).rejects.toBeInstanceOf(StorageError);
    expect(fetchFn).not.toHaveBeenCalled(); expect(print).not.toHaveBeenCalled();
    expect(readFileSync(join(path, 'print-journal.json'), 'utf8')).toBe('{broken');
  });
  it('keeps a known spooled receipt after lost acknowledgement and suppresses replay', async () => {
    const path = temp(); const journal = new JournalStore(join(path, 'journal.json'), identity);
    const payload = job(); let failAck = true;
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith('acknowledge') && failAck) throw new Error('lost response'); return ok();
    });
    const print = vi.fn(async () => {});
    const processor = new JobProcessor(new PortalClient(identity, fetchFn), journal, new PrintCoordinator({ printers: async () => [], print }), () => new Date(), vi.fn(), vi.fn());
    await expect(processor.process(payload, 'Printer', new AbortController().signal)).rejects.toThrow('lost response');
    expect(journal.find(identity.portalUrl, identity.connectorId, payload.jobId)?.state).toBe('spooled');
    failAck = false;
    await processor.recover(new AbortController().signal);
    await processor.process(payload, 'Printer', new AbortController().signal);
    expect(print).toHaveBeenCalledOnce();
    expect(journal.all()[0]?.acknowledged).toBe(true);
  });
  it('quarantines recovered printing jobs and scopes recovery to the original identity', async () => {
    const journal = new JournalStore(join(temp(), 'journal.json'), identity);
    journal.put({ portalUrl: identity.portalUrl, connectorId: identity.connectorId, jobId: 'old', state: 'printing', acknowledged: false, updatedAt: 1 });
    journal.put({ portalUrl: 'https://other.test', connectorId: 'other', jobId: 'foreign', state: 'spooled', acknowledged: false, updatedAt: 1 });
    const fetchFn = vi.fn(async () => ok()); const print = vi.fn(async () => {});
    const processor = new JobProcessor(new PortalClient(identity, fetchFn), journal, new PrintCoordinator({ printers: async () => [], print }), () => new Date(), vi.fn(), vi.fn());
    await processor.recover(new AbortController().signal);
    expect(journal.find(identity.portalUrl, identity.connectorId, 'old')).toMatchObject({ state: 'attention', acknowledged: true });
    expect(journal.find('https://other.test', 'other', 'foreign')).toMatchObject({ acknowledged: false });
    expect(print).not.toHaveBeenCalled(); expect(fetchFn).toHaveBeenCalledOnce();
  });
  it('rejects newer journal schemas rather than starting fresh', () => {
    const path = join(temp(), 'journal.json'); writeFileSync(path, JSON.stringify({ schemaVersion: 99, entries: [] }));
    expect(() => new JournalStore(path, identity)).toThrow(StorageError);
  });
});

describe('print isolation and security', () => {
  it('serializes calibration and production operations including the submission hook', async () => {
    let release: () => void = () => {};
    const events: string[] = [];
    const print = vi.fn(async (payload: ReturnType<typeof job>) => { events.push(payload.jobId); if (print.mock.calls.length === 1) await new Promise<void>((resolve) => { release = resolve; }); });
    const queue = new PrintCoordinator({ printers: async () => [], print });
    const a = job(); const b = job();
    const first = queue.print(a, 'A'); const second = queue.print(b, 'B', async () => { events.push('renew'); });
    await vi.waitFor(() => expect(events).toEqual([a.jobId])); release(); await Promise.all([first, second]);
    expect(events).toEqual([a.jobId, 'renew', b.jobId]);
  });
  it('times out a missing callback and recreates its renderer', async () => {
    const contents = { getPrintersAsync: async () => [{ name: 'Printer' }], loadURL: async () => {}, print: vi.fn() } as unknown as PrintWebContents;
    const recreate = vi.fn(() => contents);
    await expect(new ElectronPrintEngine(contents, 10, recreate).print(job(), 'Printer')).rejects.toThrow('uncertain');
    expect(recreate).toHaveBeenCalledOnce();
  });
  it('rejects subframes and another renderer before privileged IPC', () => {
    const trusted = { id: 1, url: 'file:///settings.html' };
    expect(() => validateSettingsSender({ sender: { id: 2 }, senderFrame: { url: trusted.url, parent: null } }, trusted)).toThrow();
    expect(() => validateSettingsSender({ sender: { id: 1 }, senderFrame: { url: trusted.url, parent: {} } }, trusted)).toThrow();
    expect(() => validateSettingsSender({ sender: { id: 1 }, senderFrame: { url: trusted.url, parent: null } }, trusted)).not.toThrow();
  });
});
