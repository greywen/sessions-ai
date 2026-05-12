import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { normalizedMessages, machines, sessionFavorites } from '@/lib/db/schema';
import { getSession } from '@/lib/auth/session';
import { logger } from '@/lib/logger';
import { sql, eq, and, gte, lte, desc, count, min, max, countDistinct, inArray } from 'drizzle-orm';

// Query Parameter Verification
const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sourceTool: z.string().optional(),
  machineId: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  search: z.string().max(200).optional(),
  favorite: z.enum(['true', 'false']).optional(),
});

function extractTextFromUnknown(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => extractTextFromUnknown(item)).filter(Boolean).join(' ').trim();
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const candidates = [obj.content, obj.text, obj.value, obj.message];
    for (const candidate of candidates) {
      const text = extractTextFromUnknown(candidate);
      if (text) return text;
    }
  }
  return '';
}

function extractFirstMessagePreview(contentBlocks: unknown): string {
  if (!Array.isArray(contentBlocks) || contentBlocks.length === 0) return '';
  const text = contentBlocks
    .map((block) => extractTextFromUnknown(block))
    .filter(Boolean)
    .join('\n')
    .trim();
  if (!text) return '';
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

// GET /api/sessions — Sessions list(Preview with user info and first message)
export async function GET(request: Request) {
  try {
    // 1. Manage Background Authentication
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'not_logged_in' }, { status: 401 });
    }

    // 2. Parse Query Parameters
    const { searchParams } = new URL(request.url);
    const params = querySchema.parse({
      page: searchParams.get('page') ?? undefined,
      limit: searchParams.get('limit') ?? undefined,
      sourceTool: searchParams.get('sourceTool') ?? undefined,
      machineId: searchParams.get('machineId') ?? undefined,
      from: searchParams.get('from') ?? undefined,
      to: searchParams.get('to') ?? undefined,
      search: searchParams.get('search') ?? undefined,
      favorite: searchParams.get('favorite') ?? undefined,
    });

    const offset = (params.page - 1) * params.limit;

    // 3. Build Query Criteria
    const conditions = [];
    if (params.sourceTool) {
      conditions.push(eq(normalizedMessages.sourceTool, params.sourceTool));
    }
    if (params.machineId) {
      conditions.push(eq(normalizedMessages.machineId, params.machineId));
    }
    if (params.from) {
      conditions.push(gte(normalizedMessages.rawTimestamp, new Date(params.from)));
    }
    if (params.to) {
      conditions.push(lte(normalizedMessages.rawTimestamp, new Date(params.to)));
    }
    if (params.search) {
      // Search for keywords in conversation content(Inside content_blocks right of privacy JSON Search in text)
      conditions.push(
        sql`${normalizedMessages.contentBlocks}::text ILIKE ${'%' + params.search + '%'}`,
      );
    }
    if (params.favorite === 'true') {
      conditions.push(sql`
        EXISTS (
          SELECT 1
          FROM session_favorites sf
          WHERE sf.user_id = ${session.userId}
            AND sf.session_id = ${normalizedMessages.sessionId}
        )
      `);
    }
    if (params.favorite === 'false') {
      conditions.push(sql`
        NOT EXISTS (
          SELECT 1
          FROM session_favorites sf
          WHERE sf.user_id = ${session.userId}
            AND sf.session_id = ${normalizedMessages.sessionId}
        )
      `);
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // 4. Tekan session_id aggregate query
    const startTime = Date.now();

    const sessionsQuery = db
      .select({
        sessionId: normalizedMessages.sessionId,
        sourceTool: normalizedMessages.sourceTool,
        machineId: normalizedMessages.machineId,
        messageCount: count(normalizedMessages.id).as('message_count'),
        sessionTitle: sql<string | null>`MAX(NULLIF(${normalizedMessages.metadata}->>'sessionTitle', ''))`.as('session_title'),
        firstMessageAt: min(normalizedMessages.rawTimestamp).as('first_message_at'),
        lastMessageAt: max(normalizedMessages.rawTimestamp).as('last_message_at'),
        isFavorite: sql<boolean>`MAX(CASE WHEN ${sessionFavorites.id} IS NOT NULL THEN 1 ELSE 0 END) = 1`.as('is_favorite'),
      })
      .from(normalizedMessages)
      .leftJoin(
        sessionFavorites,
        and(
          eq(sessionFavorites.sessionId, normalizedMessages.sessionId),
          eq(sessionFavorites.userId, session.userId),
        ),
      )
      .where(whereClause)
      .groupBy(
        normalizedMessages.sessionId,
        normalizedMessages.sourceTool,
        normalizedMessages.machineId,
      )
      .orderBy(desc(max(normalizedMessages.rawTimestamp)))
      .limit(params.limit)
      .offset(offset);

    const sessions = await sessionsQuery;
    const [{ total }] = await db.select({
      total: countDistinct(normalizedMessages.sessionId).as('total'),
    })
      .from(normalizedMessages)
      .where(whereClause);

    // Get associated devices in parallel/User information + First message preview
    const machineIds = [...new Set(sessions.map((s) => s.machineId))];
    const sessionIds = sessions.map((s) => s.sessionId);

    // 6. Get connected device and user information
    const machineRows = machineIds.length > 0
      ? await db.select({
          id: machines.id,
          displayName: machines.displayName,
        })
          .from(machines)
          .where(inArray(machines.id, machineIds))
      : [];

    // 7. Get the first user message for each session(Prev)
    const firstMessages = sessionIds.length > 0
      ? await db.execute(sql`
          SELECT DISTINCT ON (session_id)
            session_id,
            content_blocks
          FROM normalized_messages
          WHERE session_id IN (${sql.join(sessionIds.map(id => sql`${id}`), sql`, `)})
            AND role = 'User'
          ORDER BY session_id, raw_timestamp ASC
        `)
      : [];

    let machineMap: Record<string, { displayName: string | null }> = {};
    for (const row of machineRows) {
      machineMap[row.id] = {
        displayName: row.displayName,
      };
    }

    let firstMessageMap: Record<string, string> = {};
    for (const row of firstMessages) {
      const sid = row.session_id as string;
      const preview = extractFirstMessagePreview(row.content_blocks);
      if (preview) firstMessageMap[sid] = preview;
    }

    // 8. Assembly response
    const enrichedSessions = sessions.map((s) => ({
      ...s,
      deviceName: machineMap[s.machineId]?.displayName ?? null,
      firstUserMessage: firstMessageMap[s.sessionId] ?? null,
      sessionTitle: typeof s.sessionTitle === 'string' ? s.sessionTitle : null,
      isFavorite: s.isFavorite,
    }));

    const queryDuration = Date.now() - startTime;
    if (queryDuration > 500) {
      logger.warn(
        { durationMs: queryDuration, params },
        'Session List Query Timeout',
      );
    }

    logger.debug(
      {
        resultCount: enrichedSessions.length,
        total,
        durationMs: queryDuration,
        params,
      },
      'Session List Query Complete',
    );

    return NextResponse.json({
      data: enrichedSessions,
      pagination: {
        page: params.page,
        limit: params.limit,
        total: Number(total),
        totalPages: Math.ceil(Number(total) / params.limit),
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid query parameters', details: error.issues },
        { status: 400 },
      );
    }
    logger.error({ error }, 'Session list query exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
