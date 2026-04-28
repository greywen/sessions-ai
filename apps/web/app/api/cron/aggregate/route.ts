import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { sql } from 'drizzle-orm';

// POST /api/cron/aggregate — Cost Aggregation Tasks(By pg_cron or external scheduler call)
// It can also be triggered manually by an administrator
// Safety:Setuju CRON_SECRET or Admin session Authentication
export async function POST(request: Request) {
  try {
    // Authentication:CRON_SECRET or Admin session
    const cronSecret = request.headers.get('x-cron-secret');
    const expectedSecret = process.env.CRON_SECRET || 'sessions-ai-cron-secret';

    if (cronSecret !== expectedSecret) {
      // Try Admin session Authentication
      const { getSession } = await import('@/lib/auth/session');
      const { hasRole } = await import('@/lib/auth/roles');
      const session = await getSession();
      if (!session || !hasRole(session.role, 'admin')) {
        return NextResponse.json({ error: 'Not Authorised' }, { status: 401 });
      }
    }

    const startTime = Date.now();

    // Perform aggregation:FROM normalized_messages Aggregate to daily_stats
    // Cost Formula:(input_tokens/1M × input_price) + (output_tokens/1M × output_price) + (cache_tokens/1M × cache_price)
    await db.execute(sql`
      INSERT INTO daily_stats (day, machine_id, owner_id, source_tool, model,
        message_count, session_count, total_input_tokens, total_output_tokens,
        total_cache_tokens, estimated_cost_usd)
      SELECT
        CURRENT_DATE AS day,
        nm.machine_id,
        m.owner_id,
        nm.source_tool,
        nm.usage->>'model' AS model,
        COUNT(*) AS message_count,
        COUNT(DISTINCT nm.session_id) AS session_count,
        COALESCE(SUM((nm.usage->>'inputTokens')::bigint), 0) AS total_input_tokens,
        COALESCE(SUM((nm.usage->>'outputTokens')::bigint), 0) AS total_output_tokens,
        COALESCE(SUM(
          COALESCE((nm.usage->>'cacheCreationInputTokens')::bigint, 0) +
          COALESCE((nm.usage->>'cacheReadInputTokens')::bigint, 0)
        ), 0) AS total_cache_tokens,
        COALESCE(SUM(nm.cost_usd), 0) AS estimated_cost_usd
      FROM normalized_messages nm
      JOIN machines m ON nm.machine_id = m.id
      WHERE nm.created_at >= CURRENT_DATE
        AND nm.usage IS NOT NULL
        AND nm.usage->>'model' IS NOT NULL
      GROUP BY 1, 2, 3, 4, 5
      ON CONFLICT (day, machine_id, source_tool, model)
      DO UPDATE SET
        owner_id = EXCLUDED.owner_id,
        message_count = EXCLUDED.message_count,
        session_count = EXCLUDED.session_count,
        total_input_tokens = EXCLUDED.total_input_tokens,
        total_output_tokens = EXCLUDED.total_output_tokens,
        total_cache_tokens = EXCLUDED.total_cache_tokens,
        estimated_cost_usd = EXCLUDED.estimated_cost_usd
    `);

    const duration = Date.now() - startTime;

    logger.info(
      { durationMs: duration },
      'Expense Aggregation Task Execution Complete',
    );

    return NextResponse.json({
      success: true,
      durationMs: duration,
    });
  } catch (error) {
    logger.error({ error }, 'Fee Aggregation Task Failed');
    return NextResponse.json({ error: 'Aggregation task failed' }, { status: 500 });
  }
}
