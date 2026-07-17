import type { WebContents } from 'electron';
import { parsePrintJobPayload, type PrintJobPayloadV1 } from '../shared/label.ts';

export type SystemPrinter = { name: string; isDefault?: boolean; status?: number };
export type PrintResult = { success: boolean; failureReason?: string };

export type PrintWebContents = Pick<WebContents, 'getPrintersAsync' | 'loadURL' | 'print'>;

export class UnsupportedPageSizeError extends Error {
  readonly code = 'UNSUPPORTED_PAGE_SIZE';
}

export class ElectronPrintEngine {
  constructor(private readonly webContents: PrintWebContents) {}

  async printers(): Promise<SystemPrinter[]> {
    return this.webContents.getPrintersAsync();
  }

  async print(candidate: PrintJobPayloadV1, deviceName: string): Promise<void> {
    const payload = parsePrintJobPayload(candidate);
    if (!deviceName) throw Object.assign(new Error('Select a system printer in Connector Settings'), { code: 'PRINTER_NOT_SELECTED' });
    const printers = await this.printers();
    if (!printers.some((printer) => printer.name === deviceName)) throw Object.assign(new Error(`Printer not found: ${deviceName}`), { code: 'PRINTER_NOT_FOUND' });

    await this.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(payload.html)}`);
    const result = await new Promise<PrintResult>((resolve) => {
      this.webContents.print({
        silent: true,
        deviceName,
        printBackground: true,
        scaleFactor: 100,
        margins: { marginType: 'none' },
        pageSize: { width: Math.round(payload.widthMm * 1000), height: Math.round(payload.heightMm * 1000) },
        copies: payload.copies,
        header: '',
        footer: '',
      }, (success, failureReason) => resolve({ success, failureReason }));
    });

    if (!result.success) {
      if (/page|size|paper|media/i.test(result.failureReason ?? '')) throw new UnsupportedPageSizeError(result.failureReason || 'Printer driver does not support this page size');
      throw Object.assign(new Error(result.failureReason || 'OS spooler rejected the job'), { code: 'PRINT_FAILED' });
    }
  }
}
