import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createSession } from '@/lib/auth/session';
import { ensureFixedAccount, getFixedAccountConfig } from '@/lib/auth/fixed-account';
import { logger } from '@/lib/logger';

const loginSchema = z.object({
  account: z.string().min(1),
  password: z.string().min(1),
});

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { account, password } = loginSchema.parse(body);
    const fixed = getFixedAccountConfig();
    const normalizedAccount = account.trim();

    if (normalizedAccount !== fixed.account || password !== fixed.password) {
      logger.info(
        { account: normalizedAccount, ip: request.headers.get('x-forwarded-for') },
        'Sign in failed: fixed credential mismatch',
      );
      return NextResponse.json({ error: 'Account or password is incorrect' }, { status: 401 });
    }

    // Ensure the fixed account always exists and is in sync with current env config.
    const user = await ensureFixedAccount();

    await createSession({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    logger.info(
      { account: normalizedAccount, resolvedEmail: user.email, role: user.role, ip: request.headers.get('x-forwarded-for'), ua: request.headers.get('user-agent') },
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
