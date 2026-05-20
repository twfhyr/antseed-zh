export function readBoolEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase());
}

export function readIntEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}
