import { describe, expect, it, vi } from 'vitest';
import { createPayload } from '../src/shared/label.ts';
import { ElectronPrintEngine, UnsupportedPageSizeError, type PrintWebContents } from '../src/main/print-engine.ts';

const payload = createPayload({ connectorId: 'c', idempotencyKey: 'i', html: '<style>@page { size: 50mm 30mm; margin:0 }</style><svg/>', widthMm: 50, heightMm: 30, orientation: 'portrait', copies: 1 });

describe('ElectronPrintEngine', () => {
  it('prints validated data content with micrometre size and no margins', async () => {
    let options: Electron.WebContentsPrintOptions | undefined;
    const webContents = {
      getPrintersAsync: vi.fn(async () => [{ name: 'VRETTI 420B' }]),
      loadURL: vi.fn(async () => undefined),
      print: vi.fn((candidate, done) => { options = candidate; done(true, ''); }),
    } as unknown as PrintWebContents;
    await new ElectronPrintEngine(webContents).print(payload, 'VRETTI 420B');
    expect(webContents.loadURL).toHaveBeenCalledWith(expect.stringMatching(/^data:text\/html/));
    expect(options?.pageSize).toEqual({ width: 50_000, height: 30_000 });
    expect(options?.margins).toEqual({ marginType: 'none' });
    expect(options?.printBackground).toBe(true);
    expect(options?.copies).toBe(1);
    expect(options?.landscape).toBe(false);
  });

  it('does not rotate physical stock again for landscape HTML', async () => {
    const print = vi.fn((_options, done) => done(true, ''));
    const contents = { getPrintersAsync: async () => [{ name: 'Printer' }], loadURL: async () => {}, print } as unknown as PrintWebContents;
    await new ElectronPrintEngine(contents).print({ ...payload, orientation: 'landscape' }, 'Printer');
    expect(print).toHaveBeenCalledWith(expect.objectContaining({ landscape: false, pageSize: { width: 50000, height: 30000 } }), expect.any(Function));
  });

  it('distinguishes unsupported driver page sizes', async () => {
    const webContents = {
      getPrintersAsync: vi.fn(async () => [{ name: 'Any printer' }]),
      loadURL: vi.fn(async () => undefined),
      print: vi.fn((_options, done) => done(false, 'Invalid page size')),
    } as unknown as PrintWebContents;
    await expect(new ElectronPrintEngine(webContents).print(payload, 'Any printer')).rejects.toBeInstanceOf(UnsupportedPageSizeError);
  });

  it('rejects unavailable printers before loading label content', async () => {
    const webContents = { getPrintersAsync: vi.fn(async () => []), loadURL: vi.fn(), print: vi.fn() } as unknown as PrintWebContents;
    await expect(new ElectronPrintEngine(webContents).print(payload, 'Missing')).rejects.toMatchObject({ code: 'PRINTER_NOT_FOUND' });
    expect(webContents.loadURL).not.toHaveBeenCalled();
  });
  it.each(['discovery', 'load'])('reports %s failure as unsubmitted and never invokes print', async stage => {
    const contents = {
      getPrintersAsync: vi.fn(async () => { if (stage === 'discovery') throw new Error('spooler'); return [{ name: 'Printer' }]; }),
      loadURL: vi.fn(async () => { throw new Error('renderer'); }), print: vi.fn(),
    } as unknown as PrintWebContents;
    await expect(new ElectronPrintEngine(contents).print(payload, 'Printer')).rejects.toMatchObject({ code: 'PRE_SUBMISSION_FAILED' });
    expect(contents.print).not.toHaveBeenCalled();
  });
});
