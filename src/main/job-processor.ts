import { parsePrintJobPayload } from '../shared/label.ts';
import type { ConnectorRuntime } from '../shared/contracts.ts';
import { apiPath, PortalClient } from './portal-client.ts';
import { JournalStore, StorageError, type Receipt } from './storage.ts';
import { PrintCoordinator } from './print-engine.ts';

export class JobProcessor {
  constructor(private readonly client: PortalClient, private readonly journal: JournalStore, private readonly printer: PrintCoordinator,
    private readonly now: () => Date, private readonly status: (update: Partial<ConnectorRuntime>) => void,
    private readonly log: (event: string, detail?: string) => void) {}
  private belongs(entry: Receipt): boolean {
    return entry.portalUrl === this.client.identity.portalUrl && entry.connectorId === this.client.identity.connectorId;
  }
  async recover(signal: AbortSignal): Promise<void> {
    for (let entry of this.journal.all().filter((r) => this.belongs(r) && !r.acknowledged)) {
      if (signal.aborted) return;
      if (entry.state === 'printing' || entry.state === 'leased') {
        entry = { ...entry, state: 'attention', acknowledgement: { result: 'attention', errorCode: 'UNKNOWN_RESULT', errorMessage: 'Recovered unresolved job; operator review required' } };
        this.journal.put(entry);
      }
      if (entry.state === 'spooled') entry.acknowledgement = { result: 'spooled' };
      if (entry.acknowledgement) await this.acknowledge(entry, signal);
    }
  }
  private async acknowledge(entry: Receipt, signal: AbortSignal): Promise<void> {
    await this.client.request(apiPath(entry.connectorId, 'acknowledge', entry.jobId), { method: 'POST', body: JSON.stringify(entry.acknowledgement) }, signal);
    this.journal.put({ ...entry, acknowledged: true, updatedAt: this.now().getTime() });
  }
  async process(raw: unknown, printerName: string, signal: AbortSignal): Promise<void> {
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
        acknowledgement: { result: 'error', errorCode: error instanceof Error && error.message === 'INVALID_PAYLOAD_CHECKSUM' ? 'INVALID_PAYLOAD_CHECKSUM' : 'INVALID_PAYLOAD', errorMessage: 'Job failed validation' } };
      this.journal.put(entry); await this.acknowledge(entry, signal); return;
    }
    const old = this.journal.find(this.client.identity.portalUrl, job.connectorId, job.jobId);
    if (old) { await this.replay(old, signal); return; }
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
      entry = { ...entry, state: 'attention', acknowledgement: { result: 'attention', errorCode: 'UNKNOWN_RESULT', errorMessage: 'Print operation needs operator review; no automatic reprint' } };
      this.journal.put(entry);
      this.status({ state: 'attention', message: 'Print result needs operator review', lastError: 'Review the job in the portal before issuing a replacement' });
      this.log('print_attention', job.jobId);
    } finally { clearInterval(timer); }
    if (!signal.aborted) await this.acknowledge(entry, signal);
    if (entry.state === 'spooled') this.status({ state: 'online', message: 'Label accepted by system spooler; physical output is not confirmed' });
  }
  private async replay(entry: Receipt, signal: AbortSignal): Promise<void> {
    this.log('duplicate_claim_suppressed', entry.jobId);
    if (entry.acknowledgement) await this.acknowledge(entry, signal);
    else await this.recover(signal);
  }
}
