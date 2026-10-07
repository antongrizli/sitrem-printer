export type SessionIdentity = Readonly<{ portalUrl: string; connectorId: string; token: string }>;
export class ConnectorRevokedError extends Error {}
export class PortalHttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs?: number) { super(`Portal request failed (HTTP ${status})`); }
}

export function apiPath(connectorId: string, suffix: string, jobId?: string): string {
  const base = `/api/print/connectors/${encodeURIComponent(connectorId)}`;
  return jobId === undefined ? `${base}/${suffix}` : `${base}/jobs/${encodeURIComponent(jobId)}/${suffix}`;
}

export class PortalClient {
  constructor(readonly identity: SessionIdentity, private readonly fetchFn: typeof fetch = fetch, private readonly deadlineMs = 15_000) {}
  async request(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.deadlineMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await this.fetchFn(`${this.identity.portalUrl}${path}`, {
      ...init, redirect: 'error', signal: combined,
      headers: { authorization: `Bearer ${this.identity.token}`, 'content-type': 'application/json', ...init.headers },
    });
    if (response.status === 401) throw new ConnectorRevokedError('Connector token was revoked; pair again');
    if (response.status === 204) return null;
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    if (reader) {
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 2_000_000) { await reader.cancel(); throw new Error('Portal response exceeds allowed size'); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!response.ok) {
      const retry = response.headers.get('retry-after');
      const value = retry === null ? undefined : /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
      throw new PortalHttpError(response.status, value !== undefined && Number.isFinite(value) ? Math.max(0, Math.min(value, 60_000)) : undefined);
    }
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new Error(`Invalid portal response (HTTP ${response.status})`); }
    return body;
  }
}

export async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });
  });
}
