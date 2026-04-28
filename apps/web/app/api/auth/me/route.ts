import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'not_logged_in' }, { status: 401 });
  }

  const [user] = await db
    .select({
      name: users.name,
      email: users.email,
    })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  return NextResponse.json({
    user: {
      id: session.userId,
      email: user?.email ?? session.email,
      name: user?.name ?? null,
      role: session.role,
    },
  });
}
