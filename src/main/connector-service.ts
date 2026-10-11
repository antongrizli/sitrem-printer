import bwipjs from '@bwip-js/node';
import { join } from 'node:path';
import { z } from 'zod';
import { ActivityLogEntrySchema, ConnectorRuntimeSchema, EditableSettingsSchema, LabelSizeSchema, PairingInputSchema,
  MediaSyncSchema, type ActivityLogEntry, type ConnectorRuntime, type ConnectorStatus, type EditableSettings, type LabelSize, type MediaSync, type PairingInput, type PairingResult } from '../shared/contracts.ts';
import { createPayload } from '../shared/label.ts';
import { PrintCoordinator, type PrintEngine } from './print-engine.ts';
import { abortableDelay, PortalClient, PortalHttpError, ConnectorRevokedError, type SessionIdentity } from './portal-client.ts';
import { JournalStore, readJson, writeJson, StorageError } from './storage.ts';
import { JobProcessor } from './job-processor.ts';

export interface SecureStorage {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
type Options = {
  userDataPath: string; secureStorage: SecureStorage; printer: PrintEngine; version: string; os: string;
  fetchFn?: typeof fetch; delay?: (milliseconds: number) => Promise<void>; now?: () => Date; requestTimeoutMs?: number;
};
const PairResponse = z.object({
  connectorId: z.string().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/),
  token: z.string().min(1).max(4096),
  mediaSyncVersion: z.number().int().nullable().optional(),
}).passthrough();
const StoredSession = z.object({ schemaVersion: z.literal(2), settings: EditableSettingsSchema,
  mediaSync: MediaSyncSchema,
  connectorId: z.string().min(1), token: z.string().min(1) }).strict();
const PreviousStoredSession = z.object({ schemaVersion: z.literal(1), settings: EditableSettingsSchema,
  connectorId: z.string().min(1), token: z.string().min(1) }).strict();
const MediaSelection = EditableSettingsSchema.shape.selectedMedia;
const MediaSyncResponse = z.object({ clientRevision: z.number().int().nonnegative(), serverRevision: z.number().int().nonnegative(),
  isDefaultConnector: z.boolean(), media: MediaSelection.optional(), effectiveMedia: MediaSelection.optional(),
}).passthrough().transform(value => ({ ...value, media: value.media === undefined ? value.effectiveMedia ?? null : value.media }));

export class ConnectorService {
  private mediaWork: Promise<void> = Promise.resolve();
  private settings: EditableSettings;
  private mediaSync: MediaSync = { clientRevision: 0, serverRevision: null, state: 'not_selected', message: null };
  private identity: SessionIdentity | null = null;
  private journal: JournalStore | undefined;
  private runtime: ConnectorRuntime = { state: 'not_paired', message: 'Not paired', lastHeartbeatAt: null, lastError: null, lastJobAt: null };
  private loopPromise: Promise<void> | null = null;
  private abortController = new AbortController();
  private stopped = true;
  private pairing = false;
  private storageFailure: string | null = null;
  private readonly listeners = new Set<() => void>();
  private logs: ActivityLogEntry[] = [];
  private discovery: { at: number; printers: string[]; error: string | null } | undefined;
  private discoveryPromise: Promise<void> | undefined;
  private readonly printer: PrintCoordinator;
  private readonly now: () => Date;
  private readonly fetchFn: typeof fetch;
  private readonly sessionPath: string;

  constructor(private readonly options: Options) {
    this.sessionPath = join(options.userDataPath, 'connector-session.json');
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.printer = new PrintCoordinator(options.printer);
    this.settings = EditableSettingsSchema.parse({ portalUrl: process.env.SITREM_PORTAL_URL || 'http://127.0.0.1:3010',
      printerName: process.env.SITREM_PRINTER_NAME || '', connectorName: process.env.SITREM_CONNECTOR_NAME || 'SitremPrinter' });
    try {
      const session = readJson(this.sessionPath);
      if (session !== undefined) {
        const current = StoredSession.safeParse(session);
        const previous = PreviousStoredSession.safeParse(session);
        if (!current.success && !previous.success) throw new StorageError('Connector session schema is invalid or newer than this app. Preserve this file and upgrade the Connector.');
        if (current.success) {
          this.settings = current.data.settings;
          this.mediaSync = current.data.mediaSync;
          this.identity = this.decrypt(current.data.connectorId, current.data.token, current.data.settings.portalUrl);
        } else {
          const legacy = previous.data;
          if (!legacy) throw new StorageError('Connector session schema is invalid or newer than this app. Preserve this file and upgrade the Connector.');
          this.settings = legacy.settings;
          this.mediaSync = { clientRevision: 0, serverRevision: null,
            state: legacy.settings.selectedMedia ? 'pending' : 'not_selected', message: null };
          this.identity = this.decrypt(legacy.connectorId, legacy.token, legacy.settings.portalUrl);
          this.commitSession(this.settings, this.identity);
        }
      } else {
        const legacySettings = readJson(join(options.userDataPath, 'connector-settings.json'));
        if (legacySettings !== undefined) this.settings = EditableSettingsSchema.parse(legacySettings);
        const credentials = readJson(join(options.userDataPath, 'connector-credentials.json'));
        if (credentials !== undefined) {
          if (legacySettings === undefined) throw new StorageError('Legacy credential portal identity is missing. Preserve the journal for recovery.');
          const record = PairResponse.parse(credentials);
          this.identity = this.decrypt(record.connectorId, record.token, this.settings.portalUrl);
          this.commitSession(this.settings, this.identity);
        }
      }
      this.journal = new JournalStore(join(options.userDataPath, 'print-journal.json'), {
        portalUrl: this.settings.portalUrl, connectorId: this.identity?.connectorId ?? 'unpaired' });
    } catch (error) {
      this.storageFailure = this.message(error);
      this.setRuntime({ state: 'attention', message: 'Local state needs recovery; printing is blocked', lastError: this.storageFailure });
    }
    try { this.logs = z.array(ActivityLogEntrySchema).parse(readJson(join(options.userDataPath, 'activity-log.json')) ?? []); } catch { this.logs = []; }
  }
  private decrypt(connectorId: string, encrypted: string, portalUrl: string): SessionIdentity {
    if (!this.options.secureStorage.isEncryptionAvailable()) throw new StorageError('OS secure storage unavailable; unlock the user session and restart.');
    return Object.freeze({ portalUrl, connectorId, token: this.options.secureStorage.decryptString(Buffer.from(encrypted, 'base64')) });
  }
  private commitSession(settings: EditableSettings, identity: SessionIdentity): void {
    if (!this.options.secureStorage.isEncryptionAvailable()) throw new StorageError('OS secure credential storage unavailable');
    writeJson(this.sessionPath, { schemaVersion: 2, settings, mediaSync: this.mediaSync, connectorId: identity.connectorId,
      token: this.options.secureStorage.encryptString(identity.token).toString('base64') });
  }
  private log(event: string, detail = ''): void {
    this.logs.unshift({ at: this.now().toISOString(), event, detail }); this.logs = this.logs.slice(0, 100);
    try { writeJson(join(this.options.userDataPath, 'activity-log.json'), this.logs); } catch { /* diagnostics never change print results */ }
  }
  private setRuntime(update: Partial<ConnectorRuntime>): void {
    this.runtime = ConnectorRuntimeSchema.parse({ ...this.runtime, ...update });
    for (const listener of this.listeners) listener();
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async getStatus(): Promise<ConnectorStatus> {
    if (!this.discovery || this.now().getTime() - this.discovery.at >= 10_000) {
      this.discoveryPromise ??= (async () => {
        try { this.discovery = { at: this.now().getTime(), printers: (await this.printer.printers()).map((p) => p.name), error: null }; }
        catch { this.discovery = { at: this.now().getTime(), printers: [], error: 'Unable to read system printers: spooler unavailable' }; }
      })().finally(() => { this.discoveryPromise = undefined; });
      await this.discoveryPromise;
    }
    const printers = this.discovery?.printers ?? [];
    return { ...this.settings, appVersion: this.options.version, mediaSync: this.mediaSync, paired: !!this.identity, printers, printerAvailable: !!this.settings.printerName && printers.includes(this.settings.printerName),
      printerError: this.discovery?.error ?? null, recoveryJobIds: (this.journal?.all() ?? [])
        .filter((r) => r.portalUrl === this.identity?.portalUrl && r.connectorId === this.identity?.connectorId && (r.reconciliationRequired || r.state === 'attention'))
        .map((r) => r.jobId), ...this.runtime };
  }
  invalidatePrinters(): void { this.discovery = undefined; }
  getLogs(): ActivityLogEntry[] { return structuredClone(this.logs); }
  getTraySnapshot() { return { ...this.runtime, printerName: this.settings.printerName }; }
  diagnostics(): string {
    return JSON.stringify({ version: this.options.version, os: this.options.os, architecture: process.arch, state: this.runtime.state,
      printerName: this.settings.printerName, selectedMedia: this.settings.selectedMedia, mediaSync: this.mediaSync, recovery: (this.journal?.all() ?? []).filter((r) => !r.acknowledged || r.state === 'attention')
        .map((r) => ({ jobId: r.jobId, state: r.state, pending: !r.acknowledged, errorCode: r.acknowledgement?.errorCode ?? null, reconciliationRequired: r.reconciliationRequired ?? false, currentSession: r.portalUrl === this.identity?.portalUrl && r.connectorId === this.identity?.connectorId })),
      events: this.logs.map(({ at, event }) => ({ at, event })) }, null, 2);
  }
  private healthy(): void { if (this.storageFailure) throw new StorageError(this.storageFailure); }
  private transport(settings: EditableSettings): void {
    const url = new URL(settings.portalUrl);
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !settings.allowInsecureHttp)
      throw new Error('Remote HTTP requires explicit insecure LAN opt-in. Use HTTPS whenever possible.');
  }
  async pair(candidate: PairingInput): Promise<PairingResult> {
    this.healthy(); if (this.pairing) throw new Error('Pairing is already in progress');
    const input = PairingInputSchema.parse(candidate);
    const settings = EditableSettingsSchema.parse(input); this.transport(settings);
    this.pairing = true;
    const wasRunning = !this.stopped;
    try {
      await this.shutdown(); await this.printer.idle();
      const response = await this.fetchFn(`${settings.portalUrl}/api/print/connectors/pair`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 15_000),
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: input.pairingCode, name: input.connectorName }),
      });
      if (!response.ok) throw new Error(`Pairing failed (HTTP ${response.status})`);
      const credentials = PairResponse.parse(await response.json());
      const identity = Object.freeze({ ...credentials, portalUrl: settings.portalUrl });
      this.mediaSync = { clientRevision: settings.selectedMedia ? 1 : 0, serverRevision: null, state: settings.selectedMedia ? 'pending' : 'not_selected', message: null };
      this.settings = settings; this.identity = identity;
      this.commitSession(settings, identity);
      if (settings.selectedMedia) await this.syncMedia(new PortalClient(identity, this.fetchFn, this.options.requestTimeoutMs));
      this.log('paired', credentials.connectorId);
      this.setRuntime({ state: 'starting', message: 'Paired; ready to start', lastError: null });
      return { connectorId: credentials.connectorId };
    } finally { this.pairing = false; if (wasRunning) this.start(); }
  }
  async saveSettings(candidate: EditableSettings): Promise<void> {
    this.healthy(); if (this.pairing) throw new Error('Wait for pairing to finish');
    await this.mediaWork;
    const next = EditableSettingsSchema.parse(candidate); this.transport(next);
    if (this.identity && next.portalUrl !== this.identity.portalUrl) throw new Error('Changing the portal URL requires pairing again with a new pairing code.');
    const mediaChanged = JSON.stringify(next.selectedMedia) !== JSON.stringify(this.settings.selectedMedia) || next.printerName !== this.settings.printerName;
    if (mediaChanged) this.mediaSync = { ...this.mediaSync, clientRevision: this.mediaSync.clientRevision + 1,
      state: next.selectedMedia ? 'pending' : 'not_selected', message: null };
    if (this.identity) this.commitSession(next, this.identity); else writeJson(join(this.options.userDataPath, 'connector-settings.json'), next);
    this.settings = next; this.invalidatePrinters(); this.setRuntime({});
    if (this.identity && this.settings.selectedMedia) await this.syncMedia(new PortalClient(this.identity, this.fetchFn, this.options.requestTimeoutMs));
  }
  start(): void {
    if (this.loopPromise || this.pairing || this.storageFailure) return;
    if (!this.identity) { this.setRuntime({ state: 'not_paired', message: 'Not paired', lastError: null }); return; }
    try { this.transport(this.settings); } catch (error) { this.setRuntime({ state: 'attention', message: 'Confirm insecure LAN access in Configuration', lastError: this.message(error) }); return; }
    this.stopped = false; this.abortController = new AbortController();
    this.loopPromise = this.run(this.identity).catch((error: unknown) => {
      if (error instanceof StorageError) this.storageFailure = this.message(error);
      this.setRuntime({ state: 'attention', message: 'Connector paused; review recovery status', lastError: this.message(error) });
    }).finally(() => { this.loopPromise = null; });
  }
  stop(): void { this.stopped = true; this.abortController.abort(); }
  async shutdown(): Promise<void> { this.stop(); await this.loopPromise; }
  async restart(): Promise<void> { await this.shutdown(); this.start(); }
  async testPrint(candidate: LabelSize): Promise<void> {
    this.healthy(); if (this.pairing) throw new Error('Wait for pairing to finish');
    const printerName = this.settings.printerName;
    const size = LabelSizeSchema.parse(candidate);
    const barcode = bwipjs.toSVG({ bcid: 'code128', text: 'SITREM-TEST-420B', includetext: true, scale: 2 });
    const html = `<!doctype html><style>@page{size:${size.widthMm}mm ${size.heightMm}mm;margin:0}html,body{margin:0;width:${size.widthMm}mm;height:${size.heightMm}mm;font:8pt Arial}.label{box-sizing:border-box;border:1mm solid #000;width:100%;height:100%;padding:1mm}h1{margin:0;font-size:10pt}.bar{height:12mm}.bar svg{width:100%;height:100%}</style><main class="label"><h1>SITREM calibration grid</h1><p>${size.widthMm} × ${size.heightMm} mm · verify edges · ${this.now().toISOString()}</p><div class="bar">${barcode}</div></main>`;
    await this.printer.print(createPayload({ connectorId: 'local-test', idempotencyKey: `test-${this.now().getTime()}`, html, ...size, orientation: 'portrait', copies: 1 }), printerName);
    this.log('test_label_spooled');
  }
  private syncMedia(client: PortalClient, signal?: AbortSignal): Promise<void> {
    this.mediaWork = this.mediaWork.then(() => this.performMediaSync(client, signal));
    return this.mediaWork;
  }
  private async performMediaSync(client: PortalClient, signal?: AbortSignal): Promise<void> {
    if (!this.identity || signal?.aborted) return;
    if (['conflict', 'error', 'unsupported'].includes(this.mediaSync.state)) return;
    const path = `/api/print/connectors/${encodeURIComponent(this.identity.connectorId)}/media`;
    try {
      const current = MediaSyncResponse.parse(await client.request(path, {}, signal));
      const changedRemotely = current.serverRevision !== (this.mediaSync.serverRevision ?? 0);
      const localPending = this.mediaSync.state === 'pending';
      const differs = JSON.stringify(current.media) !== JSON.stringify(this.settings.selectedMedia);
      if (localPending && changedRemotely && differs) {
        this.mediaSync = { ...this.mediaSync, state: 'conflict', message: 'Format conflict: the portal and this computer changed the format. Choose which format to keep.' };
      } else if (localPending && this.settings.selectedMedia) {
        const revision = Math.max(this.mediaSync.clientRevision, current.clientRevision + 1, 1);
        const response = MediaSyncResponse.parse(await client.request(path, { method: 'PUT', body: JSON.stringify({ schemaVersion: 1,
          clientRevision: revision, expectedServerRevision: current.serverRevision, deviceName: this.settings.printerName, media: this.settings.selectedMedia }) }, signal));
        this.settings = { ...this.settings, selectedMedia: response.media };
        this.mediaSync = { clientRevision: response.clientRevision, serverRevision: response.serverRevision, state: 'synced', message: 'Format synchronized with the portal.' };
        this.log('media_synced');
      } else {
        this.settings = { ...this.settings, selectedMedia: current.media };
        this.mediaSync = { clientRevision: Math.max(this.mediaSync.clientRevision, current.clientRevision), serverRevision: current.serverRevision,
          state: current.media ? 'synced' : 'not_selected', message: current.media ? `Synced — ${current.media.widthMm} × ${current.media.heightMm} mm` : 'Select a label format.' };
        if (changedRemotely) this.log('portal_media_applied');
      }
      this.commitSession(this.settings, this.identity); this.setRuntime({});
    } catch (error) {
      if (error instanceof StorageError || error instanceof ConnectorRevokedError) throw error;
      if (signal?.aborted) return;
      const status = error instanceof PortalHttpError ? error.status : undefined;
      const unsupported = status !== undefined && [404, 405, 501].includes(status);
      this.mediaSync = { ...this.mediaSync, state: unsupported ? 'unsupported' : status === 409 ? 'conflict' : status === 400 || status === 422 ? 'error' : 'pending',
        message: unsupported ? 'Portal does not support label-format sync yet; selection is saved locally.' : status === 409 ? 'Format conflict: choose the portal or local format.' : status === 400 || status === 422 ? 'The portal rejected the format. Check the printer and label dimensions.' : 'Format saved locally; waiting to sync with the portal.' };
      this.commitSession(this.settings, this.identity); this.log('media_sync_failed', status ? `HTTP ${status}` : 'Connection unavailable'); this.setRuntime({});
    }
  }
  async resolveMediaConflict(choice: 'portal' | 'local'): Promise<void> {
    this.healthy(); if (!this.identity) throw new Error('Pair this Connector first');
    if (!['portal', 'local'].includes(choice)) throw new Error('Invalid conflict resolution');
    await this.mediaWork;
    const client = new PortalClient(this.identity, this.fetchFn, this.options.requestTimeoutMs);
    const current = MediaSyncResponse.parse(await client.request(`/api/print/connectors/${encodeURIComponent(this.identity.connectorId)}/media`));
    if (choice === 'portal') this.settings = { ...this.settings, selectedMedia: current.media };
    this.mediaSync = { clientRevision: Math.max(this.mediaSync.clientRevision, current.clientRevision), serverRevision: current.serverRevision,
      state: choice === 'local' ? 'pending' : current.media ? 'synced' : 'not_selected', message: null };
    this.commitSession(this.settings, this.identity);
    await this.syncMedia(client); this.setRuntime({});
  }
  private async run(identity: SessionIdentity): Promise<void> {
    const client = new PortalClient(identity, this.fetchFn, this.options.requestTimeoutMs);
    const signal = this.abortController.signal;
    const processor = new JobProcessor(client, this.journal!, this.printer, this.now, this.setRuntime.bind(this), this.log.bind(this));
    let heartbeatAt = 0; let failures = 0;
    while (!this.stopped) {
      try {
        await processor.recover(signal);
        if (this.stopped) break;
        if (this.now().getTime() >= heartbeatAt) {
          await this.syncMedia(client, signal);
          await client.request(`/api/print/connectors/${encodeURIComponent(identity.connectorId)}/heartbeat`, {
            method: 'POST', body: JSON.stringify({ version: this.options.version, os: this.options.os, deviceName: this.settings.printerName, mediaClientRevision: this.mediaSync.clientRevision, mediaServerRevision: this.mediaSync.state === 'synced' ? this.mediaSync.serverRevision : null }),
          }, signal);
          this.setRuntime({ state: 'online', message: 'Connected; waiting for print jobs', lastHeartbeatAt: this.now().toISOString(), lastError: null });
          heartbeatAt = this.now().getTime() + 30_000;
        }
        if (this.settings.selectedMedia && !['synced', 'unsupported'].includes(this.mediaSync.state)) { await this.wait(1000, signal); continue; }
        const rawJob = await client.request(`/api/print/connectors/${encodeURIComponent(identity.connectorId)}/claim`, {}, signal);
        if (this.stopped) break;
        if (rawJob) await processor.process(rawJob, this.settings.printerName, signal, this.settings.selectedMedia); else await this.wait(1_000, signal);
        failures = 0;
      } catch (error) {
        if (error instanceof StorageError) throw error;
        if (this.stopped) return;
        const revoked = error instanceof ConnectorRevokedError;
        this.setRuntime({ state: revoked ? 'revoked' : 'offline', message: revoked ? 'Token revoked; pair again' : 'Connection unavailable; retrying', lastError: this.message(error) });
        this.log(revoked ? 'revoked' : 'portal_error'); if (revoked) return;
        await this.wait(error instanceof PortalHttpError && error.retryAfterMs !== undefined ? error.retryAfterMs : Math.min(60_000, 1_000 * 2 ** Math.min(++failures, 6)) * (0.8 + Math.random() * 0.2), signal);
      }
    }
  }
  private async wait(ms: number, signal: AbortSignal): Promise<void> {
    if (this.options.delay) await this.options.delay(ms); else await abortableDelay(ms, signal);
  }
  private message(error: unknown): string { return error instanceof Error ? error.message : 'Unknown error'; }
}
