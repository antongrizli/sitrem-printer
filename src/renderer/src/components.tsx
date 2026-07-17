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
  return status.printerAvailable
    ? <div className="details success-text">✓ Selected printer is currently available to Electron.</div>
    : <div className="details warning">⚠ Selected printer is not currently available to Electron.</div>;
}

export function CalibrationInstructions() {
  return (
    <details>
      <summary>Calibration instructions</summary>
      <ol>
        <li>Set media guides to the label width.</li>
        <li>Calibrate the Vretti after replacing a roll.</li>
        <li>Match the driver media size to the selected label size.</li>
        <li>Print the test grid and scan its Code 128 barcode.</li>
      </ol>
    </details>
  );
}

export function ActivityLog({ entries }: { entries: ActivityLogEntry[] | null }) {
  const text = entries === null ? 'Loading…' : entries.length ? entries.map((entry) => `${entry.at}  ${entry.event}  ${entry.detail}`).join('\n') : 'No activity yet.';
  return <details><summary>Recent activity</summary><pre>{text}</pre></details>;
}
