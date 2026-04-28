import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { users, machines, auditLogs } from '@/lib/db/schema';
import { getSession } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/roles';
import { hashPassword } from '@/lib/auth/password';
import { logger } from '@/lib/logger';
import { eq } from 'drizzle-orm';

// Update User schema
const patchSchema = z.object({
  role: z.enum(['super_admin', 'admin', 'viewer']).optional(),
  password: z.string().min(6, 'Password at least 6 bit').optional(),
  name: z.string().optional(),
}).refine((data) => data.role || data.password || data.name, {
  message: 'Specify at least one field to update',
});

// PATCH /api/users/[id] — Update User
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'not_logged_in' }, { status: 401 });
    }
    if (!hasRole(session.role, 'super_admin')) {
      return NextResponse.json({ error: 'Insufficient Permissions' }, { status: 403 });
    }

    const { id } = await params;
    const body = await request.json();
    const data = patchSchema.parse(body);

    // Find Users
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    if (!user) {
      return NextResponse.json({ error: 'Pengguna tidak ada' }, { status: 404 });
    }

    // Build update data
    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    const auditDetails: Record<string, unknown> = { operatorEmail: session.email };

    if (data.role) {
      auditDetails.oldRole = user.role;
      auditDetails.newRole = data.role;
      updateData.role = data.role;
    }
    if (data.password) {
      updateData.passwordHash = hashPassword(data.password);
      auditDetails.passwordChanged = true;
    }
    if (data.name !== undefined) {
      auditDetails.oldName = user.name;
      auditDetails.newName = data.name;
      updateData.name = data.name;
    }

    await db.update(users).set(updateData).where(eq(users.id, id));

    // Audit Logging
    await db.insert(auditLogs).values({
      userId: session.userId,
      action: 'user.update',
      targetType: 'user',
      targetId: id,
      details: auditDetails,
    });

    logger.info(
      { targetUserId: id, email: user.email, changes: Object.keys(data), operatorId: session.userId },
      'User successfully updated.',
    );

    // Back to Updated Users
    const [updated] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    return NextResponse.json({ data: updated });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Request param is invalid', details: error.issues },
        { status: 400 },
      );
    }
    logger.error({ error }, 'User update exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// DELETE /api/users/[id] — Delete User(Unbind Device + Mark for deletion)
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'not_logged_in' }, { status: 401 });
    }
    if (!hasRole(session.role, 'super_admin')) {
      return NextResponse.json({ error: 'Insufficient Permissions' }, { status: 403 });
    }

    const { id } = await params;

    // User is not allowed to delete himself.
    if (id === session.userId) {
      return NextResponse.json({ error: 'Cannot delete own account' }, { status: 400 });
    }

    // Find Users
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Unbind Device
    await db
      .update(machines)
      .set({ ownerId: null, updatedAt: new Date() })
      .where(eq(machines.ownerId, id));

    // Delete User
    await db.delete(users).where(eq(users.id, id));

    // Audit Logging
    await db.insert(auditLogs).values({
      userId: session.userId,
      action: 'user.delete',
      targetType: 'user',
      targetId: id,
      details: {
        email: user.email,
        role: user.role,
        operatorEmail: session.email,
      },
    });

    logger.info(
      { deletedUserId: id, email: user.email, operatorId: session.userId },
      '%s user removed successfully',
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error({ error }, 'User deletion exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
