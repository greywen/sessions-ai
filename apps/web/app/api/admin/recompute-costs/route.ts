import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSession } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/roles';
import { logger } from '@/lib/logger';
import { sql } from 'drizzle-orm';

/**
 * POST /api/admin/recompute-costs
 *
 * Recompute normalized_messages.cost_usd and pricing_id.
 * Trigger scenarios:
 *   - pricing_table changed (new rows, price updates, or time-window updates)
 *   - historical backfill requires a refresh
 *
 * Executes an in-database batch update using LATERAL JOIN. Matching logic is
 * strictly equivalent to lib/cost/compute.ts:
 * raw -> stripFirst -> stripLast -> dot-to-hyphen variants,
 * with the same effective_from/effective_to window.
 *
 * Security: admin session or CRON_SECRET.
 *
 * Optional query: ?from=YYYY-MM-DD&to=YYYY-MM-DD to limit the range
 * (defaults to full-table recompute).
 */
export async function POST(request: Request) {
  // Authentication
  const cronSecret = request.headers.get('x-cron-secret');
  const expectedSecret = process.env.CRON_SECRET || 'llm-sessions-cron-secret';
  if (cronSecret !== expectedSecret) {
    const session = await getSession();
    if (!session || !hasRole(session.role, 'admin')) {
      return NextResponse.json({ error: 'Not Authorised' }, { status: 401 });
    }
  }

  const { searchParams } = new URL(request.url);
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  const startTime = Date.now();
  try {
    const whereParts = [sql`nm.usage IS NOT NULL`];
    if (from) whereParts.push(sql`nm.raw_timestamp >= ${from}::date`);
    if (to) whereParts.push(sql`nm.raw_timestamp < (${to}::date + INTERVAL '1 day')`);
    const whereClause = sql.join(whereParts, sql` AND `);

    const result = await db.execute(sql`
      WITH matched AS (
        SELECT
          nm.id,
          p.id AS pricing_id,
          (
            COALESCE((nm.usage->>'inputTokens')::numeric, 0) / 1000000 * COALESCE(p.input_price_per_mtok, 0) +
            COALESCE((nm.usage->>'outputTokens')::numeric, 0) / 1000000 * COALESCE(p.output_price_per_mtok, 0) +
            (
              COALESCE((nm.usage->>'cacheCreationInputTokens')::numeric, 0) +
              COALESCE((nm.usage->>'cacheReadInputTokens')::numeric, 0)
            ) / 1000000 * COALESCE(p.cache_price_per_mtok, 0)
          )::numeric(12,6) AS cost
        FROM normalized_messages nm
        LEFT JOIN LATERAL (
          SELECT pt.id, pt.input_price_per_mtok, pt.output_price_per_mtok, pt.cache_price_per_mtok
          FROM pricing_table pt
          WHERE (
            pt.model = REGEXP_REPLACE(COALESCE(nm.usage->>'model', ''), '^~', '')
            OR pt.model = REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(nm.usage->>'model', ''), '^~', ''), '^[^/]+/', '')
            OR pt.model = REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(nm.usage->>'model', ''), '^~', ''), '^.*/', '')
            OR pt.model = REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(nm.usage->>'model', ''), '^~', ''), '^[^/]+/', ''), '.', '-')
            OR pt.model = REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(nm.usage->>'model', ''), '^~', ''), '^.*/', ''), '.', '-')
          )
            AND pt.effective_from <= nm.raw_timestamp::date
            AND (pt.effective_to IS NULL OR pt.effective_to >= nm.raw_timestamp::date)
          ORDER BY
            CASE
              WHEN pt.model = REGEXP_REPLACE(COALESCE(nm.usage->>'model', ''), '^~', '') THEN 0
              WHEN pt.model = REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(nm.usage->>'model', ''), '^~', ''), '^[^/]+/', '') THEN 1
              WHEN pt.model = REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(nm.usage->>'model', ''), '^~', ''), '^.*/', '') THEN 2
              WHEN pt.model = REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(nm.usage->>'model', ''), '^~', ''), '^[^/]+/', ''), '.', '-') THEN 3
              WHEN pt.model = REPLACE(REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(nm.usage->>'model', ''), '^~', ''), '^.*/', ''), '.', '-') THEN 4
              ELSE 5
            END,
            pt.effective_from DESC
          LIMIT 1
        ) p ON true
        WHERE ${whereClause}
      )
      UPDATE normalized_messages nm
      SET cost_usd = COALESCE(matched.cost, 0),
          pricing_id = matched.pricing_id
      FROM matched
      WHERE nm.id = matched.id
        AND (nm.cost_usd IS DISTINCT FROM COALESCE(matched.cost, 0)
             OR nm.pricing_id IS DISTINCT FROM matched.pricing_id)
    `);

    const duration = Date.now() - startTime;
    logger.info({ from, to, durationMs: duration, rows: result.length }, 'Cost recompute done');
    return NextResponse.json({
      success: true,
      durationMs: duration,
      from: from ?? null,
      to: to ?? null,
    });
  } catch (error) {
    logger.error({ error }, 'Cost recompute failed');
    return NextResponse.json({ error: 'Recompute failed' }, { status: 500 });
  }
}
