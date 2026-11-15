import { appName, getSystemSummary } from '@astrabi/core';
import { getBranding } from '@astrabi/branding';
import { isFeatureEnabled, FeatureFlagKey } from '@astrabi/feature-flags';
import { resolveDynamicConfig } from '@astrabi/dynamic-config';

const branding = getBranding({ theme: 'light' });
const featureEnabled = isFeatureEnabled(FeatureFlagKey.EXPLORER_V2, 'production');
const config = resolveDynamicConfig('app.title', 'production');

console.log(appName);
console.log(getSystemSummary());
console.log({ branding, featureEnabled, config });
