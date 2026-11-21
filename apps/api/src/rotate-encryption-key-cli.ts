import { prisma } from '@astrabi/prisma';
import { rotateDataSourceEncryptionKey } from './rotate-encryption-key.js';

async function main(): Promise<void> {
  const currentKey = process.env.ASTRABI_DATA_ENCRYPTION_KEY;
  const newKey = process.env.ASTRABI_DATA_ENCRYPTION_NEW_KEY;
  if (!currentKey || !newKey) {
    throw new Error(
      'Set ASTRABI_DATA_ENCRYPTION_KEY and ASTRABI_DATA_ENCRYPTION_NEW_KEY before running key rotation.',
    );
  }

  const count = await rotateDataSourceEncryptionKey(prisma, currentKey, newKey);
  console.info(`Re-encrypted credentials for ${count} PostgreSQL data source(s).`);
}

try {
  await main();
} catch {
  console.error('Encryption key rotation failed; the database transaction was rolled back.');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
