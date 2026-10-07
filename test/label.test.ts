import { describe, expect, it } from 'vitest';
import { createPayload, isVrettiDriver, parsePrintJobPayload, validateLabelHtml, validatePhysicalSize } from '../src/shared/label.ts';

const html = '<!doctype html><style>@page { size: 50mm 30mm; margin: 0 } html,body{width:50mm;height:30mm;margin:0}</style><svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

describe('label payload validation', () => {
  it('creates a 50 × 30 payload with a valid checksum', () => {
    const payload = createPayload({ connectorId: 'connector-1', idempotencyKey: 'order-1', html, widthMm: 50, heightMm: 30, orientation: 'portrait', copies: 1 });
    expect(payload.schemaVersion).toBe(1);
    expect(payload.widthMm * 1000).toBe(50_000);
    expect(payload.contentChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(parsePrintJobPayload(payload)).toEqual(payload);
  });

  it('rejects invalid physical bounds and unsafe markup', () => {
    expect(() => validatePhysicalSize(108.1, 30)).toThrow(/widthMm/);
    expect(() => validatePhysicalSize(50, 9.9)).toThrow(/heightMm/);
    for (const unsafe of [
      '<img src="https://example.test/label.png">',
      '<script>alert(1)</script>',
      '<form action="/submit"></form>',
      '<svg onload="alert(1)"/>',
      '<style>@import "https://example.test/font.css"</style>',
      '<style>.x{background:url(data:image/png;base64,AAAA)}</style>',
      '<svg><foreignObject><iframe src="data:text/html,unsafe"></iframe></foreignObject></svg>',
      '<img src="data:image/svg+xml;base64,AAAA">',
      '<div style="background:u\\72l(https://example.test)">x</div>',
      '<svg><use href="https://example.test/x#label"/></svg>',
    ]) expect(() => validateLabelHtml(unsafe)).toThrow(/self-contained/);
  });

  it('rejects a changed checksum and malformed payload', () => {
    const payload = createPayload({ connectorId: 'c', idempotencyKey: 'i', html, widthMm: 50, heightMm: 30, orientation: 'portrait', copies: 1 });
    expect(() => parsePrintJobPayload({ ...payload, html: `${payload.html} ` })).toThrow('INVALID_PAYLOAD_CHECKSUM');
    expect(() => parsePrintJobPayload({ ...payload, schemaVersion: 2 })).toThrow();
  });

  it('recognizes Vretti driver aliases without rejecting manual choices', () => {
    for (const name of ['VRETTI 420B', '4BARCODE label printer', '4B-2054M']) expect(isVrettiDriver(name)).toBe(true);
    expect(isVrettiDriver('Office LaserJet')).toBe(false);
  });
});
