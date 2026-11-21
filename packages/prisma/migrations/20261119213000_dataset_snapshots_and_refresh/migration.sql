ALTER TABLE "datasets"
    ADD COLUMN "refresh_interval_minutes" INTEGER,
    ADD COLUMN "last_refreshed_at" TIMESTAMP(3),
    ADD COLUMN "next_refresh_at" TIMESTAMP(3),
    ADD COLUMN "last_refresh_error" TEXT;

CREATE INDEX "datasets_refresh_interval_minutes_next_refresh_at_idx"
    ON "datasets"("refresh_interval_minutes", "next_refresh_at");
