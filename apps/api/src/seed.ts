import { z } from 'zod';
import { hashPassword } from '@astrabi/security';
import { prisma } from '@astrabi/prisma';

const config = z.object({
  DATABASE_URL: z.string().url(),
  ASTRABI_BOOTSTRAP_TENANT_ID: z.string().uuid(),
  ASTRABI_BOOTSTRAP_TENANT_NAME: z.string().trim().min(1).max(120),
  ASTRABI_BOOTSTRAP_ADMIN_EMAIL: z.string().email().max(254),
  ASTRABI_BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).max(128)
    .refine((value) => Buffer.byteLength(value, 'utf8') <= 72),
}).parse(process.env);

try {
  const tenant = await prisma.tenant.upsert({
    where: { id: config.ASTRABI_BOOTSTRAP_TENANT_ID },
    create: {
      id: config.ASTRABI_BOOTSTRAP_TENANT_ID,
      name: config.ASTRABI_BOOTSTRAP_TENANT_NAME,
    },
    update: {},
  });
  const email = config.ASTRABI_BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
  const passwordHash = await hashPassword(config.ASTRABI_BOOTSTRAP_ADMIN_PASSWORD);
  await prisma.user.upsert({
    where: { tenantId_email: { tenantId: tenant.id, email } },
    create: {
      tenantId: tenant.id,
      email,
      displayName: 'Platform Administrator',
      passwordHash,
      role: 'ADMIN',
    },
    update: {
      displayName: 'Platform Administrator',
      passwordHash,
      role: 'ADMIN',
      isActive: true,
    },
  });
  console.log(`Bootstrap administrator is ready for tenant ${tenant.id}.`);
} finally {
  await prisma.$disconnect();
}
