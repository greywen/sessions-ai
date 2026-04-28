import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { verifyPassword } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';
import { logger } from '@/lib/logger';

const loginSchema = z.object({
  account: z.string().min(1),
  password: z.string().min(1),
});

function normalizeAccount(input: string): string {
  const account = input.trim();
  if (account === 'admin') {
    return process.env.ADMIN_EMAIL || 'admin@llm-sessions.local';
  }
  if (!account.includes('@') && account.includes('/')) {
    return account;
  }
  if (!account.includes('@')) {
    return `${account}@llm-sessions.local`;
  }
  return account;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { account, password } = loginSchema.parse(body);
    const rawAccount = account.trim();
    const normalizedAccount = normalizeAccount(rawAccount);

    // Find Users: try raw account first, then normalized alias fallback
    let user = await db.query.users.findFirst({
      where: eq(users.email, rawAccount),
    });

    if (!user && normalizedAccount !== rawAccount) {
      user = await db.query.users.findFirst({
        where: eq(users.email, normalizedAccount),
      });
    }

    if (!user) {
      logger.info({ account: rawAccount, ip: request.headers.get('x-forwarded-for') }, 'Sign in failed: user not found');
      return NextResponse.json({ error: 'Email or password is incorrect' }, { status: 401 });
    }

    // Verify password
    if (!verifyPassword(password, user.passwordHash)) {
      logger.info({ account: rawAccount, resolvedEmail: user.email, ip: request.headers.get('x-forwarded-for') }, 'Sign in failed: incorrect password');
      return NextResponse.json({ error: 'Email or password is incorrect' }, { status: 401 });
    }

    // Create Session
    await createSession({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    logger.info(
      { account: rawAccount, resolvedEmail: user.email, role: user.role, ip: request.headers.get('x-forwarded-for'), ua: request.headers.get('user-agent') },
      'Logged in successfully',
    );

    return NextResponse.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
        return NextResponse.json({ error: 'Invalid login parameters' }, { status: 400 });
    }
    logger.error({ error }, 'Login exception');
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
