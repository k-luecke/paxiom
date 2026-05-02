// HTTP client for https://load.network — Arweave-archived Ethereum
// transaction data with deterministic state reconstruction.
//
// Used by `reconstruct.mjs` to fetch the inputs that close the
// A-120 / S.03 Phase 0 gate (state reconstruction from Load Network archive
// working end-to-end for at least one historical block).
//
// Honors rate limits (429 + Retry-After), exponential backoff on 5xx,
// structured errors via the LoadNetworkError class.

const DEFAULT_BASE_URL = 'https://load.network';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 4;

export class LoadNetworkError extends Error {
  constructor(message, { status, body, attempt } = {}) {
    super(message);
    this.name = 'LoadNetworkError';
    this.status = status;
    this.body = body;
    this.attempt = attempt;
  }
}

export class LoadNetworkClient {
  constructor({
    baseUrl = process.env.LOAD_NETWORK_URL || DEFAULT_BASE_URL,
    apiKey = process.env.LOAD_NETWORK_API_KEY,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async getArchivedBlock(blockNumber) {
    return this.#getJson(`/v1/blocks/${blockNumber}`);
  }

  async getReconstructedState(blockNumber, address) {
    return this.#getJson(
      `/v1/state/${blockNumber}/account/${address}`,
    );
  }

  async getStorageSlot(blockNumber, address, slot) {
    return this.#getJson(
      `/v1/state/${blockNumber}/storage/${address}/${slot}`,
    );
  }

  async #getJson(path) {
    const url = `${this.baseUrl}${path}`;
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
      try {
        const headers = { Accept: 'application/json' };
        if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
        const resp = await this.fetch(url, { headers, signal: ctl.signal });

        if (resp.status === 429) {
          const retryAfter = Number(resp.headers.get('Retry-After')) || 1;
          await sleep(retryAfter * 1000);
          continue;
        }
        if (resp.status >= 500) {
          lastErr = new LoadNetworkError(`server error from ${url}`, {
            status: resp.status, attempt,
          });
          await sleep(backoffMs(attempt));
          continue;
        }
        if (!resp.ok) {
          throw new LoadNetworkError(`HTTP ${resp.status} from ${url}`, {
            status: resp.status,
            body: await safeText(resp),
            attempt,
          });
        }
        return await resp.json();
      } catch (e) {
        if (e instanceof LoadNetworkError) throw e;
        lastErr = e;
        await sleep(backoffMs(attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr ?? new LoadNetworkError(`exhausted ${MAX_ATTEMPTS} attempts`, { attempt: MAX_ATTEMPTS });
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
