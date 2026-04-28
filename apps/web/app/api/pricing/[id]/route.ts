import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { pricingTable, auditLogs } from '@/lib/db/schema';
import { getSession } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/roles';
import { logger } from '@/lib/logger';
import { and, eq, ne } from 'drizzle-orm';
import { ensurePricingSyncSchema } from '@/lib/db/pricing-sync-schema';

const updateSchema = z.object({
  model: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  inputPricePerMtok: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
  outputPricePerMtok: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
  cachePricePerMtok: z.string().regex(/^\d+(\.\d{1,4})?$/).nullable().optional(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

// PATCH /api/pricing/[id] — Update pricing history
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'not_logged_in' }, { status: 401 });
    }
    if (!hasRole(session.role, 'admin')) {
      return NextResponse.json({ error: 'Insufficient Permissions' }, { status: 403 });
    }

    await ensurePricingSyncSchema();

    const { id } = await params;
    const body = await request.json();
    const data = updateSchema.parse(body);

    const existing = await db.query.pricingTable.findFirst({
      where: eq(pricingTable.id, id),
    });
    if (!existing) {
      return NextResponse.json({ error: 'Record not found' }, { status: 404 });
    }

    if (data.model !== undefined && data.model !== existing.model) {
      const conflict = await db.query.pricingTable.findFirst({
        where: and(
          eq(pricingTable.model, data.model),
          ne(pricingTable.id, id),
        ),
      });
      if (conflict) {
        return NextResponse.json(
          { error: `Model "${data.model}" already exists. Model name must be unique.` },
          { status: 409 },
        );
      }
    }

    const updateData: Record<string, unknown> = {};
    if (data.model !== undefined) updateData.model = data.model;
    if (data.provider !== undefined) updateData.provider = data.provider;
    if (data.inputPricePerMtok !== undefined) updateData.inputPricePerMtok = data.inputPricePerMtok;
    if (data.outputPricePerMtok !== undefined) updateData.outputPricePerMtok = data.outputPricePerMtok;
    if (data.cachePricePerMtok !== undefined) updateData.cachePricePerMtok = data.cachePricePerMtok;
    if (data.effectiveFrom !== undefined) updateData.effectiveFrom = data.effectiveFrom;
    if (data.effectiveTo !== undefined) updateData.effectiveTo = data.effectiveTo;
    updateData.syncSource = 'manual';
    updateData.syncLocked = true;

    const [updated] = await db
      .update(pricingTable)
      .set(updateData)
      .where(eq(pricingTable.id, id))
      .returning();

    let auditLogged = false;
    try {
      await db.insert(auditLogs).values({
        userId: session.userId,
        action: 'pricing_update',
        targetType: 'pricing',
        targetId: id,
        details: { model: updated.model, changes: Object.keys(data) },
      });
      auditLogged = true;
    } catch (auditError) {
      logger.warn(
        {
          userId: session.userId,
          pricingId: id,
          error: auditError instanceof Error ? { name: auditError.name, message: auditError.message } : String(auditError),
        },
        'Pricing table update audit log failed',
      );
    }

    logger.info(
      { pricingId: id, model: updated.model, userId: session.userId, auditLogged },
      'Pricing table update history',
    );

    return NextResponse.json({ data: updated, auditLogged });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Logic check failed.', details: error.issues }, { status: 400 });
    }
    const pgCode = (error as { cause?: { code?: string } }).cause?.code;
    if (pgCode === '23505') {
      return NextResponse.json({ error: 'Model name already exists. Please use a different model name.' }, { status: 409 });
    }
    logger.error({ error }, 'Pricing table update exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// DELETE /api/pricing/[id] — Delete Pricing Record
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'not_logged_in' }, { status: 401 });
    }
    if (!hasRole(session.role, 'admin')) {
      return NextResponse.json({ error: 'Insufficient Permissions' }, { status: 403 });
    }

    await ensurePricingSyncSchema();

    const { id } = await params;

    const existing = await db.query.pricingTable.findFirst({
      where: eq(pricingTable.id, id),
    });
    if (!existing) {
      return NextResponse.json({ error: 'Record not found' }, { status: 404 });
    }

    await db.delete(pricingTable).where(eq(pricingTable.id, id));

    let auditLogged = false;
    try {
      await db.insert(auditLogs).values({
        userId: session.userId,
        action: 'pricing_delete',
        targetType: 'pricing',
        targetId: id,
        details: { model: existing.model, provider: existing.provider },
      });
      auditLogged = true;
    } catch (auditError) {
      logger.warn(
        {
          userId: session.userId,
          pricingId: id,
          error: auditError instanceof Error ? { name: auditError.name, message: auditError.message } : String(auditError),
        },
        'Pricing table delete audit log failed',
      );
    }

    logger.info(
      { pricingId: id, model: existing.model, userId: session.userId, auditLogged },
      'Pricing Table Delete Record',
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error({ error }, 'Pricing table delete exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
