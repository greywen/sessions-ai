-- Regular table: normalized_messages
-- Drizzle schema defines a regular table, here we convert it to a partitioned table
-- Execute manually after drizzle-kit migrate

-- If Drizzle has already created a regular table, drop it and recreate as a partitioned table
-- Note: Only execute during initialization
DO $$
BEGIN
  -- Check if the table exists and is not a partitioned table
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'normalized_messages')
     AND NOT EXISTS (
       SELECT 1 FROM pg_partitioned_table pt
       JOIN pg_class c ON pt.partrelid = c.oid
       WHERE c.relname = 'normalized_messages'
     )
  THEN
    DROP TABLE normalized_messages CASCADE;
  END IF;
END $$;

-- Create partitioned table
CREATE TABLE IF NOT EXISTS normalized_messages (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL,
  parent_id TEXT,
  machine_id UUID NOT NULL,
  source_tool TEXT NOT NULL,
  role TEXT NOT NULL,
  content_blocks JSONB,
  usage JSONB,
  raw_timestamp TIMESTAMPTZ NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Create initial monthly partitions
CREATE TABLE IF NOT EXISTS nm_2026_04 PARTITION OF normalized_messages
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS nm_2026_05 PARTITION OF normalized_messages
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS nm_2026_06 PARTITION OF normalized_messages
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

-- Indexes
CREATE INDEX IF NOT EXISTS idx_nm_machine_time ON normalized_messages (machine_id, created_at);
CREATE INDEX IF NOT EXISTS idx_nm_session ON normalized_messages (session_id);
CREATE INDEX IF NOT EXISTS idx_nm_source_tool ON normalized_messages (source_tool, created_at);
