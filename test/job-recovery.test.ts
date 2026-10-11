import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobProcessor } from '../src/main/job-processor.ts';
import { JournalStore } from '../src/main/storage.ts';
import { PortalClient } from '../src/main/portal-client.ts';
import { PrintCoordinator, ElectronPrintEngine, type PrintWebContents, type PrintEngine } from '../src/main/print-engine.ts';
import { createPayload } from '../src/shared/label.ts';
const identity = { portalUrl: 'https://portal.test', connectorId: 'connector-1', token: 'secret' };
const dirs: string[] = [];
const payload = (jobId = 'job-1') => createPayload({ jobId, connectorId: identity.connectorId, idempotencyKey: jobId, html: '<div>label</div>', widthMm: 50, heightMm: 30, orientation: 'portrait', copies: 1 });
const response = (status = 200, body: unknown = {}) => new Response(JSON.stringify(body), { status });
function setup(fetchFn: typeof fetch, print: PrintEngine['print'] = vi.fn(async () => {})) {
  const dir = mkdtempSync(join(tmpdir(), 'print-recovery-')); dirs.push(dir);
  const journal = new JournalStore(join(dir, 'journal.json'), identity);
  const status = vi.fn();
  return { journal, print, status, processor: new JobProcessor(new PortalClient(identity, fetchFn), journal, new PrintCoordinator({ printers: async () => [], print }), () => new Date(), status, vi.fn()) };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('durable job recovery', () => {
  it('rejects incompatible loaded stock and preserves the rejection on replay', async () => {
    const { journal, processor, print } = setup(vi.fn(async () => response()));
    await processor.process(payload(), 'Printer', new AbortController().signal, { widthMm: 60, heightMm: 40 });
    expect(journal.all()[0]).toMatchObject({ state: 'rejected', acknowledged: true, acknowledgement: { result: 'error', errorCode: 'MEDIA_MISMATCH' } });
    await processor.process(payload(), 'Printer', new AbortController().signal, { widthMm: 50, heightMm: 30 });
    expect(print).not.toHaveBeenCalled();
    await processor.process(payload('replacement'), 'Printer', new AbortController().signal, { widthMm: 50, heightMm: 30 });
    expect(print).toHaveBeenCalledOnce();
  });

  it.each(['error', 'attention', 'spooled'])('reconciles a lost %s acknowledgement without printing again', async result => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith('/state') ? response(200, { id: 'job-1', status: result === 'error' ? 'failed' : result, errorCode: result === 'error' ? 'INVALID_PAYLOAD' : 'UNKNOWN_RESULT' }) : response(409));
    const { journal, processor, print } = setup(fetchFn);
    journal.put({ portalUrl: identity.portalUrl, connectorId: identity.connectorId, jobId: 'job-1', state: result === 'error' ? 'rejected' : result === 'spooled' ? 'spooled' : 'attention', updatedAt: 1, acknowledged: false, acknowledgement: { result, errorCode: result === 'error' ? 'INVALID_PAYLOAD' : 'UNKNOWN_RESULT' } });
    await processor.recover(new AbortController().signal);
    expect(journal.all()[0]).toMatchObject({ acknowledged: true, reconciliationRequired: false });
    expect(print).not.toHaveBeenCalled();
  });
  it('retains conflicting evidence without blocking subsequent processing', async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => String(url).includes('/old/acknowledge') ? response(409) : String(url).endsWith('/state') ? response(200, { id: 'old', status: 'cancelled', errorCode: null }) : response());
    const { journal, processor, print } = setup(fetchFn);
    journal.put({ portalUrl: identity.portalUrl, connectorId: identity.connectorId, jobId: 'old', state: 'attention', updatedAt: 1, acknowledged: false, acknowledgement: { result: 'attention', errorCode: 'UNKNOWN_RESULT' } });
    await processor.recover(new AbortController().signal);
    expect(journal.all()[0]).toMatchObject({ acknowledged: false, reconciliationRequired: true, state: 'attention' });
    const calls = fetchFn.mock.calls.length;
    await processor.recover(new AbortController().signal);
    expect(fetchFn).toHaveBeenCalledTimes(calls);
    await processor.process(payload('new'), 'Printer', new AbortController().signal);
    expect(print).toHaveBeenCalledOnce();
  });
  it.each([
    { id: 'another-job', status: 'spooled', errorCode: null },
    { id: 'job-1', status: 'spooled' },
    null,
  ])('quarantines an invalid or unrelated authoritative state', async state => {
    const { journal, processor, print } = setup(vi.fn(async url => String(url).endsWith('/state') ? response(200, state) : response(409)));
    journal.put({ portalUrl: identity.portalUrl, connectorId: identity.connectorId, jobId: 'job-1', state: 'spooled', updatedAt: 1, acknowledged: false, acknowledgement: { result: 'spooled' } });
    await processor.recover(new AbortController().signal);
    expect(journal.all()[0]).toMatchObject({ acknowledged: false, reconciliationRequired: true });
    await processor.process(payload(), 'Printer', new AbortController().signal);
    expect(print).not.toHaveBeenCalled();
  });
  it('bounds recovery batches and gives later receipts a turn', async () => {
    const fetchFn = vi.fn(async (_url: RequestInfo | URL) => { throw new Error('network'); });
    const { journal, processor } = setup(fetchFn);
    for (const jobId of ['first', 'second', 'third']) journal.put({ portalUrl: identity.portalUrl, connectorId: identity.connectorId, jobId, state: 'spooled', updatedAt: 1, acknowledged: false });
    await processor.recover(new AbortController().signal);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    await processor.recover(new AbortController().signal);
    expect(fetchFn.mock.calls.some(call => String(call[0]).includes('/third/'))).toBe(true);
  });
  it('continues recovery after one transient acknowledgement failure', async () => {
    const { journal, processor } = setup(vi.fn(async (url: RequestInfo | URL) => { if (String(url).includes('/old/')) throw new Error('network'); return response(); }));
    for (const jobId of ['old', 'new']) journal.put({ portalUrl: identity.portalUrl, connectorId: identity.connectorId, jobId, state: 'spooled', updatedAt: 1, acknowledged: false });
    await processor.recover(new AbortController().signal);
    expect(journal.all().map(r => r.acknowledged)).toEqual([false, true]);
  });
  it.each(['PRINTER_NOT_SELECTED', 'PRINTER_NOT_FOUND', 'UNSUPPORTED_PAGE_SIZE', 'PRE_SUBMISSION_FAILED'])('reports %s as definitely unsubmitted', async code => {
    const print = vi.fn(async () => { throw Object.assign(new Error('private device details'), { code }); });
    const { journal, processor } = setup(vi.fn(async () => response()), print);
    await processor.process(payload(), 'Printer', new AbortController().signal);
    expect(journal.all()[0]).toMatchObject({ state: 'rejected', acknowledgement: { result: 'error', errorCode: code } });
    expect(JSON.stringify(journal.all())).not.toContain('private device details');
  });
  it('keeps uncertain submission suppressed but accepts a new replacement ID', async () => {
    const print = vi.fn(async () => { if (print.mock.calls.length === 1) throw new Error('callback lost'); });
    const { journal, processor } = setup(vi.fn(async () => response()), print);
    await processor.process(payload(), 'Printer', new AbortController().signal);
    expect(journal.all()[0]).toMatchObject({ state: 'attention', acknowledgement: { errorCode: 'UNKNOWN_RESULT' } });
    await processor.process(payload(), 'Printer', new AbortController().signal);
    expect(print).toHaveBeenCalledOnce();
    await processor.process(payload('replacement'), 'Printer', new AbortController().signal);
    expect(print).toHaveBeenCalledTimes(2);
  });
  it.each(['Invalid page size', 'Paper jam after submission', 'Print job failed'])('requires physical review after driver callback failure: %s', async reason => {
    const contents = { getPrintersAsync: async () => [{ name: 'Printer' }], loadURL: async () => {}, print: vi.fn((_options, done) => done(false, reason)) } as unknown as PrintWebContents;
    const print = vi.fn(async (job: ReturnType<typeof payload>, name: string) => new ElectronPrintEngine(contents).print(job, name));
    const { journal, processor } = setup(vi.fn(async () => response()), print);
    await processor.process(payload(), 'Printer', new AbortController().signal);
    expect(journal.all()[0]).toMatchObject({ state: 'attention', acknowledgement: { result: 'attention', errorCode: 'UNKNOWN_RESULT' } });
    await processor.process(payload(), 'Printer', new AbortController().signal);
    expect(contents.print).toHaveBeenCalledOnce();
  });
});
