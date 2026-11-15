export interface BrandingConfig {
  theme: 'light' | 'dark';
  accentColor: string;
  logoUrl?: string;
}

export function getBranding(config: Partial<BrandingConfig>): BrandingConfig {
  return {
    theme: config.theme ?? 'light',
    accentColor: config.accentColor ?? '#2f6fed',
    logoUrl: config.logoUrl ?? '/assets/logo.svg',
  };
}
