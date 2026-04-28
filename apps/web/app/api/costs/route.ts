import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { getSession } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/roles';
import { logger } from '@/lib/logger';
import { sql } from 'drizzle-orm';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expect yyyy-MM-dd');
const querySchema = z.object({
  from: dateStr,
  to: dateStr,
  groupBy: z.enum(['user', 'device', 'tool', 'model']).default('tool'),
});

// TARIFF METERING SQL fragment(Multiple queries)
const costExpr = sql`
  COALESCE((nm.usage->>'inputTokens')::numeric, 0) / 1000000 * COALESCE(p.input_price_per_mtok, 0) +
  COALESCE((nm.usage->>'outputTokens')::numeric, 0) / 1000000 * COALESCE(p.output_price_per_mtok, 0) +
  (COALESCE((nm.usage->>'cacheCreationInputTokens')::numeric, 0) +
   COALESCE((nm.usage->>'cacheReadInputTokens')::numeric, 0)
  ) / 1000000 * COALESCE(p.cache_price_per_mtok, 0)
`;

// pricing LATERAL JOIN fragment(Compatible provider/model Format and dot/hyphen Difference)
const pricingJoin = sql`
  LEFT JOIN LATERAL (
    SELECT input_price_per_mtok, output_price_per_mtok, cache_price_per_mtok
    FROM pricing_table pt
    WHERE (
      pt.model = nm.usage->>'model'
      OR pt.model = REGEXP_REPLACE(nm.usage->>'model', '^[^/]+/', '')
      OR pt.model = REPLACE(REGEXP_REPLACE(nm.usage->>'model', '^[^/]+/', ''), '.', '-')
    )
      AND pt.effective_from <= nm.raw_timestamp::date
      AND (pt.effective_to IS NULL OR pt.effective_to >= nm.raw_timestamp::date)
    ORDER BY pt.effective_from DESC LIMIT 1
  ) p ON true
`;

// GET /api/costs — Expense Summary(Direct from normalized_messages Real-time calculation,Do not rely on daily_stats Aggregation)
export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'not_logged_in' }, { status: 401 });
    }
    if (!hasRole(session.role, 'admin')) {
      return NextResponse.json({ error: 'Insufficient Permissions' }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const params = querySchema.parse({
      from: searchParams.get('from') ?? undefined,
      to: searchParams.get('to') ?? undefined,
      groupBy: searchParams.get('groupBy') ?? undefined,
    });

    const startTime = Date.now();

    const rangeStart = new Date(`${params.from}T00:00:00`);
    const rangeEnd = new Date(`${params.to}T23:59:59.999`);
    const rangeStartIso = rangeStart.toISOString();
    const rangeEndIso = rangeEnd.toISOString();

    // Execute all queries in parallel
    const [summaryRows, trendRows, rankingRows, modelDistRows, tokenTrendRows, costTrendRows] = await Promise.all([
      // 1. SUMMARY STATISTICS
      db.execute(sql`
        SELECT
          COALESCE(SUM(${costExpr}), 0)::text as total_cost,
          COALESCE(SUM(COALESCE((nm.usage->>'inputTokens')::bigint, 0)), 0)::text as total_input_tokens,
          COALESCE(SUM(COALESCE((nm.usage->>'outputTokens')::bigint, 0)), 0)::text as total_output_tokens,
          COALESCE(SUM(
            COALESCE((nm.usage->>'cacheCreationInputTokens')::bigint, 0) +
            COALESCE((nm.usage->>'cacheReadInputTokens')::bigint, 0)
          ), 0)::text as total_cache_tokens,
          COUNT(*)::text as total_messages
        FROM normalized_messages nm
        ${pricingJoin}
        WHERE nm.usage IS NOT NULL
          AND nm.raw_timestamp >= ${rangeStartIso}
          AND nm.raw_timestamp <= ${rangeEndIso}
      `),

      // 2. Trend data(Day-level time series)
      db.execute(sql`
        SELECT
          TO_CHAR(nm.raw_timestamp, 'YYYY-MM-DD') as day,
          nm.source_tool as source_tool,
          COALESCE(SUM(${costExpr}), 0)::text as cost,
          COALESCE(SUM(
            COALESCE((nm.usage->>'inputTokens')::bigint, 0) +
            COALESCE((nm.usage->>'outputTokens')::bigint, 0)
          ), 0)::text as tokens
        FROM normalized_messages nm
        ${pricingJoin}
        WHERE nm.usage IS NOT NULL
          AND nm.raw_timestamp >= ${rangeStartIso}
          AND nm.raw_timestamp <= ${rangeEndIso}
        GROUP BY TO_CHAR(nm.raw_timestamp, 'YYYY-MM-DD'), nm.source_tool
        ORDER BY day
      `),

      // 3. Ranking Data(according groupBy Dimension)
      (() => {
        switch (params.groupBy) {
          case 'user':
            return db.execute(sql`
              SELECT
                m.owner_id::text as id,
                COALESCE(u.name, u.email, 'Undistributed') as name,
                COALESCE(SUM(${costExpr}), 0)::text as cost,
                COALESCE(SUM(
                  COALESCE((nm.usage->>'inputTokens')::bigint, 0) +
                  COALESCE((nm.usage->>'outputTokens')::bigint, 0)
                ), 0)::text as tokens,
                COUNT(*)::text as messages
              FROM normalized_messages nm
              JOIN machines m ON nm.machine_id = m.id
              LEFT JOIN users u ON m.owner_id = u.id
              ${pricingJoin}
              WHERE nm.usage IS NOT NULL
                AND nm.raw_timestamp >= ${rangeStartIso}
          AND nm.raw_timestamp <= ${rangeEndIso}
              GROUP BY m.owner_id, u.name, u.email
              ORDER BY SUM(${costExpr}) DESC
              LIMIT 20
            `);
          case 'device':
            return db.execute(sql`
              SELECT
                nm.machine_id::text as id,
                COALESCE(m.display_name, m.fingerprint) as name,
                COALESCE(SUM(${costExpr}), 0)::text as cost,
                COALESCE(SUM(
                  COALESCE((nm.usage->>'inputTokens')::bigint, 0) +
                  COALESCE((nm.usage->>'outputTokens')::bigint, 0)
                ), 0)::text as tokens,
                COUNT(*)::text as messages
              FROM normalized_messages nm
              LEFT JOIN machines m ON nm.machine_id = m.id
              ${pricingJoin}
              WHERE nm.usage IS NOT NULL
                AND nm.raw_timestamp >= ${rangeStartIso}
          AND nm.raw_timestamp <= ${rangeEndIso}
              GROUP BY nm.machine_id, m.display_name, m.fingerprint
              ORDER BY SUM(${costExpr}) DESC
              LIMIT 20
            `);
          case 'model':
            return db.execute(sql`
              SELECT
                REGEXP_REPLACE(nm.usage->>'model', '^[^/]+/', '') as id,
                REGEXP_REPLACE(nm.usage->>'model', '^[^/]+/', '') as name,
                COALESCE(SUM(${costExpr}), 0)::text as cost,
                COALESCE(SUM(
                  COALESCE((nm.usage->>'inputTokens')::bigint, 0) +
                  COALESCE((nm.usage->>'outputTokens')::bigint, 0)
                ), 0)::text as tokens,
                COUNT(*)::text as messages
              FROM normalized_messages nm
              ${pricingJoin}
              WHERE nm.usage IS NOT NULL
                AND nm.raw_timestamp >= ${rangeStartIso}
          AND nm.raw_timestamp <= ${rangeEndIso}
              GROUP BY REGEXP_REPLACE(nm.usage->>'model', '^[^/]+/', '')
              ORDER BY SUM(${costExpr}) DESC
              LIMIT 20
            `);
          default: // tool
            return db.execute(sql`
              SELECT
                nm.source_tool as id,
                nm.source_tool as name,
                COALESCE(SUM(${costExpr}), 0)::text as cost,
                COALESCE(SUM(
                  COALESCE((nm.usage->>'inputTokens')::bigint, 0) +
                  COALESCE((nm.usage->>'outputTokens')::bigint, 0)
                ), 0)::text as tokens,
                COUNT(*)::text as messages
              FROM normalized_messages nm
              ${pricingJoin}
              WHERE nm.usage IS NOT NULL
                AND nm.raw_timestamp >= ${rangeStartIso}
          AND nm.raw_timestamp <= ${rangeEndIso}
              GROUP BY nm.source_tool
              ORDER BY SUM(${costExpr}) DESC
              LIMIT 20
            `);
        }
      })(),

      // 4. Model Distribution(For Ring Charts)
      db.execute(sql`
        SELECT
          REGEXP_REPLACE(nm.usage->>'model', '^[^/]+/', '') as model,
          COALESCE(SUM(${costExpr}), 0)::text as cost,
          COALESCE(SUM(
            COALESCE((nm.usage->>'inputTokens')::bigint, 0) +
            COALESCE((nm.usage->>'outputTokens')::bigint, 0)
          ), 0)::text as tokens
        FROM normalized_messages nm
        ${pricingJoin}
        WHERE nm.usage IS NOT NULL
          AND nm.raw_timestamp >= ${rangeStartIso}
          AND nm.raw_timestamp <= ${rangeEndIso}
        GROUP BY REGEXP_REPLACE(nm.usage->>'model', '^[^/]+/', '')
        ORDER BY SUM(${costExpr}) DESC
      `),

      // 5. Token Trending(day of)
      db.execute(sql`
        SELECT
          TO_CHAR(nm.raw_timestamp, 'YYYY-MM-DD') as day,
          COALESCE(SUM(COALESCE((nm.usage->>'inputTokens')::bigint, 0)), 0)::text as input_tokens,
          COALESCE(SUM(COALESCE((nm.usage->>'outputTokens')::bigint, 0)), 0)::text as output_tokens,
          COALESCE(SUM(COALESCE((nm.usage->>'cacheReadInputTokens')::bigint, 0)), 0)::text as cache_read_tokens,
          COALESCE(SUM(COALESCE((nm.usage->>'cacheCreationInputTokens')::bigint, 0)), 0)::text as cache_write_tokens,
          COALESCE(SUM(
            COALESCE((nm.usage->>'inputTokens')::bigint, 0) +
            COALESCE((nm.usage->>'outputTokens')::bigint, 0) +
            COALESCE((nm.usage->>'cacheReadInputTokens')::bigint, 0) +
            COALESCE((nm.usage->>'cacheCreationInputTokens')::bigint, 0)
          ), 0)::text as total_tokens
        FROM normalized_messages nm
        WHERE nm.usage IS NOT NULL
          AND nm.raw_timestamp >= ${rangeStartIso}
          AND nm.raw_timestamp <= ${rangeEndIso}
        GROUP BY TO_CHAR(nm.raw_timestamp, 'YYYY-MM-DD')
        ORDER BY day
      `),

      // 6. Prices trends(day of)
      db.execute(sql`
        SELECT
          TO_CHAR(nm.raw_timestamp, 'YYYY-MM-DD') as day,
          COALESCE(SUM(${costExpr}), 0)::text as cost
        FROM normalized_messages nm
        ${pricingJoin}
        WHERE nm.usage IS NOT NULL
          AND nm.raw_timestamp >= ${rangeStartIso}
          AND nm.raw_timestamp <= ${rangeEndIso}
        GROUP BY TO_CHAR(nm.raw_timestamp, 'YYYY-MM-DD')
        ORDER BY day
      `),
    ]);

    const summary = summaryRows[0] as Record<string, unknown> | undefined;
    const totalInput = Number(summary?.total_input_tokens ?? 0);
    const totalOutput = Number(summary?.total_output_tokens ?? 0);
    const totalCache = Number(summary?.total_cache_tokens ?? 0);
    const cacheHitRate = totalInput + totalCache > 0
      ? Number(((totalCache / (totalInput + totalCache)) * 100).toFixed(1))
      : 0;

    // Formatting trend data(snake_case → camelCase)
    const trend = (trendRows as Array<Record<string, unknown>>).map((row) => ({
      day: String(row.day),
      sourceTool: String(row.source_tool),
      cost: String(row.cost),
      tokens: Number(row.tokens),
    }));

    // Format ranking data
    const ranking = (rankingRows as Array<Record<string, unknown>>).map((row) => ({
      id: row.id != null ? String(row.id) : null,
      name: String(row.name ?? 'Unknown'),
      cost: String(row.cost),
      tokens: Number(row.tokens),
      messages: Number(row.messages),
    }));

    // Formatting model distribution data
    const modelDistribution = (modelDistRows as Array<Record<string, unknown>>).map((row) => ({
      model: row.model != null ? String(row.model) : null,
      cost: String(row.cost),
      tokens: Number(row.tokens),
    }));

    const tokenTrend = (tokenTrendRows as Array<Record<string, unknown>>).map((row) => ({
      day: String(row.day),
      totalTokens: Number(row.total_tokens ?? 0),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      cacheReadTokens: Number(row.cache_read_tokens ?? 0),
      cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
    }));

    const costTrend = (costTrendRows as Array<Record<string, unknown>>).map((row) => ({
      day: String(row.day),
      cost: Number(row.cost ?? 0),
    }));

    const queryDuration = Date.now() - startTime;

    if (queryDuration > 500) {
      logger.warn({ durationMs: queryDuration, from: params.from, to: params.to }, 'Expense query response exceeds 500ms');
    } else {
      logger.debug({ durationMs: queryDuration, from: params.from, to: params.to }, 'Expense Inquiry Complete');
    }

    return NextResponse.json({
      data: {
        summary: {
          totalCostUsd: Number(summary?.total_cost ?? 0),
          totalTokens: totalInput + totalOutput + totalCache,
          totalInputTokens: totalInput,
          totalOutputTokens: totalOutput,
          totalCacheTokens: totalCache,
          cacheHitRate,
          totalMessages: Number(summary?.total_messages ?? 0),
        },
        trend,
        tokenTrend,
        costTrend,
        ranking,
        modelDistribution,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid query parameters', details: error.issues }, { status: 400 });
    }
    logger.error({ error }, 'Expense statistics query exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
