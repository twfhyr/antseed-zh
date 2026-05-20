const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export function isAddress(value) {
  return typeof value === 'string' && ADDRESS_RE.test(value);
}

export function requireAddress(value, fieldName = 'address') {
  if (!value) {
    const error = new Error(`${fieldName} is required`);
    error.status = 400;
    throw error;
  }
  if (!isAddress(value)) {
    const error = new Error(`${fieldName} must be a valid EVM address`);
    error.status = 400;
    throw error;
  }
  return value.toLowerCase();
}

export function parseEpochs(value) {
  if (!value) return [];
  const epochs = String(value)
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item >= 0);
  return [...new Set(epochs)];
}

export function parsePositiveInt(value, defaultValue, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    const error = new Error(`value must be an integer between ${min} and ${max}`);
    error.status = 400;
    throw error;
  }
  return parsed;
}

export function parseAddressList(value) {
  if (!value) return [];
  return [...new Set(
    String(value)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => requireAddress(item, 'buyer_addresses'))
  )];
}
