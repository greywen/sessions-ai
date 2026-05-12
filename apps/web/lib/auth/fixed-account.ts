import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { hashPassword } from './password';

const DEFAULT_FIXED_ACCOUNT = 'sessions-ai';
const DEFAULT_FIXED_PASSWORD = '123456';

function normalizeEnvValue(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export interface FixedAccountConfig {
  account: string;
  password: string;
  name: string;
}

export interface FixedAccountUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  createdAt: Date;
  updatedAt: Date;
}

export function getFixedAccountConfig(): FixedAccountConfig {
  const account = normalizeEnvValue(process.env.ADMIN_EMAIL) ?? DEFAULT_FIXED_ACCOUNT;
  const password = process.env.ADMIN_PASSWORD ?? DEFAULT_FIXED_PASSWORD;
  const name = normalizeEnvValue(process.env.ADMIN_NAME) ?? account;

  return {
    account,
    password,
    name,
  };
}

export async function ensureFixedAccount(): Promise<FixedAccountUser> {
  const config = getFixedAccountConfig();
  const passwordHash = hashPassword(config.password);

  const [user] = await db
    .insert(users)
    .values({
      email: config.account,
      name: config.name,
      role: 'super_admin',
      passwordHash,
    })
    .onConflictDoUpdate({
      target: users.email,
      set: {
        name: config.name,
        role: 'super_admin',
        passwordHash,
        updatedAt: new Date(),
      },
    })
    .returning({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    });

  return user;
}
