import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';
import { logger } from '@/lib/logger';

const loginSchema = z.object({
  account: z.string().min(1),
  password: z.string().min(1),
});

const DEFAULT_LOGIN_USERNAME = 'sessions-ai';
const DEFAULT_LOGIN_PASSWORD = '123456';
const DEFAULT_LOGIN_EMAIL_DOMAIN = 'sessions-ai.local';
const DEFAULT_LOGIN_EMAIL_ALIAS = `${DEFAULT_LOGIN_USERNAME}@${DEFAULT_LOGIN_EMAIL_DOMAIN}`;
const LEGACY_ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@sessions-ai.local';

function toUsernameEmail(username: string): string {
  return `${username}@${DEFAULT_LOGIN_EMAIL_DOMAIN}`;
}

function resolveAccountEmails(input: string): string[] {
  const account = input.trim();
  if (!account) {
    return [];
  }

  // Canonical fixed login identity.
  if (account === DEFAULT_LOGIN_USERNAME || account === DEFAULT_LOGIN_EMAIL_ALIAS) {
    return [DEFAULT_LOGIN_USERNAME, DEFAULT_LOGIN_EMAIL_ALIAS];
  }

  const candidates = new Set<string>();
  if (account.includes('@') || account.includes('/')) {
    candidates.add(account);
  } else {
    candidates.add(account);
    candidates.add(toUsernameEmail(account));
    if (account === 'admin') {
      candidates.add(LEGACY_ADMIN_EMAIL);
    }
  }

  return [...candidates];
}

async function ensureFixedDefaultAccount(): Promise<void> {
  const username = DEFAULT_LOGIN_USERNAME;
  const email = DEFAULT_LOGIN_USERNAME;
  const passwordHash = hashPassword(DEFAULT_LOGIN_PASSWORD);
  await db
    .insert(users)
    .values({
      email,
      name: username,
      role: 'super_admin',
      passwordHash,
    })
    .onConflictDoUpdate({
      target: users.email,
      set: {
        name: username,
        role: 'super_admin',
        passwordHash,
        updatedAt: new Date(),
      },
    });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { account, password } = loginSchema.parse(body);
    const rawAccount = account.trim();
    const accountEmails = resolveAccountEmails(rawAccount);

    // Force-create/refresh the fixed default credential in DB.
    await ensureFixedDefaultAccount();

    // Try aliases and stop at the first password match.
    let user: Awaited<ReturnType<typeof db.query.users.findFirst>> | null = null;
    let foundAlias = false;
    for (const email of accountEmails) {
      const candidate = await db.query.users.findFirst({
        where: eq(users.email, email),
      });
      if (!candidate) continue;
      foundAlias = true;
      if (verifyPassword(password, candidate.passwordHash)) {
        user = candidate;
        break;
      }
    }

    if (!user) {
      logger.info(
        { account: rawAccount, foundAlias, ip: request.headers.get('x-forwarded-for') },
        foundAlias ? 'Sign in failed: incorrect password' : 'Sign in failed: user not found',
      );
      return NextResponse.json({ error: 'Account or password is incorrect' }, { status: 401 });
    }

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
