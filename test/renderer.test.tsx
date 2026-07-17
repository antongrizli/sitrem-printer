// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/renderer/src/App.tsx';
import type { ConnectorApi, ConnectorStatus } from '../src/shared/contracts.ts';

const status: ConnectorStatus = {
  portalUrl: 'http://127.0.0.1:3000',
  connectorName: 'Reception',
  printerName: 'VRETTI 420B',
  paired: true,
  printers: ['VRETTI 420B', 'Office printer'],
  printerAvailable: true,
  printerError: null,
  state: 'online',
  message: 'Connected to portal; waiting for print jobs',
  lastHeartbeatAt: '2026-07-17T12:00:00.000Z',
  lastError: null,
  lastJobAt: null,
};

function mockApi(overrides: Partial<ConnectorApi> = {}): ConnectorApi {
  return {
    getStatus: vi.fn(async () => status),
    pair: vi.fn(async () => ({ connectorId: 'paired-1' })),
    saveSettings: vi.fn(async () => undefined),
    testPrint: vi.fn(async () => undefined),
    getLogs: vi.fn(async () => [{ at: '2026-07-17T12:00:00.000Z', event: 'paired', detail: 'paired-1' }]),
    openPrinterSettings: vi.fn(async () => undefined),
    ...overrides,
  };
}

beforeEach(() => { window.sitremConnector = mockApi(); });
afterEach(() => vi.useRealTimers());

describe('React settings renderer', () => {
  it('loads status, editable settings, printers, and activity', async () => {
    render(<App />);
    expect(await screen.findByDisplayValue('http://127.0.0.1:3000')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Reception')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Office printer' })).toBeInTheDocument();
    expect(screen.getByText(/currently available/)).toBeInTheDocument();
    expect(await screen.findByText(/paired-1/)).toBeInTheDocument();
  });

  it('does not overwrite edited form fields during background status refresh', async () => {
    vi.useFakeTimers();
    const getStatus = vi.fn(async () => status);
    window.sitremConnector = mockApi({ getStatus });
    render(<App />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const portal = screen.getByLabelText('Portal URL');
    fireEvent.change(portal, { target: { value: 'http://edited.local:3000' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(portal).toHaveValue('http://edited.local:3000');
    expect(getStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('pairs through the typed bridge and clears the one-time code', async () => {
    const user = userEvent.setup();
    const unpaired = { ...status, paired: false, state: 'not_paired' as const, message: 'Not paired', lastHeartbeatAt: null };
    const pair = vi.fn(async () => ({ connectorId: 'new-connector' }));
    window.sitremConnector = mockApi({ getStatus: vi.fn(async () => unpaired), pair });
    render(<App />);
    const code = await screen.findByLabelText('Pairing code');
    await user.type(code, 'one-time-code');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(pair).toHaveBeenCalledWith(expect.objectContaining({ pairingCode: 'one-time-code', portalUrl: 'http://127.0.0.1:3000' })));
    expect(await screen.findByText('Paired as new-connector.')).toBeInTheDocument();
    expect(code).toHaveValue('');
  });

  it('saves settings, opens printer settings, and prints the fixed test label', async () => {
    const saveSettings = vi.fn(async () => undefined);
    const openPrinterSettings = vi.fn(async () => undefined);
    const testPrint = vi.fn(async () => undefined);
    window.sitremConnector = mockApi({ saveSettings, openPrinterSettings, testPrint });
    render(<App />);
    await screen.findByDisplayValue('Reception');
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(saveSettings).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Open system printer settings' }));
    await waitFor(() => expect(openPrinterSettings).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Print 50 × 30 mm test grid' }));
    await waitFor(() => expect(testPrint).toHaveBeenCalledWith({ widthMm: 50, heightMm: 30 }));
    expect(await screen.findByText('Test label sent to the system print queue.')).toBeInTheDocument();
  });

  it('shows an unavailable selected printer and bridge errors', async () => {
    const unavailable = { ...status, printerAvailable: false, state: 'offline' as const, message: 'Portal connection failed', lastError: 'Connection refused' };
    window.sitremConnector = mockApi({
      getStatus: vi.fn(async () => unavailable),
      saveSettings: vi.fn(async () => { throw new Error('Cannot save settings'); }),
    });
    render(<App />);
    expect(await screen.findByText(/not currently available/)).toBeInTheDocument();
    expect(screen.getByText(/Connection refused/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cannot save settings');
  });
});
