import { z } from 'zod';
import type { PrismaClient } from '@astrabi/prisma';
import { rotateSecret } from '@astrabi/security';

const keySchema = z.string().regex(/^[0-9a-f]{64}$/i);

export async function rotateDataSourceEncryptionKey(
  database: PrismaClient,
  currentKeyHex: string,
  newKeyHex: string,
): Promise<number> {
  const currentKey = keySchema.parse(currentKeyHex);
  const newKey = keySchema.parse(newKeyHex);
  if (currentKey.toLowerCase() === newKey.toLowerCase()) {
    throw new Error('The new encryption key must differ from the current key.');
  }

  return database.$transaction(async (transaction) => {
    const sources = await transaction.dataSource.findMany({
      where: { kind: 'POSTGRES', encryptedConfig: { not: null } },
      select: { id: true, encryptedConfig: true, encryptionIv: true, encryptionTag: true },
    });

    for (const source of sources) {
      if (!source.encryptedConfig || !source.encryptionIv || !source.encryptionTag) {
        throw new Error(`Data source ${source.id} has incomplete encryption metadata.`);
      }

      const encrypted = rotateSecret({
        ciphertext: source.encryptedConfig,
        iv: source.encryptionIv,
        authTag: source.encryptionTag,
      }, currentKey, newKey);
      await transaction.dataSource.update({
        where: { id: source.id },
        data: {
          encryptedConfig: encrypted.ciphertext,
          encryptionIv: encrypted.iv,
          encryptionTag: encrypted.authTag,
        },
      });
    }

    return sources.length;
  }, { maxWait: 10_000, timeout: 60_000 });
}
