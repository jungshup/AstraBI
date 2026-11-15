import { appName, getSystemSummary, FeatureFlagKey, type PlatformEnvironment } from '@astrabi/core';
import { createAuthContext } from '@astrabi/auth';
import { createUserProfile } from '@astrabi/user';
import { authorizeAction } from '@astrabi/rbac';
import { auditEvent } from '@astrabi/audit';
import { sanitizePayload } from '@astrabi/security';
import { isFeatureEnabled } from '@astrabi/feature-flags';
import { getBranding } from '@astrabi/branding';
import { resolveDynamicConfig } from '@astrabi/dynamic-config';
import { startExperiment } from '@astrabi/experiment';

const environment: PlatformEnvironment = 'development';

const authContext = createAuthContext({
  subject: 'system-admin',
  roles: ['admin'],
  tenantId: 'default',
});

const user = createUserProfile({
  id: 'u-1001',
  email: 'admin@astrabi.local',
  displayName: 'Platform Admin',
  tenantId: 'default',
});

const canAccess = authorizeAction({
  action: 'dashboard:view',
  user,
  tenantId: 'default',
});

const payload = {
  name: '      AstraBI     ',
  note: '<script>alert(1)</script>',
};

const safePayload = sanitizePayload(payload);
const featureEnabled = isFeatureEnabled(FeatureFlagKey.EXPLORER_V2, environment);
const branding = getBranding({ theme: 'dark' });
const dynamicConfig = resolveDynamicConfig('catalog.defaultPageSize', environment);
const experiment = startExperiment('conversion-hero', { audience: 'beta' });

console.log(appName);
console.log(getSystemSummary());
console.log({ authContext, canAccess, safePayload, featureEnabled, branding, dynamicConfig, experiment });

const health = {
  service: 'astrabi-api',
  status: 'ok',
  version: '0.1.0',
  moduleCount: 11,
};

console.log(JSON.stringify(health, null, 2));
