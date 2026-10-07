import { z } from 'zod';

export const OrientationSchema = z.enum(['portrait', 'landscape']);
export type Orientation = z.infer<typeof OrientationSchema>;

const tenthMillimetre = (value: number) => Number.isFinite(value) && Math.abs(Math.round(value * 10) - value * 10) < 1e-8;
export const WidthMmSchema = z.number().refine((value) => tenthMillimetre(value) && value >= 25.4 && value <= 108, 'widthMm must be between 25.4 and 108 mm in 0.1 mm steps');
export const HeightMmSchema = z.number().refine((value) => tenthMillimetre(value) && value >= 10 && value <= 1778, 'heightMm must be between 10 and 1778 mm in 0.1 mm steps');

export const LabelSizeSchema = z.object({ widthMm: WidthMmSchema, heightMm: HeightMmSchema }).strict();
export type LabelSize = z.infer<typeof LabelSizeSchema>;

export const PrintJobPayloadV1Schema = z.object({
  schemaVersion: z.literal(1),
  jobId: z.string().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/),
  connectorId: z.string().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/),
  idempotencyKey: z.string().min(1).max(512),
  html: z.string().min(1).max(1_000_000),
  widthMm: WidthMmSchema,
  heightMm: HeightMmSchema,
  orientation: OrientationSchema,
  copies: z.number().int().min(1).max(100),
  contentChecksum: z.string().regex(/^[a-f0-9]{64}$/i),
}).strict();
export type PrintJobPayloadV1 = z.infer<typeof PrintJobPayloadV1Schema>;
