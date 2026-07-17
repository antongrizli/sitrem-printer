# PrinterSitrem ↔ SITREM portal integration

This document is the implementation contract for the PrinterSitrem desktop Connector. The Connector never accepts inbound connections. It uses outbound HTTP or HTTPS requests to the SITREM portal and sends self-contained HTML label jobs to a selected system printer. HTTP is intended only for trusted local networks; use HTTPS across untrusted networks.

## Pairing

1. An administrator opens **Board configuration → Printing** in SITREM and selects **Create pairing code**.
2. In PrinterSitrem, ask for the portal base URL and the one-time pairing code.
3. Call the pairing endpoint. The returned bearer token is shown exactly once; save it in Windows Credential Manager or macOS Keychain.

```http
POST {portalBaseUrl}/api/print/connectors/pair
Content-Type: application/json

{ "code": "one-time-code", "name": "Reception Vretti 420B" }
```

Successful response:

```json
{
  "connectorId": "uuid",
  "token": "store-this-once-only"
}
```

Pairing codes expire after 10 minutes and cannot be reused. Do not put the token in a URL, log, crash report, or renderer-process storage.

## Authentication and connection state

Every request after pairing uses:

```http
Authorization: Bearer {token}
```

Send a heartbeat at startup and at least every 30 seconds. SITREM shows **connected** when the last heartbeat is at most 90 seconds old; otherwise it shows **stale**. A revoked Connector receives `401` and must stop polling until paired again.

```http
POST {portalBaseUrl}/api/print/connectors/{connectorId}/heartbeat
Authorization: Bearer {token}
Content-Type: application/json

{
  "version": "1.0.0",
  "os": "macOS 15.0",
  "deviceName": "Vretti 420B"
}
```

`deviceName` must be the exact system printer name used by Electron `webContents.print()`.

## Reading and completing jobs

Poll this route continuously (a short backoff after `204` is recommended):

```http
GET {portalBaseUrl}/api/print/connectors/{connectorId}/claim
Authorization: Bearer {token}
```

`204 No Content` means no work. `200 OK` returns one leased job:

```ts
type PrintJobPayloadV1 = {
  schemaVersion: 1;
  jobId: string;
  connectorId: string;
  idempotencyKey: string;
  html: string; // self-contained HTML, inline CSS and SVG only
  widthMm: number;
  heightMm: number;
  orientation: 'portrait' | 'landscape';
  copies: number;
  contentChecksum: string; // SHA-256 of html
};
```

Before printing, calculate SHA-256 of `html` and reject/report the job if it differs from `contentChecksum`. Load only this HTML into a hidden, sandboxed Electron print window; do not navigate it or permit remote resources. Print with the claimed payload dimensions exactly:

```ts
await printWindow.webContents.print({
  silent: true,
  deviceName: selectedDeviceName,
  printBackground: true,
  scaleFactor: 100,
  margins: { marginType: 'none' },
  pageSize: { width: widthMm * 1000, height: heightMm * 1000 },
  copies,
});
```

Do not scale a rejected driver medium. Return an `UNSUPPORTED_PAGE_SIZE` error instead.

Renew a job lease every 60 seconds while it is being prepared or printed:

```http
POST {portalBaseUrl}/api/print/connectors/{connectorId}/jobs/{jobId}/renew
Authorization: Bearer {token}
```

After the operating-system spooler accepts a job, acknowledge it. This means **sent to system print queue**, not physically printed.

```http
POST {portalBaseUrl}/api/print/connectors/{connectorId}/jobs/{jobId}/acknowledge
Authorization: Bearer {token}
Content-Type: application/json

{ "result": "spooled" }
```

For a retryable failure:

```json
{ "result": "error", "errorCode": "UNSUPPORTED_PAGE_SIZE", "errorMessage": "Driver does not accept 50 x 30 mm" }
```

For an uncertain result (for example, the process restarted after starting the OS print operation), never retry automatically:

```json
{ "result": "attention", "errorCode": "UNKNOWN_RESULT", "errorMessage": "Print outcome could not be determined after restart" }
```

## Required local durability and security

- Persist a local journal: `leased → printing → spooled → acknowledged`.
- After restart, re-acknowledge a locally recorded `spooled` job without printing it again.
- Report a locally recorded `printing` job as `attention`; the portal requires an administrator to explicitly retry it.
- Set Electron `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false`. Block navigation and arbitrary network loading in the print renderer.
- Use HTTPS whenever Connector traffic crosses an untrusted network. Direct HTTP is supported for trusted local-network deployments. The portal's Connector token is not a browser session and must be treated as a machine credential.
- The initial target is the Vretti 420B via its installed Windows/macOS driver. Allow manual selection of a printer name; driver-name detection may recognize `VRETTI`, `420B`, `4BARCODE`, and `4B-2054M`.
