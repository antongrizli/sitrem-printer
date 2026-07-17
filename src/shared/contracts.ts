import { z } from 'zod';
import { LabelSizeSchema } from './label-schema.ts';
export { IPC_CHANNELS } from './ipc.ts';

const HttpPortalUrlSchema = z.string().trim().min(1).transform((value, context) => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
    return url.toString().replace(/\/$/, '');
  } catch {
    context.addIssue({ code: 'custom', message: 'The portal URL must be a valid HTTP or HTTPS URL' });
    return z.NEVER;
  }
});

export const EditableSettingsSchema = z.object({
  portalUrl: HttpPortalUrlSchema,
  printerName: z.string().trim().max(255),
  connectorName: z.string().trim().min(1).max(255),
});
export type EditableSettings = z.infer<typeof EditableSettingsSchema>;

export const PairingInputSchema = EditableSettingsSchema.extend({ pairingCode: z.string().trim().min(1).max(512) }).strict();
export type PairingInput = z.infer<typeof PairingInputSchema>;
export const PairingResultSchema = z.object({ connectorId: z.string().min(1) }).strict();
export type PairingResult = z.infer<typeof PairingResultSchema>;

export const ConnectorRuntimeStateSchema = z.enum(['not_paired', 'starting', 'connecting', 'online', 'printing', 'offline', 'revoked', 'error']);
export type ConnectorRuntimeState = z.infer<typeof ConnectorRuntimeStateSchema>;

export const ConnectorRuntimeSchema = z.object({
  state: ConnectorRuntimeStateSchema,
  message: z.string(),
  lastHeartbeatAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  lastJobAt: z.string().datetime().nullable(),
}).strict();
export type ConnectorRuntime = z.infer<typeof ConnectorRuntimeSchema>;

export const ConnectorStatusSchema = EditableSettingsSchema.extend({
  paired: z.boolean(),
  printers: z.array(z.string()),
  printerAvailable: z.boolean(),
  printerError: z.string().nullable(),
  state: ConnectorRuntimeStateSchema,
  message: z.string(),
  lastHeartbeatAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  lastJobAt: z.string().datetime().nullable(),
}).strict();
export type ConnectorStatus = z.infer<typeof ConnectorStatusSchema>;

export const ActivityLogEntrySchema = z.object({ at: z.string().datetime(), event: z.string(), detail: z.string() }).strict();
export type ActivityLogEntry = z.infer<typeof ActivityLogEntrySchema>;

export const JournalEntrySchema = z.object({ state: z.enum(['leased', 'printing', 'spooled']), updatedAt: z.number().int().nonnegative() }).strict();
export const JournalSchema = z.record(z.string(), JournalEntrySchema);
export type Journal = z.infer<typeof JournalSchema>;

export interface ConnectorApi {
  getStatus(): Promise<ConnectorStatus>;
  pair(input: PairingInput): Promise<PairingResult>;
  saveSettings(input: EditableSettings): Promise<void>;
  testPrint(size: z.infer<typeof LabelSizeSchema>): Promise<void>;
  getLogs(): Promise<ActivityLogEntry[]>;
  openPrinterSettings(): Promise<void>;
}

export { LabelSizeSchema };
export type { LabelSize } from './label-schema.ts';
