import { hashSync, compareSync } from 'bcryptjs';

const SALT_ROUNDS = 10;

export function hashPassword(password: string): string {
  return hashSync(password, SALT_ROUNDS);
}

export function verifyPassword(password: string, hash: string): boolean {
  return compareSync(password, hash);
}
