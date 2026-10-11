import { type FormEvent, useEffect, useState } from 'react';
import { LabelSizeSchema, type ActivityLogEntry, type EditableSettings } from '../../shared/contracts.ts';
import { VRETTI_420B_STOCK_PRESETS } from '../../shared/vretti-420b.ts';
import { ActivityLog, CalibrationInstructions, ConnectionStatus, PrinterStatus } from './components.tsx';
import { useConnectorStatus } from './useConnectorStatus.ts';

type FormState = EditableSettings & { pairingCode: string };
const emptyForm: FormState = { portalUrl: '', connectorName: '', printerName: '', selectedMedia: null, pairingCode: '' };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Unable to complete the operation.';

export function App() {
  const { status, loadError, refresh } = useConnectorStatus();
  const [form, setForm] = useState<FormState>(emptyForm);
  const [dirty, setDirty] = useState(false);
  const [formInitialized, setFormInitialized] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [logs, setLogs] = useState<ActivityLogEntry[] | null>(null);

  useEffect(() => {
    if (!status || (formInitialized && dirty)) return;
    setForm({ portalUrl: status.portalUrl, connectorName: status.connectorName, printerName: status.printerName, selectedMedia: status.selectedMedia, allowInsecureHttp: status.allowInsecureHttp, startAtLogin: status.startAtLogin, pairingCode: '' });
    setFormInitialized(true);
  }, [status, formInitialized, dirty]);

  const reloadLogs = async () => {
    try { setLogs(await window.sitremConnector.getLogs()); }
    catch { setLogs([]); }
  };
  useEffect(() => { void reloadLogs(); }, []);

  const update = (field: keyof FormState, value: string) => (setDirty(true), setForm((current) => ({ ...current, [field]: value })));

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
      setDirty(false);
      const next = await refresh();
      setForm({ portalUrl: next.portalUrl, connectorName: next.connectorName, printerName: next.printerName, selectedMedia: next.selectedMedia, allowInsecureHttp: next.allowInsecureHttp, startAtLogin: next.startAtLogin, pairingCode: '' });
      await reloadLogs();
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(false); }
  };

  const testPrint = async () => {
    setBusy(true); setError(''); setSuccess('');
    try {
      const size = LabelSizeSchema.safeParse(form.selectedMedia && { widthMm: form.selectedMedia.widthMm, heightMm: form.selectedMedia.heightMm });
      if (!size.success) throw new Error(size.error.issues[0]?.message ?? 'Select the loaded stock and save settings before printing a calibration label.');
      await window.sitremConnector.testPrint(size.data);
      setSuccess('Test label accepted by the system spooler. Check physical output and scan the barcode.');
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
  const selectedMedia = form.selectedMedia;
  const selectedTestPreset = selectedMedia && VRETTI_420B_STOCK_PRESETS.some((preset) => preset.id === selectedMedia.formatId && preset.widthMm === selectedMedia.widthMm && preset.heightMm === selectedMedia.heightMm)
    ? selectedMedia.formatId : selectedMedia ? 'custom' : '';
  const setMedia = (formatId: string, widthMm: number, heightMm: number) => (setDirty(true), setForm((current) => ({ ...current, selectedMedia: { formatId, widthMm, heightMm, catalogVersion: 1 } })));

  return (
    <main className="wrap">
      <h1>Printer Connector</h1>
      {status?.appVersion && <p className="hint">Version {status.appVersion}</p>}
      <p>Pair this computer with your portal and choose the system printer that receives labels.</p>
      <ConnectionStatus status={status} />
      {status?.mediaSync.message && <div className={status.mediaSync.state === 'synced' ? 'success' : 'error'} role="status">{status.mediaSync.message}</div>}
      {status?.mediaSync.state === 'conflict' && <div className="buttons">{(['portal', 'local'] as const).map(choice => <button key={choice} type="button" disabled={busy} onClick={async () => { setBusy(true); try { await window.sitremConnector.resolveMediaConflict?.(choice); setDirty(false); await refresh(); } catch (caught) { setError(errorMessage(caught)); } finally { setBusy(false); } }}>{choice === 'portal' ? 'Use portal format' : 'Keep local format'}</button>)}</div>}
      {!!status?.recoveryJobIds.length && <div role="alert" className="error">
        Saved print outcomes need review in the portal. Check physical output before replacing these jobs: {status.recoveryJobIds.join(', ')}.
      </div>}
      <form onSubmit={submit}>
        <label className="field" htmlFor="portalUrl">Portal URL</label>
        <input id="portalUrl" type="url" value={form.portalUrl} onChange={(event) => update('portalUrl', event.target.value)} placeholder="http://localhost:3000 or https://sitrem.example.com" required />
        <label><input type="checkbox" checked={form.allowInsecureHttp ?? false} onChange={(event) => { setDirty(true); setForm((value) => ({ ...value, allowInsecureHttp: event.target.checked })); }} /> Allow insecure HTTP on a trusted LAN (credentials are not protected in transit)</label>
        <label><input type="checkbox" checked={form.startAtLogin ?? false} onChange={(event) => { setDirty(true); setForm((value) => ({ ...value, startAtLogin: event.target.checked })); }} /> Start when I sign in</label>

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
        <fieldset>
          <legend>Calibration stock</legend>
          <label className="field" htmlFor="testPreset">Loaded label format</label>
          <select id="testPreset" value={selectedTestPreset} onChange={(event) => {
            const preset = VRETTI_420B_STOCK_PRESETS.find((candidate) => candidate.id === event.target.value);
            if (preset) setMedia(preset.id, preset.widthMm, preset.heightMm);
          }}>
            <option value="">Select loaded stock</option>
            {VRETTI_420B_STOCK_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}
            <option value="custom">Custom dimensions below</option>
          </select>
          <label className="field" htmlFor="testWidth">Stock width (mm)</label>
          <input id="testWidth" type="number" min="25.4" max="108" step="0.1" value={selectedMedia?.widthMm ?? ''} onChange={(event) => setMedia('custom', Number(event.target.value), selectedMedia?.heightMm ?? 25)} />
          <label className="field" htmlFor="testHeight">Feed length (mm)</label>
          <input id="testHeight" type="number" min="10" max="1778" step="0.1" value={selectedMedia?.heightMm ?? ''} onChange={(event) => setMedia('custom', selectedMedia?.widthMm ?? 25.4, Number(event.target.value))} />
          <p className="hint">Save after selecting the loaded stock. The Connector then keeps it locally and synchronizes it to a compatible Board portal.</p>
          <button className="secondary" type="button" disabled={busy || !selectedMedia} onClick={() => { void testPrint(); }}>Print {selectedMedia ? `${selectedMedia.widthMm} × ${selectedMedia.heightMm}` : ''} mm test grid</button>
        </fieldset>
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
