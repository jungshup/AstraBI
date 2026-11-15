export const appName = 'AstraBI';

export type PlatformEnvironment = 'development' | 'staging' | 'production';

export type FeatureFlagKey =
  | 'explorer-v2'
  | 'ai-assistant'
  | 'white-label';

export interface SystemSummary {
  name: string;
  version: string;
  environment: PlatformEnvironment;
  moduleCount: number;
}

export function getSystemSummary(): SystemSummary {
  return {
    name: appName,
    version: '0.1.0',
    environment: 'development',
    moduleCount: 11,
  };
}

export function createEntityId(prefix: string): string {
  return `${prefix}-${Date.now()}`;
}
