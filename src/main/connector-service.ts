import bwipjs from '@bwip-js/node';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  ActivityLogEntrySchema,
  ConnectorRuntimeSchema,
  EditableSettingsSchema,
  JournalSchema,
  LabelSizeSchema,
  PairingInputSchema,
  type ActivityLogEntry,
  type ConnectorRuntime,
  type ConnectorStatus,
  type EditableSettings,
  type Journal,
  type LabelSize,
  type PairingInput,
  type PairingResult,
} from '../shared/contracts.ts';
import { createPayload, parsePrintJobPayload, type PrintJobPayloadV1 } from '../shared/label.ts';
import type { ElectronPrintEngine } from './print-engine.ts';

export interface SecureStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

type Credentials = { connectorId: string; token: string };
type ConnectorServiceOptions = {
  userDataPath: string;
  secureStorage: SecureStorage;
  printer: ElectronPrintEngine;
  version: string;
  os: string;
  fetchFn?: typeof fetch;
  delay?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
};

const PairingResponseSchema = z.object({ connectorId: z.string().min(1), token: z.string().min(1) }).strict();
const StoredCredentialsSchema = z.object({ connectorId: z.string().min(1), token: z.string().min(1) });
const LogSchema = z.array(ActivityLogEntrySchema);

class ConnectorRevokedError extends Error {}

export class ConnectorService {
  private readonly statePath: string;
  private readonly credentialsPath: string;
  private readonly settingsPath: string;
  private readonly logPath: string;
  private readonly fetchFn: typeof fetch;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly now: () => Date;
  private settings: EditableSettings;
  private runtime: ConnectorRuntime = {
    state: 'not_paired',
    message: 'Not paired',
    lastHeartbeatAt: null,
    lastError: null,
    lastJobAt: null,
  };
  private stopped = false;
  private loopPromise: Promise<void> | null = null;
  private abortController = new AbortController();

  constructor(private readonly options: ConnectorServiceOptions) {
    this.statePath = join(options.userDataPath, 'print-journal.json');
    this.credentialsPath = join(options.userDataPath, 'connector-credentials.json');
    this.settingsPath = join(options.userDataPath, 'connector-settings.json');
    this.logPath = join(options.userDataPath, 'activity-log.json');
    this.fetchFn = options.fetchFn ?? fetch;
    this.delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? (() => new Date());
    this.settings = this.loadSettings();
  }

  private readJson(path: string): unknown {
    if (!existsSync(path)) return undefined;
    try { return JSON.parse(readFileSync(path, 'utf8')) as unknown; } catch { return undefined; }
  }

  private persist(path: string, value: unknown): void {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(value));
    renameSync(temporary, path);
  }

  private loadSettings(): EditableSettings {
    const defaults = {
      portalUrl: (process.env.SITREM_PORTAL_URL || 'http://127.0.0.1:3010').replace(/\/$/, ''),
      printerName: process.env.SITREM_PRINTER_NAME || '',
      connectorName: process.env.SITREM_CONNECTOR_NAME || 'SitremPrinter',
    };
    const parsed = EditableSettingsSchema.safeParse({ ...defaults, ...(this.readJson(this.settingsPath) as object | undefined) });
    return parsed.success ? parsed.data : EditableSettingsSchema.parse(defaults);
  }

  private loadCredentials(): Credentials | null {
    if (!this.options.secureStorage.isEncryptionAvailable()) return null;
    const stored = StoredCredentialsSchema.safeParse(this.readJson(this.credentialsPath));
    if (!stored.success) return null;
    try {
      return { connectorId: stored.data.connectorId, token: this.options.secureStorage.decryptString(Buffer.from(stored.data.token, 'base64')) };
    } catch { return null; }
  }

  private saveCredentials(credentials: Credentials): void {
    if (!this.options.secureStorage.isEncryptionAvailable()) throw new Error('OS secure credential storage is unavailable');
    this.persist(this.credentialsPath, {
      connectorId: credentials.connectorId,
      token: this.options.secureStorage.encryptString(credentials.token).toString('base64'),
    });
  }

  private loadJournal(): Journal {
    const parsed = JournalSchema.safeParse(this.readJson(this.statePath));
    return parsed.success ? parsed.data : {};
  }

  private loadLogs(): ActivityLogEntry[] {
    const parsed = LogSchema.safeParse(this.readJson(this.logPath));
    return parsed.success ? parsed.data : [];
  }

  private log(event: string, detail = ''): void {
    const entries = this.loadLogs();
    entries.unshift({ at: this.now().toISOString(), event, detail });
    this.persist(this.logPath, entries.slice(0, 100));
  }

  private setRuntime(update: Partial<ConnectorRuntime>): void {
    this.runtime = ConnectorRuntimeSchema.parse({ ...this.runtime, ...update });
  }

  async getStatus(): Promise<ConnectorStatus> {
    let printers: Awaited<ReturnType<ElectronPrintEngine['printers']>> = [];
    let printerError: string | null = null;
    try {
      printers = await this.options.printer.printers();
    } catch (error) {
      printerError = `Unable to read system printers: ${this.asMessage(error)}`;
    }
    return {
      ...this.settings,
      paired: !!this.loadCredentials(),
      printers: printers.map((printer) => printer.name),
      printerAvailable: !!this.settings.printerName && printers.some((printer) => printer.name === this.settings.printerName),
      printerError,
      ...this.runtime,
    };
  }

  getLogs(): ActivityLogEntry[] { return this.loadLogs(); }

  getTraySnapshot(): Pick<ConnectorRuntime, 'state' | 'lastHeartbeatAt' | 'lastError'> & { printerName: string } {
    return { state: this.runtime.state, lastHeartbeatAt: this.runtime.lastHeartbeatAt, lastError: this.runtime.lastError, printerName: this.settings.printerName };
  }

  async pair(candidate: PairingInput): Promise<PairingResult> {
    const input = PairingInputSchema.parse(candidate);
    this.settings = EditableSettingsSchema.parse(input);
    this.persist(this.settingsPath, this.settings);
    const response = await this.fetchFn(`${this.settings.portalUrl}/api/print/connectors/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: input.pairingCode, name: input.connectorName }),
    });
    const body = await response.json().catch(() => ({})) as unknown;
    if (!response.ok) throw new Error(this.errorMessage(body, `Pairing failed (HTTP ${response.status})`));
    const credentials = PairingResponseSchema.parse(body);
    this.saveCredentials(credentials);
    this.log('paired', credentials.connectorId);
    this.setRuntime({ state: 'starting', message: 'Paired; starting Connector…', lastError: null });
    return { connectorId: credentials.connectorId };
  }

  saveSettings(candidate: EditableSettings): void {
    const next = EditableSettingsSchema.parse(candidate);
    if (this.loadCredentials() && next.portalUrl !== this.settings.portalUrl) throw new Error('Changing the portal URL requires pairing again with a new pairing code.');
    this.settings = next;
    this.persist(this.settingsPath, this.settings);
  }

  start(): void {
    if (this.loopPromise) return;
    const credentials = this.loadCredentials();
    if (!credentials) {
      this.setRuntime({ state: 'not_paired', message: 'Not paired', lastError: null });
      return;
    }
    this.stopped = false;
    this.abortController = new AbortController();
    this.loopPromise = this.run(credentials)
      .catch((error: unknown) => {
        const message = this.asMessage(error);
        this.setRuntime({ state: 'error', message: 'Connector stopped unexpectedly', lastError: message });
        this.log('connector_error', message);
      })
      .finally(() => { this.loopPromise = null; });
  }

  async restart(): Promise<void> {
    this.stop();
    if (this.loopPromise) await this.loopPromise;
    this.start();
  }

  stop(): void {
    this.stopped = true;
    this.abortController.abort();
  }

  async testPrint(candidate: LabelSize): Promise<void> {
    const size = LabelSizeSchema.parse(candidate);
    const barcode = await bwipjs.toSVG({ bcid: 'code128', text: 'SITREM-TEST-420B', includetext: true, scale: 2 });
    const html = `<!doctype html><style>@page{size:${size.widthMm}mm ${size.heightMm}mm;margin:0}html,body{margin:0;width:${size.widthMm}mm;height:${size.heightMm}mm;font:8pt Arial}.label{box-sizing:border-box;border:1mm solid #000;width:100%;height:100%;padding:1mm;background:repeating-linear-gradient(90deg,#ddd 0 .1mm,transparent .1mm 1mm),repeating-linear-gradient(0deg,#ddd 0 .1mm,transparent .1mm 1mm)}h1{margin:0;font-size:10pt;background:#fff;width:max-content}.meta{background:#fff;width:max-content;margin-top:1mm}.bar{position:absolute;bottom:1mm;left:1mm;right:1mm;height:12mm;background:#fff}.bar svg{width:100%;height:100%}</style><main class="label"><h1>Vretti 420B test grid</h1><div class="meta">${size.widthMm} × ${size.heightMm} mm · 203 DPI · ${this.now().toISOString()}</div><div class="bar">${barcode}</div></main>`;
    const payload = createPayload({ connectorId: 'local-test', idempotencyKey: `test-${this.now().getTime()}`, html, widthMm: size.widthMm, heightMm: size.heightMm, orientation: 'portrait', copies: 1 });
    await this.options.printer.print(payload, this.settings.printerName);
    this.log('test_label_spooled', `${size.widthMm}×${size.heightMm} mm`);
  }

  private async run(credentials: Credentials): Promise<void> {
    const journal = this.loadJournal();
    this.setRuntime({ state: 'starting', message: 'Recovering local print journal…', lastError: null });
    try { await this.recover(credentials, journal); }
    catch (error) { this.setRuntime({ state: 'error', message: 'Recovery could not reach the portal', lastError: this.asMessage(error) }); }

    let heartbeatAt = 0;
    while (!this.stopped) {
      try {
        if (Date.now() >= heartbeatAt) {
          this.setRuntime({ state: 'connecting', message: 'Sending heartbeat to portal…', lastError: null });
          await this.request(credentials, `/api/print/connectors/${credentials.connectorId}/heartbeat`, {
            method: 'POST',
            body: JSON.stringify({ version: this.options.version, os: this.options.os, deviceName: this.settings.printerName }),
          });
          this.setRuntime({ state: 'online', message: 'Connected to portal; waiting for print jobs', lastHeartbeatAt: this.now().toISOString(), lastError: null });
          heartbeatAt = Date.now() + 30_000;
        }
        const rawJob = await this.request(credentials, `/api/print/connectors/${credentials.connectorId}/claim`);
        if (rawJob) await this.processClaim(credentials, journal, rawJob);
        else await this.delay(1_000);
      } catch (error) {
        if (this.stopped) return;
        const detail = this.asMessage(error);
        const revoked = error instanceof ConnectorRevokedError;
        this.setRuntime({ state: revoked ? 'revoked' : 'offline', message: revoked ? 'Connector token was revoked; pair again' : 'Portal connection failed; retrying in 5 seconds', lastError: detail });
        this.log('portal_error', detail);
        if (revoked) return;
        await this.delay(5_000);
      }
    }
  }

  private async recover(credentials: Credentials, journal: Journal): Promise<void> {
    for (const [jobId, entry] of Object.entries(journal)) {
      if (entry.state === 'spooled') await this.acknowledge(credentials, jobId, { result: 'spooled' });
      else if (entry.state === 'printing') await this.acknowledge(credentials, jobId, { result: 'attention', errorCode: 'UNKNOWN_RESULT', errorMessage: 'Connector restarted while print result was unknown' });
      delete journal[jobId];
    }
    this.persist(this.statePath, journal);
  }

  private async processClaim(credentials: Credentials, journal: Journal, rawJob: unknown): Promise<void> {
    let job: PrintJobPayloadV1;
    try { job = parsePrintJobPayload(rawJob); }
    catch (error) {
      const rawId = typeof rawJob === 'object' && rawJob !== null && 'jobId' in rawJob && typeof rawJob.jobId === 'string' ? rawJob.jobId : null;
      if (!rawId) throw error;
      const invalidChecksum = this.asMessage(error).includes('CHECKSUM');
      await this.acknowledge(credentials, rawId, { result: 'error', errorCode: invalidChecksum ? 'INVALID_PAYLOAD_CHECKSUM' : 'INVALID_PAYLOAD', errorMessage: this.asMessage(error) });
      return;
    }

    this.setRuntime({ state: 'printing', message: `Processing job ${job.jobId}`, lastJobAt: this.now().toISOString() });
    journal[job.jobId] = { state: 'leased', updatedAt: Date.now() };
    this.persist(this.statePath, journal);
    const renewal = setInterval(() => { void this.request(credentials, `/api/print/connectors/${credentials.connectorId}/jobs/${job.jobId}/renew`, { method: 'POST' }).catch(() => undefined); }, 60_000);
    try {
      journal[job.jobId] = { state: 'printing', updatedAt: Date.now() };
      this.persist(this.statePath, journal);
      await this.options.printer.print(job, this.settings.printerName);
      journal[job.jobId] = { state: 'spooled', updatedAt: Date.now() };
      this.persist(this.statePath, journal);
      this.log('spooled', job.jobId);
      await this.acknowledge(credentials, job.jobId, { result: 'spooled' });
      delete journal[job.jobId];
      this.persist(this.statePath, journal);
      this.setRuntime({ state: 'online', message: 'Label sent to system print queue; waiting for jobs' });
    } catch (error) {
      if (journal[job.jobId]?.state === 'spooled') throw error;
      const message = this.asMessage(error);
      const errorCode = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'PRINT_FAILED';
      this.log('print_error', message);
      await this.acknowledge(credentials, job.jobId, { result: 'error', errorCode, errorMessage: message });
      delete journal[job.jobId];
      this.persist(this.statePath, journal);
    } finally { clearInterval(renewal); }
  }

  private acknowledge(credentials: Credentials, jobId: string, body: Record<string, string>): Promise<unknown> {
    return this.request(credentials, `/api/print/connectors/${credentials.connectorId}/jobs/${jobId}/acknowledge`, { method: 'POST', body: JSON.stringify(body) });
  }

  private async request(credentials: Credentials, path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchFn(`${this.settings.portalUrl}${path}`, {
      ...init,
      signal: init.signal ?? this.abortController.signal,
      headers: { authorization: `Bearer ${credentials.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
    });
    if (response.status === 204) return null;
    const body = await response.json().catch(() => ({})) as unknown;
    if (response.status === 401) throw new ConnectorRevokedError('Connector token was revoked');
    if (!response.ok) throw new Error(this.errorMessage(body, `Portal request failed (HTTP ${response.status})`));
    return body;
  }

  private errorMessage(body: unknown, fallback: string): string {
    return typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : fallback;
  }

  private asMessage(error: unknown): string { return error instanceof Error ? error.message : 'Unknown error'; }
}
