import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { normalizedMessages, machines, users } from '@/lib/db/schema';
import { getSession } from '@/lib/auth/session';
import { logger } from '@/lib/logger';
import { sql, eq, and, gte, lte, desc, count, min, max, countDistinct, inArray, like } from 'drizzle-orm';

// Query Parameter Verification
const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sourceTool: z.string().optional(),
  machineId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  search: z.string().max(200).optional(),
});

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
      userId: searchParams.get('userId') ?? undefined,
      from: searchParams.get('from') ?? undefined,
      to: searchParams.get('to') ?? undefined,
      search: searchParams.get('search') ?? undefined,
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
    if (params.userId) {
      // Find the associated device from the user
      const userMachines = await db
        .select({ id: machines.id })
        .from(machines)
        .where(eq(machines.ownerId, params.userId));
      const machineIds = userMachines.map((m) => m.id);
      if (machineIds.length > 0) {
        conditions.push(inArray(normalizedMessages.machineId, machineIds));
      } else {
        // This user does not have a device,Back to empty results
        return NextResponse.json({
          data: [],
          pagination: { page: params.page, limit: params.limit, total: 0, totalPages: 0 },
        });
      }
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

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // 4. Tekan session_id aggregate query
    const startTime = Date.now();

    const sessionsQuery = db
      .select({
        sessionId: normalizedMessages.sessionId,
        sourceTool: normalizedMessages.sourceTool,
        machineId: normalizedMessages.machineId,
        messageCount: count(normalizedMessages.id).as('message_count'),
        firstMessageAt: min(normalizedMessages.rawTimestamp).as('first_message_at'),
        lastMessageAt: max(normalizedMessages.rawTimestamp).as('last_message_at'),
      })
      .from(normalizedMessages)
      .where(whereClause)
      .groupBy(
        normalizedMessages.sessionId,
        normalizedMessages.sourceTool,
        normalizedMessages.machineId,
      )
      .orderBy(desc(max(normalizedMessages.rawTimestamp)))
      .limit(params.limit)
      .offset(offset);

    // Parallel execution of session list and total queries
    const [sessions, [{ total }]] = await Promise.all([
      sessionsQuery,
      db.select({
        total: countDistinct(normalizedMessages.sessionId).as('total'),
      })
        .from(normalizedMessages)
        .where(whereClause),
    ]);

    // Get associated devices in parallel/User information + First message preview
    const machineIds = [...new Set(sessions.map((s) => s.machineId))];
    const sessionIds = sessions.map((s) => s.sessionId);

    const [machineRows, firstMessages] = await Promise.all([
      // 6. Get connected device and user information
      machineIds.length > 0
        ? db.select({
            id: machines.id,
            displayName: machines.displayName,
            ownerName: users.name,
            ownerEmail: users.email,
          })
            .from(machines)
            .leftJoin(users, eq(machines.ownerId, users.id))
            .where(inArray(machines.id, machineIds))
        : Promise.resolve([]),

      // 7. Get the first user message for each session(Prev)
      sessionIds.length > 0
        ? db.execute(sql`
            SELECT DISTINCT ON (session_id)
              session_id,
              content_blocks,
              metadata
            FROM normalized_messages
            WHERE session_id IN (${sql.join(sessionIds.map(id => sql`${id}`), sql`, `)})
              AND role = 'User'
            ORDER BY session_id, raw_timestamp ASC
          `)
        : Promise.resolve([]),
    ]);

    let machineMap: Record<string, { displayName: string | null; ownerName: string | null; ownerEmail: string | null }> = {};
    for (const row of machineRows) {
      machineMap[row.id] = {
        displayName: row.displayName,
        ownerName: row.ownerName,
        ownerEmail: row.ownerEmail,
      };
    }

    let firstMessageMap: Record<string, string> = {};
    let sessionTitleMap: Record<string, string> = {};
    for (const row of firstMessages) {
      const sid = row.session_id as string;
      const blocks = row.content_blocks as Array<{ blockType: string; content: string }> | null;
      if (blocks && blocks.length > 0) {
        const textBlock = blocks.find((b) => b.blockType === 'Text');
        firstMessageMap[sid] = (textBlock?.content ?? blocks[0]?.content ?? '').slice(0, 200);
      }
      const meta = row.metadata as Record<string, unknown> | null;
      const title = meta && typeof meta.sessionTitle === 'string' ? meta.sessionTitle : null;
      if (title && title.length > 0) sessionTitleMap[sid] = title;
    }

    // 8. Assembly response
    const enrichedSessions = sessions.map((s) => ({
      ...s,
      deviceName: machineMap[s.machineId]?.displayName ?? null,
      ownerName: machineMap[s.machineId]?.ownerName ?? null,
      ownerEmail: machineMap[s.machineId]?.ownerEmail ?? null,
      firstUserMessage: firstMessageMap[s.sessionId] ?? null,
      sessionTitle: sessionTitleMap[s.sessionId] ?? null,
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
