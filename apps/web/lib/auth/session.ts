import { cookies } from 'next/headers';
import { signToken, verifyToken, type SessionPayload } from './jwt';
import { logger } from '../logger';

const SESSION_COOKIE = 'session-vault-session';

// Create Session(Settings cookie)
export async function createSession(payload: { userId: string; email: string; role: string }) {
  const token = await signToken(payload);

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 60 * 60 * 24, // 24 Jam
    path: '/',
  });

  logger.info({ email: payload.email, role: payload.role }, 'Session created successfully');
  return token;
}

// Get the current session
export async function getSession(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const payload = await verifyToken(token);
  if (!payload) {
    logger.debug('Sessions token Invalid or expired');
  }
  return payload;
}

// Destroy sessions
export async function destroySession() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
  logger.info('Session destroyed.');
}
