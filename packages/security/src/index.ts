export function sanitizePayload<T>(input: T): T {
  if (typeof input === 'string') {
    return input.trim() as T;
  }

  if (Array.isArray(input)) {
    return input.map((item) => sanitizePayload(item)) as T;
  }

  if (input && typeof input === 'object') {
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(([key, value]) => [
        key,
        typeof value === 'string' ? value.trim().replace(/<script|<iframe/gi, '') : sanitizePayload(value),
      ]),
    ) as T;
  }

  return input;
}
