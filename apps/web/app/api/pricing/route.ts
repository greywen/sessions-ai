import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { pricingTable, auditLogs } from '@/lib/db/schema';
import { getSession } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/roles';
import { logger } from '@/lib/logger';
import { eq, desc } from 'drizzle-orm';

// Buat/Update pricing history schema
const pricingSchema = z.object({
  model: z.string().min(1, 'Model name cannot be empty'),
  provider: z.string().min(1, 'Provider cannot be empty'),
  inputPricePerMtok: z.string().regex(/^\d+(\.\d{1,4})?$/, 'Invalid price format'),
  outputPricePerMtok: z.string().regex(/^\d+(\.\d{1,4})?$/, 'Invalid price format'),
  cachePricePerMtok: z.string().regex(/^\d+(\.\d{1,4})?$/, 'Invalid price format').nullable().optional(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'The date format is not valid (YYYY-MM-DD)'),
  effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'The date format is not valid').nullable().optional(),
});

// GET /api/pricing — Pricing Table List
export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'not_logged_in' }, { status: 401 });
    }
    if (!hasRole(session.role, 'admin')) {
      return NextResponse.json({ error: 'Insufficient Permissions' }, { status: 403 });
    }

    const list = await db
      .select()
      .from(pricingTable)
      .orderBy(desc(pricingTable.effectiveFrom), pricingTable.provider, pricingTable.model);

    logger.debug({ count: list.length }, 'Pricing Table List Query Complete');
    return NextResponse.json({ data: list });
  } catch (error) {
    logger.error({ error }, 'Pricing table list query exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// POST /api/pricing — New Pricing Record
export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'not_logged_in' }, { status: 401 });
    }
    if (!hasRole(session.role, 'admin')) {
      return NextResponse.json({ error: 'Insufficient Permissions' }, { status: 403 });
    }

    const body = await request.json();
    const data = pricingSchema.parse(body);

    const [newRecord] = await db
      .insert(pricingTable)
      .values({
        model: data.model,
        provider: data.provider,
        inputPricePerMtok: data.inputPricePerMtok,
        outputPricePerMtok: data.outputPricePerMtok,
        cachePricePerMtok: data.cachePricePerMtok ?? null,
        effectiveFrom: data.effectiveFrom,
        effectiveTo: data.effectiveTo ?? null,
      })
      .returning();

    // Audit Logging
    await db.insert(auditLogs).values({
      userId: session.userId,
      action: 'pricing_create',
      targetType: 'pricing',
      targetId: newRecord.id,
      details: { model: data.model, provider: data.provider },
    });

    logger.info(
      { model: data.model, provider: data.provider, userId: session.userId },
      'Pricing Table New Record',
    );

    return NextResponse.json({ data: newRecord }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Logic check failed.', details: error.issues }, { status: 400 });
    }
    logger.error({ error }, 'Pricing table creation exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
