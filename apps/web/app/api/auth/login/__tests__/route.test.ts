import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnsureFixedAccount = vi.fn();
const mockGetFixedAccountConfig = vi.fn();
const mockCreateSession = vi.fn();

vi.mock('@/lib/auth/fixed-account', () => ({
  ensureFixedAccount: (...args: unknown[]) => mockEnsureFixedAccount(...args),
  getFixedAccountConfig: (...args: unknown[]) => mockGetFixedAccountConfig(...args),
}));

vi.mock('@/lib/auth/session', () => ({
  createSession: (...args: unknown[]) => mockCreateSession(...args),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockGetFixedAccountConfig.mockReturnValue({
      account: 'sessions-ai',
      password: '123456',
      name: 'sessions-ai',
    });
    mockEnsureFixedAccount.mockResolvedValue({
      id: 'u-1',
      email: 'sessions-ai',
      role: 'super_admin',
      name: 'sessions-ai',
    });
    mockCreateSession.mockResolvedValue(undefined);
  });

  it('logs in successfully when fixed credentials match', async () => {
    const { POST } = await import('@/app/api/auth/login/route');
    const request = new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: 'sessions-ai', password: '123456' }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.user.email).toBe('sessions-ai');
    expect(mockEnsureFixedAccount).toHaveBeenCalledTimes(1);
    expect(mockCreateSession).toHaveBeenCalledWith({
      userId: 'u-1',
      email: 'sessions-ai',
      role: 'super_admin',
    });
  });

  it('rejects login when password mismatches fixed credentials', async () => {
    const { POST } = await import('@/app/api/auth/login/route');
    const request = new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: 'sessions-ai', password: 'wrong' }),
    });

    const response = await POST(request);
    const data = await response.json() as { error: string };

    expect(response.status).toBe(401);
    expect(data.error).toBe('Account or password is incorrect');
    expect(mockEnsureFixedAccount).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });
});
