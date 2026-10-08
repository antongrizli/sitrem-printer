import type { ActivityLogEntry, ConnectorStatus } from '../../shared/contracts.ts';

export function ConnectionStatus({ status }: { status: ConnectorStatus | null }) {
  if (!status) return <div className="status">Loading…</div>;
  const heartbeat = status.lastHeartbeatAt ? new Date(status.lastHeartbeatAt).toLocaleString() : 'never';
  return (
    <div className={`status ${status.state}`} role="status">
      <strong>{status.message}</strong>
      <div className="details">Portal: {status.state} · Last successful heartbeat: {heartbeat}{status.lastError ? ` · Error: ${status.lastError}` : ''}</div>
    </div>
  );
}

export function PrinterStatus({ status }: { status: ConnectorStatus | null }) {
  if (status?.printerError) return <div className="details warning">⚠ {status.printerError}</div>;
  if (!status?.printerName) return <div className="details warning">⚠ No system printer selected.</div>;
  if (!status.printerAvailable) return <div className="details warning">⚠ Selected printer is not currently available to Electron.</div>;
  const likelyLabelPrinter = /label|thermal|vretti|420b|4barcode|zebra|dymo|brother.*(?:ql|td)|munbyn|rollo|phomemo/i.test(status.printerName);
  return <>
    <div className="details success-text">✓ Selected printer is currently available to Electron.</div>
    {!likelyLabelPrinter && <div className="details warning">⚠ This appears to be a general-purpose printer. A queued job only confirms spool acceptance; print a test grid matching your stock and verify every edge and barcode before production use.</div>}
  </>;
}

export function CalibrationInstructions() {
  return (
    <details>
      <summary>Calibration instructions</summary>
      <ol>
        <li>Set media guides to the label width.</li>
        <li>Calibrate the label printer after replacing a roll.</li>
        <li>Match the driver media size to the selected label size.</li>
        <li>Enter the loaded stock dimensions and print the test grid. All four border edges must be visible; if one is clipped, correct the driver media or scaling before sending tickets.</li>
        <li>Scan the test grid’s Code 128 barcode, then scan a printed ticket label and confirm it opens that exact ticket.</li>
      </ol>
    </details>
  );
}

export function ActivityLog({ entries }: { entries: ActivityLogEntry[] | null }) {
  const text = entries === null ? 'Loading…' : entries.length ? entries.map((entry) => `${entry.at}  ${entry.event}  ${entry.detail}`).join('\n') : 'No activity yet.';
  return <details><summary>Recent activity</summary><pre>{text}</pre></details>;
}
