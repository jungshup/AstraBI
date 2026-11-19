CREATE TYPE "data_source_kind" AS ENUM ('POSTGRES', 'CSV');
CREATE TYPE "dashboard_chart_type" AS ENUM ('TABLE', 'BAR', 'LINE', 'AREA', 'NUMBER');

CREATE TABLE "data_sources" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "data_source_kind" NOT NULL,
    "encrypted_config" TEXT,
    "encryption_iv" TEXT,
    "encryption_tag" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "data_sources_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "datasets" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "data_source_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "columns" JSONB NOT NULL,
    "source_schema" TEXT,
    "source_table" TEXT,
    "row_count" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "datasets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "dataset_rows" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "dataset_id" TEXT NOT NULL,
    "row_index" INTEGER NOT NULL,
    "row_data" JSONB NOT NULL,
    CONSTRAINT "dataset_rows_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "dashboards" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dashboards_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "dashboard_panels" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "dashboard_id" TEXT NOT NULL,
    "dataset_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "chart_type" "dashboard_chart_type" NOT NULL,
    "query_mode" TEXT NOT NULL,
    "query" JSONB NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dashboard_panels_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "data_sources_tenant_id_id_key" ON "data_sources"("tenant_id", "id");
CREATE UNIQUE INDEX "data_sources_tenant_id_name_key" ON "data_sources"("tenant_id", "name");
CREATE UNIQUE INDEX "datasets_tenant_id_id_key" ON "datasets"("tenant_id", "id");
CREATE UNIQUE INDEX "datasets_data_source_id_name_key" ON "datasets"("data_source_id", "name");
CREATE INDEX "datasets_tenant_id_data_source_id_idx" ON "datasets"("tenant_id", "data_source_id");
CREATE UNIQUE INDEX "dataset_rows_dataset_id_row_index_key" ON "dataset_rows"("dataset_id", "row_index");
CREATE INDEX "dataset_rows_tenant_id_dataset_id_row_index_idx" ON "dataset_rows"("tenant_id", "dataset_id", "row_index");
CREATE UNIQUE INDEX "dashboards_tenant_id_id_key" ON "dashboards"("tenant_id", "id");
CREATE UNIQUE INDEX "dashboards_tenant_id_name_key" ON "dashboards"("tenant_id", "name");
CREATE INDEX "dashboard_panels_tenant_id_dashboard_id_position_idx" ON "dashboard_panels"("tenant_id", "dashboard_id", "position");

ALTER TABLE "data_sources"
    ADD CONSTRAINT "data_sources_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "datasets"
    ADD CONSTRAINT "datasets_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "datasets_tenant_id_data_source_id_fkey"
    FOREIGN KEY ("tenant_id", "data_source_id") REFERENCES "data_sources"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dataset_rows"
    ADD CONSTRAINT "dataset_rows_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "dataset_rows_tenant_id_dataset_id_fkey"
    FOREIGN KEY ("tenant_id", "dataset_id") REFERENCES "datasets"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dashboards"
    ADD CONSTRAINT "dashboards_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "dashboard_panels"
    ADD CONSTRAINT "dashboard_panels_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "dashboard_panels_tenant_id_dashboard_id_fkey"
    FOREIGN KEY ("tenant_id", "dashboard_id") REFERENCES "dashboards"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "dashboard_panels_tenant_id_dataset_id_fkey"
    FOREIGN KEY ("tenant_id", "dataset_id") REFERENCES "datasets"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;
