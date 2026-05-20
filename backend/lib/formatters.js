function toCamelCase(str) {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

export function camelize(obj) {
  const result = {};
  for (const key of Object.keys(obj)) {
    result[toCamelCase(key)] = obj[key];
  }
  return result;
}

export function parseService(row) {
  const r = camelize(row);
  return {
    ...r,
    categories: JSON.parse(row.categories),
    protocols: JSON.parse(row.protocols),
    pricing: {
      inputUsdPerMillion: row.pricing_input,
      cachedInputUsdPerMillion: row.pricing_cached_input,
      outputUsdPerMillion: row.pricing_output,
    },
  };
}
