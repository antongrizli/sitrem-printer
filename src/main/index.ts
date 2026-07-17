import { app, BrowserWindow, ipcMain, Menu, nativeImage, safeStorage, shell, Tray } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import offlineIconPath from '../assets/sitrem-icon-tray-offline.png?asset';
import onlineIconPath from '../assets/sitrem-icon-tray-online.png?asset';
import { ConnectorService } from './connector-service.ts';
import { ElectronPrintEngine } from './print-engine.ts';
import { IPC_CHANNELS } from '../shared/ipc.ts';
import type { EditableSettings, LabelSize, PairingInput } from '../shared/contracts.ts';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
let printWindow: BrowserWindow | undefined;
let settingsWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let trayTimer: NodeJS.Timeout | undefined;
let service: ConnectorService | undefined;
let trayIcons: { online: Electron.NativeImage; offline: Electron.NativeImage } | undefined;

app.setName('SitremPrinter');
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
    resizable: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(currentDirectory, '../preload/index.cjs'),
    },
  });
  settingsWindow.removeMenu();
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  settingsWindow.on('closed', () => { settingsWindow = undefined; });
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
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
  ipcMain.handle(IPC_CHANNELS.getStatus, () => service?.getStatus());
  ipcMain.handle(IPC_CHANNELS.pair, async (_event, input: PairingInput) => {
    const result = await service!.pair(input);
    await service!.restart();
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.saveSettings, (_event, input: EditableSettings) => { service!.saveSettings(input); });
  ipcMain.handle(IPC_CHANNELS.testPrint, (_event, size: LabelSize) => service!.testPrint(size));
  ipcMain.handle(IPC_CHANNELS.getLogs, () => service!.getLogs());
  ipcMain.handle(IPC_CHANNELS.openPrinterSettings, async () => {
    if (process.platform === 'darwin') await shell.openExternal('x-apple.systempreferences:com.apple.Print-Scan-Settings.extension');
    else if (process.platform === 'win32') await shell.openExternal('ms-settings:printers');
    else throw new Error('Open system printer settings manually on this operating system.');
  });
}

async function initialize(): Promise<void> {
  printWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: `sitrem-print-${process.pid}`,
    },
  });
  printWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  printWindow.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('data:text/html')) event.preventDefault(); });
  printWindow.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));

  const printer = new ElectronPrintEngine(printWindow.webContents);
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
    const fallback = nativeImage.createFromNamedImage('NSActionTemplate');
    trayIcons = { offline: fallback, online: fallback };
  }
  tray = new Tray(trayIcons.offline);
  tray.on('click', focusSettingsIfOpen);
  tray.on('right-click', () => tray?.popUpContextMenu());
  updateTray();
  trayTimer = setInterval(updateTray, 1_000);
  console.log(`SitremPrinter tray created (${trayIcons.offline.getSize().width}x${trayIcons.offline.getSize().height}); open Configuration from the tray menu to configure.`);
  if (process.platform === 'darwin') app.dock?.hide();

  registerIpcHandlers();
  service.start();
}

if (!hasSingleInstanceLock) {
  console.log('SitremPrinter is already running; not starting another instance.');
  app.exit(0);
} else {
  app.on('second-instance', () => undefined);
  void app.whenReady().then(initialize).catch((error: unknown) => {
    console.error('SitremPrinter failed to initialize:', error);
    app.exit(1);
  });
}

app.on('before-quit', () => {
  service?.stop();
  if (trayTimer) clearInterval(trayTimer);
});
