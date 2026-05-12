import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { users } from './schema';
import { hashSync } from 'bcryptjs';

async function seed() {
  const databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres:123456@localhost:5432/sessions_ai';
  const client = postgres(databaseUrl);
  const db = drizzle(client);

  console.log('🌱 Start populating seed data...');

  // 1. Administrator account
  const adminEmail = process.env.ADMIN_EMAIL || 'sessions-ai';
  const adminPassword = process.env.ADMIN_PASSWORD || '123456';

  await db.insert(users).values({
    email: adminEmail,
    name: 'System Administrator',
    role: 'super_admin',
    passwordHash: hashSync(adminPassword, 10),
  }).onConflictDoNothing();

  console.log(`  ✅ Administrator account: ${adminEmail}`);

  console.log('🌱 Seed Data Population Complete');
  await client.end();
  process.exit(0);
}

seed().catch((err) => {
  console.error('❌ Seed data failed:', err);
  process.exit(1);
});
