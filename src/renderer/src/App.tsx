import { type FormEvent, useEffect, useState } from 'react';
import type { ActivityLogEntry, EditableSettings } from '../../shared/contracts.ts';
import { ActivityLog, CalibrationInstructions, ConnectionStatus, PrinterStatus } from './components.tsx';
import { useConnectorStatus } from './useConnectorStatus.ts';

type FormState = EditableSettings & { pairingCode: string };
const emptyForm: FormState = { portalUrl: '', connectorName: '', printerName: '', pairingCode: '' };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Unable to complete the operation.';

export function App() {
  const { status, loadError, refresh } = useConnectorStatus();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [formInitialized, setFormInitialized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [logs, setLogs] = useState<ActivityLogEntry[] | null>(null);

  useEffect(() => {
    if (!status || formInitialized) return;
    setForm({ portalUrl: status.portalUrl, connectorName: status.connectorName, printerName: status.printerName, allowInsecureHttp: status.allowInsecureHttp, startAtLogin: status.startAtLogin, pairingCode: '' });
    setFormInitialized(true);
  }, [status, formInitialized]);

  const reloadLogs = async () => {
    try { setLogs(await window.sitremConnector.getLogs()); }
    catch { setLogs([]); }
  };
  useEffect(() => { void reloadLogs(); }, []);

  const update = (field: keyof FormState, value: string) => setForm((current) => ({ ...current, [field]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(''); setSuccess('');
    try {
      if (form.pairingCode.trim()) {
        const result = await window.sitremConnector.pair(form);
        setSuccess(`Paired as ${result.connectorId}.`);
        setForm((current) => ({ ...current, pairingCode: '' }));
      } else {
        if (!status?.paired) throw new Error('Enter the one-time pairing code.');
        await window.sitremConnector.saveSettings(form);
        setSuccess('Settings saved.');
      }
      const next = await refresh();
      setForm({ portalUrl: next.portalUrl, connectorName: next.connectorName, printerName: next.printerName, allowInsecureHttp: next.allowInsecureHttp, startAtLogin: next.startAtLogin, pairingCode: '' });
      await reloadLogs();
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  };

  const testPrint = async () => {
    setBusy(true); setError(''); setSuccess('');
    try {
      await window.sitremConnector.testPrint({ widthMm: 50, heightMm: 30 });
      setSuccess('Test label sent to the system print queue.');
      await reloadLogs();
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  };

  const openPrinterSettings = async () => {
    setError('');
    try { await window.sitremConnector.openPrinterSettings(); }
    catch (caught) { setError(errorMessage(caught)); }
  };

  const printers = status?.printers ?? [];
  const printerOptions = form.printerName && !printers.includes(form.printerName) ? [form.printerName, ...printers] : printers;

  return (
    <main className="wrap">
      <h1>Printer Connector</h1>
      <p>Pair this computer with your portal and choose the system printer that receives labels.</p>
      <ConnectionStatus status={status} />
      <form onSubmit={submit}>
        <label className="field" htmlFor="portalUrl">Portal URL</label>
        <input id="portalUrl" type="url" value={form.portalUrl} onChange={(event) => update('portalUrl', event.target.value)} placeholder="http://localhost:3000 or https://sitrem.example.com" required />
        <label><input type="checkbox" checked={form.allowInsecureHttp ?? false} onChange={(event) => setForm((value) => ({ ...value, allowInsecureHttp: event.target.checked }))} /> Allow insecure HTTP on a trusted LAN (credentials are not protected in transit)</label>
        <label><input type="checkbox" checked={form.startAtLogin ?? false} onChange={(event) => setForm((value) => ({ ...value, startAtLogin: event.target.checked }))} /> Start when I sign in</label>

        <label className="field" htmlFor="connectorName">Connector name</label>
        <input id="connectorName" value={form.connectorName} onChange={(event) => update('connectorName', event.target.value)} placeholder="Reception Vretti 420B" required />

        <label className="field" htmlFor="printerName">System printer</label>
        <select id="printerName" value={form.printerName} onChange={(event) => update('printerName', event.target.value)} required disabled={!printerOptions.length}>
          {!printerOptions.length && <option value="">No system printers detected</option>}
          {printerOptions.map((printer) => <option key={printer} value={printer}>{printer}</option>)}
        </select>
        <PrinterStatus status={status} />
        <button className="secondary" type="button" onClick={() => { void openPrinterSettings(); }}>Open system printer settings</button>

        <label className="field" htmlFor="pairingCode">Pairing code</label>
        <input id="pairingCode" value={form.pairingCode} onChange={(event) => update('pairingCode', event.target.value)} autoComplete="off" placeholder="Enter for first pairing or to pair again" />
        <p className="hint">The pairing code is used once and is never stored. Leave it blank after pairing to save portal and printer settings.</p>

        <button id="submit" type="submit" disabled={busy || !formInitialized}>{status?.paired ? 'Save settings' : 'Connect'}</button>
        <button className="secondary" type="button" disabled={busy} onClick={() => { void testPrint(); }}>Print 50 × 30 mm test grid</button>
        <div className="success" aria-live="polite">{success}</div>
        <div className="error" role="alert">{error || loadError}</div>
      </form>
      <CalibrationInstructions />
      <ActivityLog entries={logs} />
      <button className="secondary" onClick={() => { void window.sitremConnector.diagnostics?.().then((text) => {
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = 'sitrem-diagnostics.json'; link.click(); URL.revokeObjectURL(url);
      }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Unable to export diagnostics')); }}>Export recovery and diagnostics</button>
    </main>
  );
}
