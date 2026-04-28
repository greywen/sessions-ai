import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';

let schemaEnsured = false;

// Keep pricing sync columns backward-compatible for environments
// where migrations were not applied yet.
export async function ensurePricingSyncSchema() {
  if (schemaEnsured) {
    return;
  }

  const columnRows = await db.execute(sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'pricing_table'
      AND column_name IN ('sync_source', 'sync_locked', 'last_synced_at')
  `);

  const existingColumns = new Set(
    (columnRows as Array<Record<string, unknown>>).map((row) => String(row.column_name)),
  );

  if (!existingColumns.has('sync_source')) {
    await db.execute(sql`
      ALTER TABLE pricing_table
      ADD COLUMN IF NOT EXISTS sync_source text
    `);
  }

  if (!existingColumns.has('sync_locked')) {
    await db.execute(sql`
      ALTER TABLE pricing_table
      ADD COLUMN IF NOT EXISTS sync_locked boolean
    `);
  }

  if (!existingColumns.has('last_synced_at')) {
    await db.execute(sql`
      ALTER TABLE pricing_table
      ADD COLUMN IF NOT EXISTS last_synced_at timestamptz
    `);
  }

  // Backfill legacy rows so manual history is protected from future sync overwrite.
  await db.execute(sql`
    UPDATE pricing_table
    SET sync_source = 'manual'
    WHERE sync_source IS NULL
  `);

  await db.execute(sql`
    UPDATE pricing_table
    SET sync_locked = true
    WHERE sync_locked IS NULL
  `);

  // Keep one row per model. Prefer manual-locked rows, then newer effective_from.
  await db.execute(sql`
    WITH ranked AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY model
          ORDER BY sync_locked DESC, effective_from DESC, created_at DESC, id DESC
        ) AS rn
      FROM pricing_table
    )
    DELETE FROM pricing_table p
    USING ranked r
    WHERE p.id = r.id
      AND r.rn > 1
  `);

  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_model_unique
    ON pricing_table (model)
  `);

  schemaEnsured = true;
}
