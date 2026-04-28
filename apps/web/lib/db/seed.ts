import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { users, pricingTable } from './schema';
import { hashSync } from 'bcryptjs';

async function seed() {
  const databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres:123456@localhost:5432/sessions_ai';
  const client = postgres(databaseUrl);
  const db = drizzle(client);

  console.log('🌱 Start populating seed data...');

  // 1. Administrator account
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@sessions-ai.local';
  const adminPassword = process.env.ADMIN_PASSWORD || '123456';

  await db.insert(users).values({
    email: adminEmail,
    name: 'System Administrator',
    role: 'super_admin',
    passwordHash: hashSync(adminPassword, 10),
  }).onConflictDoNothing();

  console.log(`  ✅ Administrator account: ${adminEmail}`);

  // 2. Initial Pricing Table(2026-04 efficiency price)
  const pricingData = [
    { model: 'claude-sonnet-4-6', provider: 'anthropic', inputPricePerMtok: '3.0000', outputPricePerMtok: '15.0000', cachePricePerMtok: '0.3000', effectiveFrom: '2026-01-01' },
    { model: 'claude-opus-4-6', provider: 'anthropic', inputPricePerMtok: '15.0000', outputPricePerMtok: '75.0000', cachePricePerMtok: '1.5000', effectiveFrom: '2026-01-01' },
    { model: 'claude-haiku-3.5', provider: 'anthropic', inputPricePerMtok: '0.8000', outputPricePerMtok: '4.0000', cachePricePerMtok: '0.0800', effectiveFrom: '2026-01-01' },
    { model: 'gpt-4.1', provider: 'openai', inputPricePerMtok: '2.0000', outputPricePerMtok: '8.0000', cachePricePerMtok: null, effectiveFrom: '2026-01-01' },
    { model: 'gpt-4.1-mini', provider: 'openai', inputPricePerMtok: '0.4000', outputPricePerMtok: '1.6000', cachePricePerMtok: null, effectiveFrom: '2026-01-01' },
    { model: 'gemini-2.5-pro', provider: 'google', inputPricePerMtok: '1.2500', outputPricePerMtok: '10.0000', cachePricePerMtok: '0.3150', effectiveFrom: '2026-01-01' },
    { model: 'gemini-2.5-flash', provider: 'google', inputPricePerMtok: '0.1500', outputPricePerMtok: '0.6000', cachePricePerMtok: '0.0375', effectiveFrom: '2026-01-01' },
  ];

  for (const p of pricingData) {
    await db.insert(pricingTable).values(p).onConflictDoNothing();
  }

  console.log(`  ✅ Pricing Table: ${pricingData.length} shaare`);

  console.log('🌱 Seed Data Population Complete');
  await client.end();
  process.exit(0);
}

seed().catch((err) => {
  console.error('❌ Seed data failed:', err);
  process.exit(1);
});
