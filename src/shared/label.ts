import { createHash, randomUUID } from 'node:crypto';
import { LabelSizeSchema, PrintJobPayloadV1Schema, type PrintJobPayloadV1 } from './label-schema.ts';
import { validateStructuredLabel } from './label-security.ts';

export * from './label-schema.ts';

export const LABEL_PRESETS = [
  { name: 'Компактная', widthMm: 40, heightMm: 30 },
  { name: 'Узкая', widthMm: 50, heightMm: 25 },
  { name: 'Стандарт Sitrem', widthMm: 50, heightMm: 30, default: true },
  { name: 'Товарная', widthMm: 58, heightMm: 40 },
  { name: 'Товарная большая', widthMm: 60, heightMm: 40 },
  { name: 'Складская', widthMm: 70, heightMm: 50 },
  { name: 'Складская широкая', widthMm: 80, heightMm: 50 },
  { name: 'Адресная', widthMm: 100, heightMm: 50 },
  { name: 'Квадратная', widthMm: 100, heightMm: 100 },
  { name: 'A6', widthMm: 105, heightMm: 148 },
  { name: 'Транспортная', widthMm: 100, heightMm: 150 },
  { name: 'Shipping 4 × 6 in', widthMm: 101.6, heightMm: 152.4 },
] as const;

export function validatePhysicalSize(widthMm: number, heightMm: number): void {
  LabelSizeSchema.parse({ widthMm, heightMm });
}

export function checksumFor({ html }: Pick<PrintJobPayloadV1, 'html'>): string {
  return createHash('sha256').update(html).digest('hex');
}

/** Reject executable, navigable, submitted, and remotely loaded markup. */
export function validateLabelHtml(html: string): void {
  validateStructuredLabel(html);
}

export function parsePrintJobPayload(value: unknown): PrintJobPayloadV1 {
  const payload = PrintJobPayloadV1Schema.parse(value);
  validateLabelHtml(payload.html);
  if (checksumFor(payload) !== payload.contentChecksum.toLowerCase()) throw new Error('INVALID_PAYLOAD_CHECKSUM');
  return payload;
}

export function createPayload(input: Omit<PrintJobPayloadV1, 'schemaVersion' | 'jobId' | 'contentChecksum'> & { jobId?: string }): PrintJobPayloadV1 {
  const common = {
    connectorId: input.connectorId,
    idempotencyKey: input.idempotencyKey,
    html: input.html,
    widthMm: input.widthMm,
    heightMm: input.heightMm,
    orientation: input.orientation,
    copies: input.copies,
  };
  return parsePrintJobPayload({ schemaVersion: 1, jobId: input.jobId ?? randomUUID(), ...common, contentChecksum: checksumFor(common) });
}

export function isVrettiDriver(name: string): boolean {
  return /VRETTI|420B|4BARCODE|4B-2054M/i.test(name);
}
