export function resolveDynamicConfig<T>(key: string, environment: string): T {
  const defaults: Record<string, unknown> = {
    'catalog.defaultPageSize': 25,
    'app.title': 'AstraBI',
  };

  const value = defaults[key] ?? { environment, key };
  return value as T;
}
