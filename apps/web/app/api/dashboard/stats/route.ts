import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { machines, normalizedMessages } from '@/lib/db/schema';
import { getSession } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/roles';
import { logger } from '@/lib/logger';
import { eq, sql, and, gte, lt, desc, count, countDistinct } from 'drizzle-orm';
// 物化列：cost_usd 已在 ingest 时落库（lib/cost/compute.ts），读侧直接 SUM。

const TOKEN_NUMERIC_REGEX = '^[0-9]+([.][0-9]+)?$';

function usageTokenAsNumeric(
  tableAlias: 'nm',
  field: 'inputTokens' | 'outputTokens' | 'cacheCreationInputTokens' | 'cacheReadInputTokens',
) {
  const usageValue = sql.raw(`${tableAlias}.usage->>'${field}'`);
  return sql`
    CASE
      WHEN COALESCE(${usageValue}, '') ~ ${TOKEN_NUMERIC_REGEX}
      THEN (${usageValue})::numeric
      ELSE 0
    END
  `;
}

const nmInputTokensExpr = usageTokenAsNumeric('nm', 'inputTokens');
const nmOutputTokensExpr = usageTokenAsNumeric('nm', 'outputTokens');
const nmCacheWriteTokensExpr = usageTokenAsNumeric('nm', 'cacheCreationInputTokens');
const nmCacheReadTokensExpr = usageTokenAsNumeric('nm', 'cacheReadInputTokens');

// Query Parameter Verification
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expect yyyy-MM-dd');
const querySchema = z.object({
  from: dateStr,
  to: dateStr,
});

function parseLocalDate(s: string): Date {
  return new Date(`${s}T00:00:00`);
}

function endOfDay(s: string): Date {
  const d = parseLocalDate(s);
  d.setHours(23, 59, 59, 999);
  return d;
}

// GET /api/dashboard/stats — Dashboard Stats
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
    });

    const startTime = Date.now();
    const now = new Date();

    const rangeStart = parseLocalDate(params.from);
    const rangeEnd = endOfDay(params.to);
    const rangeDurationMs = rangeEnd.getTime() - rangeStart.getTime();
    const prevRangeEnd = new Date(rangeStart);
    const prevRangeStart = new Date(rangeStart.getTime() - rangeDurationMs);

    // Parallel query current/Previous period statistics(Direct from normalized_messages,Do not rely on daily_stats Aggregation)
    const [currentStatsResult, prevStatsResult, activeDevicesResult, totalDevicesResult, toolDistResult, recentSessionsResult, tokenCostResult, prevTokenCostResult, tokenTrendResult, costTrendResult] = await Promise.all([
      // 1. Current Messages/Session Statistics
      db.select({
        messageCount: count(normalizedMessages.id).as('message_count'),
        sessionCount: countDistinct(normalizedMessages.sessionId).as('session_count'),
      })
        .from(normalizedMessages)
        .where(and(
          gte(normalizedMessages.rawTimestamp, rangeStart),
          lt(normalizedMessages.rawTimestamp, rangeEnd),
        )),

      // 2. Previous news/Session Statistics(MOM)
      db.select({
        messageCount: count(normalizedMessages.id).as('message_count'),
        sessionCount: countDistinct(normalizedMessages.sessionId).as('session_count'),
      })
        .from(normalizedMessages)
        .where(and(
          gte(normalizedMessages.rawTimestamp, prevRangeStart),
          lt(normalizedMessages.rawTimestamp, prevRangeEnd),
        )),

      // 3. Number of active devices(30s with a heartbeat in it.)
      db.select({ count: count() })
        .from(machines)
        .where(and(
          eq(machines.status, 'active'),
          gte(machines.lastSeenAt, new Date(now.getTime() - 30 * 1000)),
        )),

      // 4. Total number of devices registered
      db.select({ count: count() })
        .from(machines)
        .where(eq(machines.status, 'active')),

      // 5. Tool Distribution(Filter by timeframe)
      db.select({
        sourceTool: normalizedMessages.sourceTool,
        messageCount: count(normalizedMessages.id).as('message_count'),
      })
        .from(normalizedMessages)
        .where(and(
          gte(normalizedMessages.rawTimestamp, rangeStart),
          lt(normalizedMessages.rawTimestamp, rangeEnd),
        ))
        .groupBy(normalizedMessages.sourceTool)
        .orderBy(desc(count(normalizedMessages.id))),

      // 6. Recently Active Sessions Top 10(Filter by timeframe)
      db.select({
        sessionId: normalizedMessages.sessionId,
        sourceTool: normalizedMessages.sourceTool,
        machineId: normalizedMessages.machineId,
        messageCount: count(normalizedMessages.id).as('message_count'),
        lastMessageAt: sql<Date>`MAX(${normalizedMessages.rawTimestamp})`.as('last_message_at'),
      })
        .from(normalizedMessages)
        .where(and(
          gte(normalizedMessages.rawTimestamp, rangeStart),
          lt(normalizedMessages.rawTimestamp, rangeEnd),
        ))
        .groupBy(
          normalizedMessages.sessionId,
          normalizedMessages.sourceTool,
          normalizedMessages.machineId,
        )
        .orderBy(desc(sql`MAX(${normalizedMessages.rawTimestamp})`))
        .limit(10),

      // 7. Token + Real-time cost statistics(Direct from normalized_messages Calculation)
      db.execute(sql`
        SELECT
          COALESCE(SUM(${nmInputTokensExpr}), 0) as total_input_tokens,
          COALESCE(SUM(${nmOutputTokensExpr}), 0) as total_output_tokens,
          COALESCE(SUM(${nmCacheWriteTokensExpr}), 0) as cache_write_tokens,
          COALESCE(SUM(${nmCacheReadTokensExpr}), 0) as cache_read_tokens,
          COALESCE(SUM(nm.cost_usd), 0) as total_cost
        FROM normalized_messages nm
        WHERE nm.usage IS NOT NULL
          AND nm.raw_timestamp >= ${rangeStart.toISOString()}
          AND nm.raw_timestamp < ${rangeEnd.toISOString()}
      `),

      // 8. the previous Token + Expense Summary(MOM)
      db.execute(sql`
        SELECT
          COALESCE(SUM(nm.cost_usd), 0) as total_cost
        FROM normalized_messages nm
        WHERE nm.usage IS NOT NULL
          AND nm.raw_timestamp >= ${prevRangeStart.toISOString()}
          AND nm.raw_timestamp < ${prevRangeEnd.toISOString()}
      `),

      // 9. Token Usage Trend(Setiap Hari)
      db.execute(sql`
        SELECT
          TO_CHAR(nm.raw_timestamp, 'YYYY-MM-DD') as day,
          COALESCE(SUM(
            ${nmInputTokensExpr} +
            ${nmOutputTokensExpr} +
            ${nmCacheReadTokensExpr} +
            ${nmCacheWriteTokensExpr}
          ), 0) as total_tokens,
          COALESCE(SUM(${nmInputTokensExpr}), 0) as input_tokens,
          COALESCE(SUM(${nmOutputTokensExpr}), 0) as output_tokens,
          COALESCE(SUM(${nmCacheReadTokensExpr}), 0) as cache_read_tokens,
          COALESCE(SUM(${nmCacheWriteTokensExpr}), 0) as cache_write_tokens
        FROM normalized_messages nm
        WHERE nm.usage IS NOT NULL
          AND nm.raw_timestamp >= ${rangeStart.toISOString()}
          AND nm.raw_timestamp < ${rangeEnd.toISOString()}
        GROUP BY TO_CHAR(nm.raw_timestamp, 'YYYY-MM-DD')
        ORDER BY day
      `),

      // 10. Prices trends(Setiap Hari)
      db.execute(sql`
        SELECT
          TO_CHAR(nm.raw_timestamp, 'YYYY-MM-DD') as day,
          COALESCE(SUM(nm.cost_usd), 0) as cost
        FROM normalized_messages nm
        WHERE nm.usage IS NOT NULL
          AND nm.raw_timestamp >= ${rangeStart.toISOString()}
          AND nm.raw_timestamp < ${rangeEnd.toISOString()}
        GROUP BY TO_CHAR(nm.raw_timestamp, 'YYYY-MM-DD')
        ORDER BY day
      `),
    ]);

    const currentStats = currentStatsResult[0];
    const prevStats = prevStatsResult[0];

    // Token + Fee lines data.
    const tokenCost = tokenCostResult[0] as Record<string, unknown> | undefined;
    const prevTokenCost = prevTokenCostResult[0] as Record<string, unknown> | undefined;

    // Calculate MoM Growth
    const currentMsgCount = Number(currentStats?.messageCount ?? 0);
    const prevMsgCount = Number(prevStats?.messageCount ?? 0);
    const currentSessionCount = Number(currentStats?.sessionCount ?? 0);
    const prevSessionCount = Number(prevStats?.sessionCount ?? 0);
    const currentCost = Number(tokenCost?.total_cost ?? 0);
    const prevCost = Number(prevTokenCost?.total_cost ?? 0);

    const inputTokens = Number(tokenCost?.total_input_tokens ?? 0);
    const outputTokens = Number(tokenCost?.total_output_tokens ?? 0);
    const cacheReadTokens = Number(tokenCost?.cache_read_tokens ?? 0);
    const cacheWriteTokens = Number(tokenCost?.cache_write_tokens ?? 0);
    const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

    const calcGrowth = (current: number, previous: number) => {
      if (previous === 0) return current > 0 ? 100 : 0;
      return Number((((current - previous) / previous) * 100).toFixed(1));
    };

    // Token Trend data formatting
    const tokenTrend = (tokenTrendResult as Array<Record<string, unknown>>).map((row) => ({
      day: String(row.day),
      totalTokens: Number(row.total_tokens ?? 0),
      inputTokens: Number(row.input_tokens ?? 0),
      outputTokens: Number(row.output_tokens ?? 0),
      cacheReadTokens: Number(row.cache_read_tokens ?? 0),
      cacheWriteTokens: Number(row.cache_write_tokens ?? 0),
    }));

    const costTrend = (costTrendResult as Array<Record<string, unknown>>).map((row) => ({
      day: String(row.day),
      cost: Number(row.cost ?? 0),
    }));

    const queryDuration = Date.now() - startTime;
    logger.debug(
      { from: params.from, to: params.to, durationMs: queryDuration },
      'Dashboard Statistics Query Complete',
    );

    return NextResponse.json({
      data: {
        activeDevices: activeDevicesResult[0]?.count ?? 0,
        totalDevices: totalDevicesResult[0]?.count ?? 0,
        sessionCount: currentSessionCount,
        messageCount: currentMsgCount,
        totalCostUsd: currentCost,
        totalTokens,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        growth: {
          sessions: calcGrowth(currentSessionCount, prevSessionCount),
          messages: calcGrowth(currentMsgCount, prevMsgCount),
          cost: calcGrowth(currentCost, prevCost),
        },
        toolDistribution: toolDistResult,
        recentSessions: recentSessionsResult,
        tokenTrend,
        costTrend,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid query parameters', details: error.issues },
        { status: 400 },
      );
    }
    logger.error({ error }, 'Dashboard Statistics Query Exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
