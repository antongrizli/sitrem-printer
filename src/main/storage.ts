import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export class StorageError extends Error {}

export function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new StorageError(`Cannot read ${path}. Preserve this file and restore a verified backup before resuming.`);
  }
}

/** One synchronous owner: flush before replacement, never reset unreadable state. */
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    if (existsSync(path)) {
      const previous = readJson(path);
      writeAtomic(`${path}.bak`, JSON.stringify(previous));
    }
    writeAtomic(path, JSON.stringify(value), temporary);
  } catch (error) {
    throw new StorageError(`Cannot persist ${path}: ${error instanceof Error ? error.message : 'storage failure'}`);
  }
}

function writeAtomic(path: string, text: string, temporary = `${path}.${randomUUID()}.tmp`): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, text);
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, path);
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(path), 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export const ReceiptSchema = z.object({
  portalUrl: z.string(), connectorId: z.string(), jobId: z.string(),
  idempotencyKey: z.string().optional(),
  state: z.enum(['leased', 'printing', 'spooled', 'attention', 'rejected']),
  updatedAt: z.number(),
  acknowledgement: z.record(z.string(), z.string()).optional(),
  acknowledged: z.boolean().default(false),
  reconciliationRequired: z.boolean().optional(),
}).strict();
export type Receipt = z.infer<typeof ReceiptSchema>;
const JournalDocument = z.object({ schemaVersion: z.literal(2), entries: z.array(ReceiptSchema) }).strict();
const PreviousJournalDocument = z.object({ schemaVersion: z.literal(1), entries: z.array(ReceiptSchema) }).strict();
const LegacyJournal = z.record(z.string(), z.object({ state: z.enum(['leased', 'printing', 'spooled']), updatedAt: z.number() }).strict());

export class JournalStore {
  private entries: Receipt[];
  constructor(private readonly path: string, identity: { portalUrl: string; connectorId: string }) {
    const raw = readJson(path);
    if (raw === undefined) { this.entries = []; return; }
    const current = JournalDocument.safeParse(raw);
    if (current.success) { this.entries = current.data.entries; return; }
    const previous = PreviousJournalDocument.safeParse(raw);
    if (previous.success) {
      // Keep the pre-migration snapshot even after rolling .bak files advance.
      const migrationBackup = `${path}.v1.bak`;
      if (!existsSync(migrationBackup)) writeJson(migrationBackup, raw);
      this.entries = previous.data.entries; this.flush(); return;
    }
    const legacy = LegacyJournal.safeParse(raw);
    if (!legacy.success) throw new StorageError('Print journal schema is invalid or newer than this app. Printing is blocked; preserve the journal for recovery.');
    this.entries = Object.entries(legacy.data).map(([jobId, entry]) => ({ ...identity, jobId, ...entry, acknowledged: false }));
    this.flush();
  }
  all(): Receipt[] { return structuredClone(this.entries); }
  find(portalUrl: string, connectorId: string, jobId: string): Receipt | undefined {
    return this.all().find((entry) => entry.portalUrl === portalUrl && entry.connectorId === connectorId && entry.jobId === jobId);
  }
  put(entry: Receipt): void {
    const parsed = ReceiptSchema.parse(entry);
    const index = this.entries.findIndex((item) => item.portalUrl === entry.portalUrl && item.connectorId === entry.connectorId && item.jobId === entry.jobId);
    const next = this.all();
    if (index < 0) {
      // Until the portal replay window is documented, receipts must not expire.
      if (next.length >= 10_000) throw new StorageError('Receipt capacity reached. Printing paused; arrange verified receipt archival with the portal operator.');
      next.push(parsed);
    } else next[index] = parsed;
    writeJson(this.path, { schemaVersion: 2, entries: next });
    this.entries = next;
  }
  private flush(): void { writeJson(this.path, { schemaVersion: 2, entries: this.entries }); }
}
