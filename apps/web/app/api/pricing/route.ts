import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { pricingTable, auditLogs } from '@/lib/db/schema';
import { getSession } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/roles';
import { logger } from '@/lib/logger';
import { eq, desc } from 'drizzle-orm';
import { ensurePricingSyncSchema } from '@/lib/db/pricing-sync-schema';

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

    await ensurePricingSyncSchema();

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

    await ensurePricingSyncSchema();

    const body = await request.json();
    const data = pricingSchema.parse(body);

    const existingModel = await db.query.pricingTable.findFirst({
      where: eq(pricingTable.model, data.model),
    });
    if (existingModel) {
      return NextResponse.json(
        { error: `Model "${data.model}" already exists. Model name must be unique.` },
        { status: 409 },
      );
    }

    const [savedRecord] = await db
      .insert(pricingTable)
      .values({
        model: data.model,
        provider: data.provider,
        inputPricePerMtok: data.inputPricePerMtok,
        outputPricePerMtok: data.outputPricePerMtok,
        cachePricePerMtok: data.cachePricePerMtok ?? null,
        effectiveFrom: data.effectiveFrom,
        effectiveTo: data.effectiveTo ?? null,
        syncSource: 'manual',
        syncLocked: true,
        lastSyncedAt: null,
      })
      .returning();

    let auditLogged = false;
    try {
      await db.insert(auditLogs).values({
        userId: session.userId,
        action: 'pricing_create',
        targetType: 'pricing',
        targetId: savedRecord.id,
        details: {
          model: data.model,
          provider: data.provider,
          effectiveFrom: data.effectiveFrom,
        },
      });
      auditLogged = true;
    } catch (auditError) {
      logger.warn(
        {
          userId: session.userId,
          error: auditError instanceof Error ? { name: auditError.name, message: auditError.message } : String(auditError),
        },
        'Pricing table create audit log failed',
      );
    }

    logger.info(
      { model: data.model, provider: data.provider, userId: session.userId, auditLogged },
      'Pricing Table New Record',
    );

    return NextResponse.json(
      {
        data: savedRecord,
        auditLogged,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Logic check failed.', details: error.issues }, { status: 400 });
    }
    const pgCode = (error as { cause?: { code?: string } }).cause?.code;
    if (pgCode === '23505') {
      return NextResponse.json({ error: 'Model name already exists. Please use a different model name.' }, { status: 409 });
    }
    if (pgCode === '22003') {
      return NextResponse.json({ error: 'Price is out of range. Max value is 999999.9999.' }, { status: 400 });
    }
    logger.error({ error }, 'Pricing table creation exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
