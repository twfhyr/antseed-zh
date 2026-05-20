import { readIntEnv } from './env.js';

const DEFAULT_TIMEOUT_MS = readIntEnv('FETCH_TIMEOUT_MS', 10000);
const DEFAULT_RETRIES = readIntEnv('FETCH_RETRIES', 1);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchJsonWithRetry(url, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    ...fetchOptions
  } = options;

  let attempt = 0;
  let lastError;

  while (attempt <= retries) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }
      return response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error;
      if (attempt === retries) break;
      await sleep(250 * (attempt + 1));
      attempt += 1;
      continue;
    }
  }

  throw lastError;
}
