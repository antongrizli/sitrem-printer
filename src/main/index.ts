import { app, BrowserWindow, ipcMain, Menu, nativeImage, safeStorage, shell, Tray, powerMonitor, type IpcMainInvokeEvent } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { resolve, relative } from 'node:path';
import offlineIconPath from '../assets/sitrem-icon-tray-offline.png?asset';
import onlineIconPath from '../assets/sitrem-icon-tray-online.png?asset';
import { ConnectorService } from './connector-service.ts';
import { ElectronPrintEngine } from './print-engine.ts';
import { IPC_CHANNELS } from '../shared/ipc.ts';
import { validateSettingsSender } from './ipc-security.ts';
import type { EditableSettings, LabelSize, PairingInput } from '../shared/contracts.ts';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
let printWindow: BrowserWindow | undefined;
let settingsWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let trayTimer: NodeJS.Timeout | undefined;
let service: ConnectorService | undefined;
let trayIcons: { online: Electron.NativeImage; offline: Electron.NativeImage } | undefined;
let quitting = false;
let traySnapshot = '';
let settingsUrl: string | undefined;

app.setName('SitremPrinter');
const smoke = process.argv.includes('--sitrem-smoke');
if (smoke) {
  const path = process.env.SITREM_SMOKE_DATA;
  if (!path || relative(resolve(tmpdir()), resolve(path)).startsWith('..') || resolve(path) === resolve(tmpdir())) throw new Error('Smoke test requires an isolated temporary user data directory');
  app.setPath('userData', path);
}
const hasSingleInstanceLock = app.requestSingleInstanceLock();

function focusSettingsIfOpen(): void {
  if (!settingsWindow || settingsWindow.isDestroyed()) return;
  if (settingsWindow.isMinimized()) settingsWindow.restore();
  settingsWindow.show();
  settingsWindow.focus();
}

async function showSettings(): Promise<void> {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    focusSettingsIfOpen();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 560,
    height: 560,
    resizable: true,
    minWidth: 480,
    minHeight: 480,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(currentDirectory, '../preload/index.cjs'),
    },
  });
  settingsWindow.removeMenu();
  if (smoke) settingsWindow.webContents.on('console-message', (_event, _level, message) => console.log(`Settings renderer: ${message}`));
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  settingsWindow.on('closed', () => { settingsWindow = undefined; });
  settingsWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const developmentUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
  settingsUrl = developmentUrl ? new URL(developmentUrl).href : pathToFileURL(join(currentDirectory, '../renderer/index.html')).href;
  if (developmentUrl) await settingsWindow.loadURL(developmentUrl);
  else await settingsWindow.loadFile(join(currentDirectory, '../renderer/index.html'));
}

function createTrayIcon(path: string): Electron.NativeImage {
  const icon = nativeImage.createFromPath(path).resize({ width: 18, height: 18 });
  if (icon.isEmpty()) throw new Error(`Tray icon is empty: ${path}`);
  return icon;
}

function updateTray(): void {
  if (!tray || !trayIcons || !service) return;
  const status = service.getTraySnapshot();
  const snapshot = JSON.stringify(status);
  if (snapshot === traySnapshot) return;
  traySnapshot = snapshot;
  const connected = status.state === 'online' || status.state === 'printing';
  tray.setImage(connected ? trayIcons.online : trayIcons.offline);
  tray.setTitle('');
  tray.setToolTip(`SitremPrinter — ${status.state}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Portal: ${status.state}${status.lastHeartbeatAt ? ` · ${new Date(status.lastHeartbeatAt).toLocaleTimeString()}` : ''}`, enabled: false },
    { label: status.printerName ? `Printer: ${status.printerName}` : 'Printer: not selected', enabled: false },
    ...(status.lastError ? [{ label: `Error: ${status.lastError}`, enabled: false }] : []),
    { type: 'separator' },
    { label: 'Configuration', click: () => { void showSettings(); } },
    { label: 'Exit', click: () => app.quit() },
  ]));
}

function registerIpcHandlers(): void {
  if (!service) throw new Error('Connector service is not initialized');
  const handle = (channel: string, callback: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      validateSettingsSender(event, settingsWindow && !settingsWindow.isDestroyed() && settingsUrl ? { id: settingsWindow.webContents.id, url: settingsUrl } : undefined);
      return callback(event, ...args);
    });
  };
  handle(IPC_CHANNELS.getStatus, () => service?.getStatus());
  handle(IPC_CHANNELS.pair, async (_event, input: PairingInput) => {
    const result = await service!.pair(input);
    app.setLoginItemSettings({ openAtLogin: input.startAtLogin ?? false });
    await service!.restart();
    return result;
  });
  handle(IPC_CHANNELS.saveSettings, async (_event, input: EditableSettings) => {
    await service!.saveSettings(input);
    app.setLoginItemSettings({ openAtLogin: input.startAtLogin ?? false });
  });
  handle(IPC_CHANNELS.resolveMediaConflict, (_event, choice: 'portal' | 'local') => service!.resolveMediaConflict(choice));
  handle(IPC_CHANNELS.testPrint, (_event, size: LabelSize) => service!.testPrint(size));
  handle(IPC_CHANNELS.getLogs, () => service!.getLogs());
  handle('connector:diagnostics', () => service!.diagnostics());
  handle(IPC_CHANNELS.openPrinterSettings, async () => {
    if (process.platform === 'darwin') await shell.openExternal('x-apple.systempreferences:com.apple.Print-Scan-Settings.extension');
    else if (process.platform === 'win32') await shell.openExternal('ms-settings:printers');
    else throw new Error('Open system printer settings manually on this operating system.');
  });
}

function createPrintWindow(): Electron.WebContents {
  printWindow?.destroy();
  printWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      partition: `sitrem-print-${process.pid}`,
    },
  });
  printWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  printWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  printWindow.webContents.session.setPermissionCheckHandler(() => false);
  printWindow.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('data:text/html')) event.preventDefault(); });
  printWindow.webContents.session.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: !_details.url.startsWith('data:') }));
  return printWindow.webContents;
}

async function initialize(): Promise<void> {

  const printer = new ElectronPrintEngine(createPrintWindow(), 120_000, createPrintWindow);
  service = new ConnectorService({
    userDataPath: app.getPath('userData'),
    secureStorage: safeStorage,
    printer,
    version: app.getVersion(),
    os: process.platform,
  });

  try {
    trayIcons = { offline: createTrayIcon(offlineIconPath), online: createTrayIcon(onlineIconPath) };
  } catch (error) {
    console.error('Unable to load Sitrem tray icons:', error);
    const fallback = process.platform === 'darwin' ? nativeImage.createFromNamedImage('NSActionTemplate') : nativeImage.createFromBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
    trayIcons = { offline: fallback, online: fallback };
  }
  tray = new Tray(trayIcons.offline);
  tray.on('click', () => { void showSettings(); });
  tray.on('right-click', () => tray?.popUpContextMenu());
  updateTray();
  trayTimer = setInterval(updateTray, 1_000);
  console.log(`SitremPrinter tray created (${trayIcons.offline.getSize().width}x${trayIcons.offline.getSize().height}); open Configuration from the tray menu to configure.`);
  if (process.platform === 'darwin') app.dock?.hide();

  registerIpcHandlers();
  service.start();
  service.subscribe(() => {
    updateTray();
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('connector:status-changed');
  });
  powerMonitor.on('suspend', () => { void service?.shutdown(); });
  powerMonitor.on('resume', () => { service?.invalidatePrinters(); void service?.restart(); });
  const initialStatus = await service.getStatus();
  if (!smoke) app.setLoginItemSettings({ openAtLogin: initialStatus.startAtLogin ?? false });
  if (!initialStatus.paired) await showSettings();
}

if (!hasSingleInstanceLock) {
  console.log('SitremPrinter is already running; not starting another instance.');
  app.exit(0);
} else {
  app.on('second-instance', () => { void showSettings(); });
    void app.whenReady().then(initialize).then(async () => {
      if (!smoke) return;
      await showSettings();
      console.log('Smoke: checking settings IPC');
      const status = await settingsWindow!.webContents.executeJavaScript('window.sitremConnector.getStatus()') as { paired: boolean };
      await printWindow!.loadURL('data:text/html,<script>globalThis.labelScriptRan=true</script><div>Smoke test</div>');
      console.log('Smoke: checking label isolation');
      let executionBlocked = false;
      try { await printWindow!.webContents.executeJavaScript('1 + 1'); }
      catch { executionBlocked = true; }
      if (status.paired || !executionBlocked) throw new Error('Packaged security smoke check failed: label scripting must be disabled');
      console.log(JSON.stringify({ smoke: 'passed', version: app.getVersion(), architecture: process.arch, platform: process.platform }));
      await service!.shutdown(); quitting = true; app.exit(0);
    }).catch((error: unknown) => {
    console.error('SitremPrinter failed to initialize:', error);
    app.exit(1);
  });
}

app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, 10_000));
  void Promise.race([service?.shutdown(), deadline]).finally(() => app.quit());
  if (trayTimer) clearInterval(trayTimer);
});
