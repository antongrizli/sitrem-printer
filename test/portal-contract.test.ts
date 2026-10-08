import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePrintJobPayload, validateLabelHtml } from '../src/shared/label.ts';
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/portal-labels.json', import.meta.url), 'utf8')) as unknown[];

describe('portal-generated label contract', () => {
  it.each(fixtures)('accepts exact immutable portal label %#', candidate => {
    const payload = parsePrintJobPayload(candidate);
    expect(payload.contentChecksum).toBe(createHash('sha256').update(payload.html).digest('hex'));
    expect(payload.copies).toBe(2);
  });
  it('supports existing immutable portal snapshots from before the compatibility fix', () => {
    validateLabelHtml('<meta charset="utf-8"><style>.metadata{grid-template-columns:repeat(2,minmax(0,1fr));text-overflow:ellipsis}</style><section data-layout-fit="true"><div data-barcode-value="SIT-C-000001"></div></section>');
  });
  it.each([
    '<meta http-equiv="refresh" content="0;url=https://example.test">',
    '<meta charset="utf-8" http-equiv="refresh">', '<meta charset="utf-16">',
    '<div data-arbitrary="anything"></div>', '<section data-layout-fit="script"></section>',
    '<style>.x{grid-template-columns:repeat(2,minmax(0,url(https://example.test)))}</style>',
    '<div onclick="alert(1)" data-barcode-value="safe"></div>',
  ])('continues rejecting unsafe or unsupported markup: %s', html => {
    expect(() => validateLabelHtml(html)).toThrow();
  });
});
