import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { users, machines, auditLogs } from '@/lib/db/schema';
import { getSession } from '@/lib/auth/session';
import { hasRole } from '@/lib/auth/roles';
import { hashPassword } from '@/lib/auth/password';
import { logger } from '@/lib/logger';
import { eq, count, sql } from 'drizzle-orm';

// Create User schema
const createUserSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(6, 'Password at least 6 bit'),
  name: z.string().optional(),
  role: z.enum(['super_admin', 'admin', 'viewer']).default('viewer'),
});

// GET /api/users — User List
export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'not_logged_in' }, { status: 401 });
    }
    if (!hasRole(session.role, 'super_admin')) {
      logger.warn({ userId: session.userId, role: session.role }, 'Non super_admin Attempt to access User Management');
      return NextResponse.json({ error: 'Insufficient Permissions' }, { status: 403 });
    }

    // Query user list,Number of devices included
    const userList = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
        deviceCount: sql<number>`(SELECT COUNT(*) FROM machines WHERE machines.owner_id = ${users.id})`.as('device_count'),
      })
      .from(users)
      .orderBy(users.createdAt);

    logger.debug({ count: userList.length }, 'User List Query Complete');

    return NextResponse.json({ data: userList });
  } catch (error) {
    logger.error({ error }, 'User list query exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

// POST /api/users — Create User
export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'not_logged_in' }, { status: 401 });
    }
    if (!hasRole(session.role, 'super_admin')) {
      logger.warn({ userId: session.userId, role: session.role }, 'Non super_admin Attempt to create a user');
      return NextResponse.json({ error: 'Insufficient Permissions' }, { status: 403 });
    }

    const body = await request.json();
    const data = createUserSchema.parse(body);

    // Check if the mailbox already exists
    const existing = await db.query.users.findFirst({
      where: eq(users.email, data.email),
    });
    if (existing) {
      return NextResponse.json({ error: 'email already in use' }, { status: 409 });
    }

    // Create User
    const passwordHash = hashPassword(data.password);
    const [newUser] = await db
      .insert(users)
      .values({
        email: data.email,
        name: data.name,
        role: data.role,
        passwordHash,
      })
      .returning({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        createdAt: users.createdAt,
      });

    // Audit Logging
    await db.insert(auditLogs).values({
      userId: session.userId,
      action: 'user.create',
      targetType: 'user',
      targetId: newUser.id,
      details: {
        email: data.email,
        role: data.role,
        operatorEmail: session.email,
      },
    });

    logger.info(
      { newUserId: newUser.id, email: data.email, role: data.role, operatorId: session.userId },
      'User Created Successfully',
    );

    return NextResponse.json({ data: newUser }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Request param is invalid', details: error.issues },
        { status: 400 },
      );
    }
    logger.error({ error }, 'User Creation Exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
