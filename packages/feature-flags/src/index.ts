export enum FeatureFlagKey {
  EXPLORER_V2 = 'explorer-v2',
  AI_ASSISTANT = 'ai-assistant',
  WHITE_LABEL = 'white-label',
}

export function isFeatureEnabled(key: FeatureFlagKey, environment: string): boolean {
  const enabledFlags = {
    'explorer-v2': ['development', 'staging'],
    'ai-assistant': ['development', 'production'],
    'white-label': ['staging', 'production'],
  };

  return (enabledFlags[key] ?? []).includes(environment);
}
