import { describe, it, expect, vi, beforeEach } from 'vitest';

// Simulation Database
const mockFindFirst = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockReturning = vi.fn();
const mockSelect = vi.fn();
const mockSelectFrom = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      machines: {
        findFirst: (...args: unknown[]) => mockFindFirst(...args),
      },
    },
    insert: (...args: unknown[]) => {
      mockInsert(...args);
      return { values: (...vArgs: unknown[]) => { mockValues(...vArgs); return { returning: (...rArgs: unknown[]) => mockReturning(...rArgs) }; } };
    },
    select: (...args: unknown[]) => {
      mockSelect(...args);
      return { from: (...fArgs: unknown[]) => mockSelectFrom(...fArgs) };
    },
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  machines: {
    fingerprint: 'fingerprint',
    osUsername: 'os_username',
    id: 'id',
    status: 'status',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ col: _col, val })),
  and: vi.fn((...conditions: unknown[]) => conditions),
  sql: Object.assign((..._args: unknown[]) => ({ _sql: true }), {
    raw: (s: string) => s,
  }),
}));

describe('POST /api/agent/register', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const validBody = {
    fingerprint: 'a'.repeat(64),
    osUsername: 'testuser',
    osInfo: {
      os: 'Windows',
      version: '11',
      arch: 'x86_64',
      hostname: 'DESKTOP-TEST',
    },
    agentVersion: '0.1.0',
  };

  it('should be created pending Device and go back 201', async () => {
    mockFindFirst.mockResolvedValue(null);
    // Existing devices already in the table → not the first device
    mockSelectFrom.mockResolvedValue([{ total: 3 }]);
    mockReturning.mockResolvedValue([{ id: 'new-uuid', status: 'pending', authKey: 'key-pending' }]);

    const { POST } = await import('@/app/api/agent/register/route');
    const request = new Request('http://localhost/api/agent/register', {
      method: 'POST',
      body: JSON.stringify(validBody),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.machineId).toBe('new-uuid');
    expect(data.status).toBe('pending');
    expect(data.authKey).toBeUndefined();
  });

  it('First device is auto-approved as active', async () => {
    mockFindFirst.mockResolvedValue(null);
    mockSelectFrom.mockResolvedValue([{ total: 0 }]);
    mockReturning.mockResolvedValue([{ id: 'first-uuid', status: 'active', authKey: 'key-auto' }]);

    const { POST } = await import('@/app/api/agent/register/route');
    const request = new Request('http://localhost/api/agent/register', {
      method: 'POST',
      body: JSON.stringify(validBody),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data.machineId).toBe('first-uuid');
    expect(data.status).toBe('active');
    expect(data.authKey).toBe('key-auto');
  });

  it('Repeat Fingerprint+Username does not create new record', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'existing-uuid',
      status: 'pending',
      fingerprint: validBody.fingerprint,
      osUsername: validBody.osUsername,
      authKey: 'key-123',
    });

    const { POST } = await import('@/app/api/agent/register/route');
    const request = new Request('http://localhost/api/agent/register', {
      method: 'POST',
      body: JSON.stringify(validBody),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.machineId).toBe('existing-uuid');
    expect(data.status).toBe('pending');
    // pending Status does not return authKey
    expect(data.authKey).toBeUndefined();
  });

  it('Activated Device Duplicate Enrollment Back authKey', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'active-uuid',
      status: 'active',
      fingerprint: validBody.fingerprint,
      osUsername: validBody.osUsername,
      authKey: 'key-456',
    });

    const { POST } = await import('@/app/api/agent/register/route');
    const request = new Request('http://localhost/api/agent/register', {
      method: 'POST',
      body: JSON.stringify(validBody),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await POST(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.authKey).toBe('key-456');
  });

  it('Device Reenrollment Disabled Back 403', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'disabled-uuid',
      status: 'disabled',
      fingerprint: validBody.fingerprint,
      osUsername: validBody.osUsername,
    });

    const { POST } = await import('@/app/api/agent/register/route');
    const request = new Request('http://localhost/api/agent/register', {
      method: 'POST',
      body: JSON.stringify(validBody),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await POST(request);
    expect(response.status).toBe(403);
  });

  it('Invalid parameter return 400', async () => {
    const { POST } = await import('@/app/api/agent/register/route');
    const request = new Request('http://localhost/api/agent/register', {
      method: 'POST',
      body: JSON.stringify({ fingerprint: 'short' }), // Too short
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
  });
});

describe('GET /api/agent/register/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Device status should be returned', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'uuid-123',
      status: 'pending',
      authKey: 'key-789',
    });

    const { GET } = await import('@/app/api/agent/register/status/route');
    const url = `http://localhost/api/agent/register/status?fingerprint=${'a'.repeat(64)}&osUsername=testuser`;
    const request = new Request(url);

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.machineId).toBe('uuid-123');
    expect(data.status).toBe('pending');
    // pending Status does not return authKey
    expect(data.authKey).toBeUndefined();
  });

  it('Return after approval authKey', async () => {
    mockFindFirst.mockResolvedValue({
      id: 'uuid-456',
      status: 'active',
      authKey: 'key-active',
    });

    const { GET } = await import('@/app/api/agent/register/status/route');
    const url = `http://localhost/api/agent/register/status?fingerprint=${'b'.repeat(64)}&osUsername=testuser`;
    const request = new Request(url);

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.authKey).toBe('key-active');
  });

  it('Device Not Registered Back 404', async () => {
    mockFindFirst.mockResolvedValue(null);

    const { GET } = await import('@/app/api/agent/register/status/route');
    const url = `http://localhost/api/agent/register/status?fingerprint=${'c'.repeat(64)}&osUsername=nobody`;
    const request = new Request(url);

    const response = await GET(request);
    expect(response.status).toBe(404);
  });

  it('Missing parameter return 400', async () => {
    const { GET } = await import('@/app/api/agent/register/status/route');
    const url = 'http://localhost/api/agent/register/status?fingerprint=abc';
    const request = new Request(url);

    const response = await GET(request);
    expect(response.status).toBe(400);
  });
});
