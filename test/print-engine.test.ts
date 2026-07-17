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
});
