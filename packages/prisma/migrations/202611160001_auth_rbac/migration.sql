ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT;
ALTER TABLE "User" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
UPDATE "User" SET "passwordHash" = '' WHERE "passwordHash" IS NULL;
ALTER TABLE "User" ALTER COLUMN "passwordHash" SET NOT NULL;
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'ANALYST', 'VIEWER');
ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "role" TYPE "UserRole" USING (
  CASE LOWER("role")
    WHEN 'admin' THEN 'ADMIN'::"UserRole"
    WHEN 'analyst' THEN 'ANALYST'::"UserRole"
    ELSE 'VIEWER'::"UserRole"
  END
);
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'VIEWER';
