import type { WebContents } from 'electron';
import { parsePrintJobPayload, type PrintJobPayloadV1 } from '../shared/label.ts';

export type SystemPrinter = { name: string; isDefault?: boolean; status?: number };
export type PrintResult = { success: boolean; failureReason?: string };

export type PrintWebContents = Pick<WebContents, 'getPrintersAsync' | 'loadURL' | 'print'>;

export interface PrintEngine {
  printers(): Promise<SystemPrinter[]>;
  print(candidate: PrintJobPayloadV1, deviceName: string): Promise<void>;
}

export class PrintCoordinator implements PrintEngine {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  constructor(private readonly engine: PrintEngine, private readonly maximum = 8) {}
  printers(): Promise<SystemPrinter[]> { return this.engine.printers(); }
  idle(): Promise<void> { return this.tail; }
  print(candidate: PrintJobPayloadV1, deviceName: string, beforeSubmit?: () => Promise<void>): Promise<void> {
    if (this.pending >= this.maximum) return Promise.reject(new Error('Print queue is full'));
    const payload = structuredClone(candidate);
    this.pending++;
    const operation = this.tail.then(async () => { await beforeSubmit?.(); await this.engine.print(payload, deviceName); });
    this.tail = operation.catch(() => undefined).finally(() => { this.pending--; });
    return operation;
  }
}

export class PreSubmissionError extends Error {
  readonly code = 'PRE_SUBMISSION_FAILED';
}

/** A callback failure occurs after print() was invoked; it cannot prove no output. */
export class SubmittedPrintError extends Error {
  readonly submissionUncertain = true;
  readonly code: string = 'PRINT_FAILED';
}

export class UnsupportedPageSizeError extends SubmittedPrintError {
  readonly code = 'UNSUPPORTED_PAGE_SIZE';
}

export class ElectronPrintEngine implements PrintEngine {
  constructor(private readonly webContents: PrintWebContents, private readonly timeoutMs = 120_000,
    private readonly recreate?: () => PrintWebContents) {}

  private current: PrintWebContents | undefined;
  private async bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Print operation timed out; result is uncertain')), this.timeoutMs);
      })]);
    } catch (error) {
      if (this.recreate) this.current = this.recreate();
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  }

  async printers(): Promise<SystemPrinter[]> {
    return this.bounded((this.current ?? this.webContents).getPrintersAsync());
  }

  async print(candidate: PrintJobPayloadV1, deviceName: string): Promise<void> {
    const payload = parsePrintJobPayload(candidate);
    if (!deviceName) throw Object.assign(new Error('Select a system printer in Connector Settings'), { code: 'PRINTER_NOT_SELECTED' });
    let printers: SystemPrinter[];
    try { printers = await this.printers(); } catch { throw new PreSubmissionError('System printer discovery failed. Check the spooler and replace this job.'); }
    if (!printers.some((printer) => printer.name === deviceName)) throw Object.assign(new Error(`Printer not found: ${deviceName}`), { code: 'PRINTER_NOT_FOUND' });

    const contents = this.current ?? this.webContents;
    const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:; base-uri \'none\'; form-action \'none\'">';
    try { await this.bounded(contents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html>' + csp + payload.html.replace(/<!doctype[^>]*>/i, ''))}`)); }
    catch { throw new PreSubmissionError('Label could not load before print submission. Restart the Connector and replace this job.'); }
    const result = await this.bounded(new Promise<PrintResult>((resolve) => {
      contents.print({
        silent: true,
        deviceName,
        printBackground: true,
        scaleFactor: 100,
        landscape: false, // Payload HTML owns content rotation; pageSize is physical stock.
        margins: { marginType: 'none' },
        pageSize: { width: Math.round(payload.widthMm * 1000), height: Math.round(payload.heightMm * 1000) },
        copies: payload.copies,
        header: '',
        footer: '',
      }, (success, failureReason) => resolve({ success, failureReason }));
    }));

    if (!result.success) {
      if (/page|size|paper|media/i.test(result.failureReason ?? '')) throw new UnsupportedPageSizeError(result.failureReason || 'Printer driver does not support this page size');
      throw new SubmittedPrintError(result.failureReason || 'OS spooler rejected the job');
    }
  }
}
