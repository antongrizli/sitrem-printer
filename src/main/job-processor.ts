import { parsePrintJobPayload } from '../shared/label.ts';
import type { ConnectorRuntime } from '../shared/contracts.ts';
import { apiPath, PortalClient, PortalHttpError, ConnectorRevokedError } from './portal-client.ts';
import { JournalStore, StorageError, type Receipt } from './storage.ts';
import { PrintCoordinator } from './print-engine.ts';
import { z } from 'zod';

const JobStateSchema = z.object({ id: z.string(), status: z.enum(['queued', 'leased', 'retry_wait', 'spooled', 'failed', 'attention', 'cancelled']), errorCode: z.string().nullable() });

export class JobProcessor {
  private recoveryOffset = 0;
  constructor(private readonly client: PortalClient, private readonly journal: JournalStore, private readonly printer: PrintCoordinator,
    private readonly now: () => Date, private readonly status: (update: Partial<ConnectorRuntime>) => void,
    private readonly log: (event: string, detail?: string) => void) {}
  private belongs(entry: Receipt): boolean {
    return entry.portalUrl === this.client.identity.portalUrl && entry.connectorId === this.client.identity.connectorId;
  }
  async recover(signal: AbortSignal): Promise<void> {
    const pending = this.journal.all().filter((r) => this.belongs(r) && !r.acknowledged && !r.reconciliationRequired);
    // Bound recovery work between heartbeats/claims, even with many failing receipts.
    const count = Math.min(2, pending.length);
    const batch = Array.from({ length: count }, (_, index) => pending[(this.recoveryOffset + index) % pending.length]!);
    this.recoveryOffset = pending.length ? (this.recoveryOffset + count) % pending.length : 0;
    for (let entry of batch) {
      if (signal.aborted) return;
      if (entry.state === 'printing' || entry.state === 'leased') {
        entry = { ...entry, state: 'attention', acknowledgement: { result: 'attention', errorCode: 'UNKNOWN_RESULT', errorMessage: 'Recovered unresolved job; operator review required' } };
        this.journal.put(entry);
      }
      if (entry.state === 'spooled') entry.acknowledgement = { result: 'spooled' };
      if (entry.acknowledgement) {
        try { await this.acknowledge(entry, signal); }
        catch (error) {
          if (error instanceof StorageError || error instanceof ConnectorRevokedError || signal.aborted) throw error;
          // One unresolved receipt must not prevent heartbeats and later claims.
          this.log('acknowledgement_pending', entry.jobId);
        }
      }
    }
  }
  private async acknowledge(entry: Receipt, signal: AbortSignal): Promise<void> {
    try {
      await this.client.request(apiPath(entry.connectorId, 'acknowledge', entry.jobId), { method: 'POST', body: JSON.stringify(entry.acknowledgement) }, signal);
      this.journal.put({ ...entry, acknowledged: true, reconciliationRequired: false, updatedAt: this.now().getTime() });
    } catch (error) {
      if (!(error instanceof PortalHttpError) || error.status !== 409) throw error;
      let raw: unknown;
      try { raw = await this.client.request(apiPath(entry.connectorId, 'state', entry.jobId), {}, signal); }
      catch (stateError) {
        if (!(stateError instanceof PortalHttpError) || ![404, 405].includes(stateError.status)) throw stateError;
      }
      const parsed = JobStateSchema.safeParse(raw);
      const state = parsed.success && parsed.data.id === entry.jobId ? parsed.data : undefined;
      const result = entry.acknowledgement?.result;
      const matches = state && (result === 'spooled' && state.status === 'spooled' ||
        result === 'attention' && state.status === 'attention' && state.errorCode === entry.acknowledgement?.errorCode ||
        result === 'error' && ['failed', 'retry_wait'].includes(String(state.status)) && state.errorCode === entry.acknowledgement?.errorCode);
      this.journal.put({ ...entry, acknowledged: !!matches, reconciliationRequired: !matches, updatedAt: this.now().getTime() });
      if (!matches) {
        this.status({ state: 'attention', message: 'Receipt conflicts with portal state; operator review required', lastError: `Review job ${entry.jobId}; its saved receipt still prevents reprinting` });
        this.log('acknowledgement_conflict', entry.jobId);
      }
    }
  }

  async process(raw: unknown, printerName: string, signal: AbortSignal, media?: { widthMm: number; heightMm: number } | null): Promise<void> {
    let job;
    try {
      job = parsePrintJobPayload(raw);
      if (job.connectorId !== this.client.identity.connectorId) throw new Error('Job belongs to another connector');
    } catch (error) {
      const id = typeof raw === 'object' && raw !== null && 'jobId' in raw ? raw.jobId : null;
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(id)) throw new Error('Invalid job identifier');
      // Never overwrite a previously submitted receipt, even if a replay is malformed.
      const existing = this.journal.find(this.client.identity.portalUrl, this.client.identity.connectorId, id);
      if (existing) { await this.replay(existing, signal); return; }
      const entry: Receipt = { portalUrl: this.client.identity.portalUrl, connectorId: this.client.identity.connectorId, jobId: id,
        state: 'rejected', updatedAt: this.now().getTime(), acknowledged: false,
        acknowledgement: { result: 'error', errorCode: error instanceof Error && error.message === 'INVALID_PAYLOAD_CHECKSUM' ? 'INVALID_PAYLOAD_CHECKSUM' : 'INVALID_PAYLOAD', errorMessage: 'Label payload is incompatible or damaged. Update the Connector and check the template before replacing this job.' } };
      this.journal.put(entry);
      this.status({ state: 'attention', message: 'Label rejected before printing', lastError: entry.acknowledgement?.errorMessage ?? 'Invalid label' });
      this.log('payload_rejected', id);
      await this.acknowledge(entry, signal); return;
    }
    const old = this.journal.find(this.client.identity.portalUrl, job.connectorId, job.jobId);
    if (old) { await this.replay(old, signal); return; }
    if (media && (Math.abs(media.widthMm - job.widthMm) >= 0.05 || Math.abs(media.heightMm - job.heightMm) >= 0.05)) {
      const rejected: Receipt = { portalUrl: this.client.identity.portalUrl, connectorId: job.connectorId, jobId: job.jobId,
        state: 'rejected', updatedAt: this.now().getTime(), acknowledged: false,
        acknowledgement: { result: 'error', errorCode: 'MEDIA_MISMATCH', errorMessage: 'This queued label uses another format. Replace it using the current printer format.' } };
      this.journal.put(rejected); await this.acknowledge(rejected, signal); this.log('media_mismatch', job.jobId); return;
    }
    let entry: Receipt = { portalUrl: this.client.identity.portalUrl, connectorId: job.connectorId, jobId: job.jobId,
      idempotencyKey: job.idempotencyKey, state: 'leased', updatedAt: this.now().getTime(), acknowledged: false };
    this.journal.put(entry);
    this.status({ state: 'printing', message: `Processing job ${job.jobId}`, lastJobAt: this.now().toISOString() });
    let renewalFailed = false;
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.client.request(apiPath(job.connectorId, 'renew', job.jobId), { method: 'POST' }, signal)
        .catch(() => { renewalFailed = true; this.log('lease_renewal_failed', job.jobId); })
        .finally(() => { renewing = false; });
    }, 30_000);
    try {
      await this.printer.print(job, printerName, async () => {
        if (signal.aborted || renewalFailed) throw new Error('Lease unavailable before print submission');
        await this.client.request(apiPath(job.connectorId, 'renew', job.jobId), { method: 'POST' }, signal);
        if (signal.aborted || renewalFailed) throw new Error('Lease unavailable before print submission');
        entry = { ...entry, state: 'printing', updatedAt: this.now().getTime() };
        this.journal.put(entry);
      });
      entry = { ...entry, state: 'spooled', acknowledgement: { result: 'spooled' }, updatedAt: this.now().getTime() };
      this.journal.put(entry);
      this.log('spooled', job.jobId);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      const messages: Record<string, string> = {
        PRINTER_NOT_SELECTED: 'Select a system printer in Connector Configuration, then replace this job.',
        PRINTER_NOT_FOUND: 'The selected printer is unavailable. Reconnect it or select another printer, then replace this job.',
        UNSUPPORTED_PAGE_SIZE: 'The printer driver rejected the label size. Configure matching stock or a compatible printer before replacing this job.',
        PRE_SUBMISSION_FAILED: 'Printing stopped before submission. Check the spooler and Connector connection, then replace this job.',
      };
      const safeCode = entry.state === 'leased' ? 'PRE_SUBMISSION_FAILED' : code;
      const submissionUncertain = typeof error === 'object' && error !== null && 'submissionUncertain' in error && error.submissionUncertain === true;
      const unsubmitted = safeCode in messages && !submissionUncertain;
      const uncertainMessage = code === 'UNSUPPORTED_PAGE_SIZE'
        ? 'The driver reported a paper-size or media failure after submission began. Check matching stock and physical output before confirming a replacement.'
        : code === 'PRINT_FAILED'
          ? 'The driver reported a print failure after submission began. Check the system queue and physical output before confirming a replacement.'
          : 'Print result is uncertain. Check physical output before confirming a replacement; no automatic reprint.';
      entry = { ...entry, state: unsubmitted ? 'rejected' : 'attention', acknowledgement: {
        result: unsubmitted ? 'error' : 'attention', errorCode: unsubmitted ? safeCode : 'UNKNOWN_RESULT',
        errorMessage: unsubmitted ? messages[safeCode]! : uncertainMessage,
      }, updatedAt: this.now().getTime() };
      this.journal.put(entry);
      this.status({ state: 'attention', message: unsubmitted ? 'Label was not submitted' : 'Print result needs operator review', lastError: entry.acknowledgement?.errorMessage ?? 'Print failed' });
      this.log(unsubmitted ? 'print_rejected' : 'print_attention', job.jobId);
    } finally { clearInterval(timer); }
    if (!signal.aborted) await this.acknowledge(entry, signal);
    if (entry.state === 'spooled') this.status({ state: 'online', message: 'Label accepted by system spooler; physical output is not confirmed' });
  }
  private async replay(entry: Receipt, signal: AbortSignal): Promise<void> {
    this.log('duplicate_claim_suppressed', entry.jobId);
    if (entry.reconciliationRequired) return;
    if (entry.acknowledgement) await this.acknowledge(entry, signal);
    else await this.recover(signal);
  }
}
