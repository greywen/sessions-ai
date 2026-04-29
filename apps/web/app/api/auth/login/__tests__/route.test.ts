import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFindFirst = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockOnConflictDoUpdate = vi.fn();
const mockVerifyPassword = vi.fn();
const mockHashPassword = vi.fn();
const mockCreateSession = vi.fn();
const mockEq = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      users: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
      },
    },
    insert: (...args: unknown[]) => {
      mockInsert(...args);
      return {
        values: (...valueArgs: unknown[]) => {
          mockValues(...valueArgs);
          return {
            onConflictDoUpdate: (...conflictArgs: unknown[]) => mockOnConflictDoUpdate(...conflictArgs),
          };
        },
      };
    },
  },
}));

vi.mock('@/lib/db/schema', () => ({
  users: {
    id: 'id',
    email: 'email',
    role: 'role',
    name: 'name',
    passwordHash: 'password_hash',
    updatedAt: 'updated_at',
  },
}));

vi.mock('@/lib/auth/password', () => ({
  verifyPassword: (...args: unknown[]) => mockVerifyPassword(...args),
  hashPassword: (...args: unknown[]) => mockHashPassword(...args),
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

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => mockEq(...args),
}));

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    delete process.env.ADMIN_EMAIL;

    mockEq.mockImplementation((_column: unknown, value: unknown) => ({ value }));
    mockHashPassword.mockReturnValue('hashed-default-password');
    mockOnConflictDoUpdate.mockResolvedValue(undefined);
    mockCreateSession.mockResolvedValue(undefined);
  });

  it('upserts fixed default account and logs in with username sessions-ai', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'u-1',
      email: 'sessions-ai',
      role: 'super_admin',
      name: 'sessions-ai',
      passwordHash: 'stored-hash',
    });
    mockVerifyPassword.mockReturnValue(true);

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
    expect(mockValues).toHaveBeenCalledWith({
      email: 'sessions-ai',
      name: 'sessions-ai',
      role: 'super_admin',
      passwordHash: 'hashed-default-password',
    });
    expect(mockOnConflictDoUpdate).toHaveBeenCalledTimes(1);
    expect(mockCreateSession).toHaveBeenCalledWith({
      userId: 'u-1',
      email: 'sessions-ai',
      role: 'super_admin',
    });
  });

  it('tries alias when first account exists but password does not match', async () => {
    mockFindFirst
      .mockResolvedValueOnce({
        id: 'u-old',
        email: 'sessions-ai',
        role: 'viewer',
        name: 'legacy',
        passwordHash: 'legacy-hash',
      })
      .mockResolvedValueOnce({
        id: 'u-new',
        email: 'sessions-ai@sessions-ai.local',
        role: 'super_admin',
        name: 'sessions-ai',
        passwordHash: 'new-hash',
      });

    mockVerifyPassword
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    const { POST } = await import('@/app/api/auth/login/route');
    const request = new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: 'sessions-ai@sessions-ai.local', password: '123456' }),
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.user.email).toBe('sessions-ai@sessions-ai.local');
    expect(mockCreateSession).toHaveBeenCalledWith({
      userId: 'u-new',
      email: 'sessions-ai@sessions-ai.local',
      role: 'super_admin',
    });
  });
});
