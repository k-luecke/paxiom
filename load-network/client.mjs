// HTTP client for https://load.network — Arweave-archived Ethereum
// transaction data with deterministic state reconstruction.
//
// This client is the I/O boundary. Cryptographic verification of returned
// data lives in `verifier.mjs` and is invoked by `reconstruct.mjs` — by
// design, this file does not return any value to a caller without that
// caller routing it through verification first. The point of the no-RPC
// architectural moat (paxiom-build-map R-200) is that values from
// load.network are trustworthy because they came with a proof, not
// because load.network is honest.
//
// Errors fall into the four-category taxonomy in `errors.mjs`:
//   NetworkError      — 5xx, 429, timeout, transport failure (retried)
//   DataError         — 4xx other than 429, malformed JSON
//   ProtocolError     — surfaced by reconstruct.mjs when shape drifts
//   VerificationError — surfaced by reconstruct.mjs when proof fails

import {
  LoadNetworkError,
  LoadNetworkNetworkError,
  LoadNetworkDataError,
  LoadNetworkProtocolError,
} from './errors.mjs';

const DEFAULT_BASE_URL = 'https://load.network';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 4;

// Re-export so callers can `import { LoadNetworkError } from './client.mjs'`
// for backwards compat with the Phase 0 scaffolding.
export { LoadNetworkError } from './errors.mjs';

export class LoadNetworkClient {
  constructor({
    baseUrl = process.env.LOAD_NETWORK_URL || DEFAULT_BASE_URL,
    apiKey = process.env.LOAD_NETWORK_API_KEY,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    onEvent,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    // onEvent is the structured-logging hook. If supplied, the client
    // calls it with `{stage, requestId, ...}` events at every request
    // boundary. Defaults to a no-op so consumers without metrics
    // infrastructure pay nothing.
    this.onEvent = onEvent ?? (() => {});
  }

  async getArchivedBlock(blockNumber) {
    return this.#getJson(`/v1/blocks/${blockNumber}`, { stage: 'getArchivedBlock' });
  }

  // EIP-1186-shaped account proof endpoint. Response body must include
  // {address, balance, nonce, code_hash, storage_root, account_proof[]}.
  // Validation of that shape happens in reconstruct.mjs (ProtocolError);
  // this client only ferries bytes.
  async getAccountProof(blockNumber, address) {
    return this.#getJson(
      `/v1/state/${blockNumber}/account/${address}`,
      { stage: 'getAccountProof' },
    );
  }

  // EIP-1186-shaped storage proof endpoint. Response body must include
  // {address, slot, value, storage_proof[]}. The companion
  // getAccountProof must be called separately to bind storageRoot.
  async getStorageProof(blockNumber, address, slot) {
    return this.#getJson(
      `/v1/state/${blockNumber}/storage/${address}/${slot}`,
      { stage: 'getStorageProof' },
    );
  }

  // ─── Backwards-compat alias used by the Phase 0 scaffolding ────────
  // reconstruct.mjs currently calls these names; new code should use
  // getAccountProof / getStorageProof directly.
  async getReconstructedState(blockNumber, address) {
    return this.getAccountProof(blockNumber, address);
  }
  async getStorageSlot(blockNumber, address, slot) {
    return this.getStorageProof(blockNumber, address, slot);
  }

  async #getJson(path, ctx) {
    const url = `${this.baseUrl}${path}`;
    const requestId = randomRequestId();
    let lastErr;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
      const startedAt = Date.now();
      this.onEvent({ ...ctx, requestId, attempt, url, event: 'request_start' });

      try {
        const headers = { Accept: 'application/json' };
        if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
        const resp = await this.fetch(url, { headers, signal: ctl.signal });

        if (resp.status === 429) {
          const retryAfter = Number(resp.headers.get('Retry-After')) || 1;
          this.onEvent({ ...ctx, requestId, attempt, status: 429, event: 'rate_limited', retryAfter });
          await sleep(retryAfter * 1000);
          continue;
        }
        if (resp.status >= 500) {
          lastErr = new LoadNetworkNetworkError(`server error from ${url}`, {
            status: resp.status, attempt, stage: ctx.stage, requestId,
          });
          this.onEvent({ ...ctx, requestId, attempt, status: resp.status, event: 'server_error' });
          await sleep(backoffMs(attempt));
          continue;
        }
        if (!resp.ok) {
          throw new LoadNetworkDataError(`HTTP ${resp.status} from ${url}`, {
            status: resp.status,
            body: await safeText(resp),
            attempt, stage: ctx.stage, requestId,
          });
        }
        let json;
        try {
          json = await resp.json();
        } catch (e) {
          throw new LoadNetworkProtocolError(`malformed JSON from ${url}: ${e.message}`, {
            status: resp.status, attempt, stage: ctx.stage, requestId, cause: e,
          });
        }
        this.onEvent({
          ...ctx, requestId, attempt, status: resp.status,
          latencyMs: Date.now() - startedAt, event: 'request_ok',
        });
        return json;
      } catch (e) {
        if (e instanceof LoadNetworkError) throw e;
        // AbortError → timeout, treated as transient
        const wrapped = new LoadNetworkNetworkError(`transport failure for ${url}: ${e.message}`, {
          attempt, stage: ctx.stage, requestId, cause: e,
        });
        this.onEvent({ ...ctx, requestId, attempt, event: 'transport_error', error: e.message });
        lastErr = wrapped;
        await sleep(backoffMs(attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr ?? new LoadNetworkNetworkError(`exhausted ${MAX_ATTEMPTS} attempts for ${url}`, {
      attempt: MAX_ATTEMPTS, stage: ctx.stage, requestId,
    });
  }
}

async function safeText(resp) {
  try { return await resp.text(); } catch { return undefined; }
}

function backoffMs(attempt) {
  return Math.min(8000, 250 * 2 ** (attempt - 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomRequestId() {
  // 12 hex chars for log correlation. Requires Node 18+ (built-in
  // globalThis.crypto.getRandomValues); package.json declares
  // engines.node >=18.0.0. Math.random fallback dropped per audit L-16.
  const buf = new Uint8Array(6);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
