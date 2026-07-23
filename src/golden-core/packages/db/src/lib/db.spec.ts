import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('db', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.DATABASE_URL =
      'postgres://postgres:postgres@localhost:5432/app';
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('lazily constructs a single shared pool', async () => {
    const { getPool, closeDb } = await import('./db.js');
    const first = getPool();
    const second = getPool();
    expect(first).toBe(second);
    await closeDb();
  });

  it('returns a drizzle client bound to the shared pool', async () => {
    const { getDb, closeDb } = await import('./db.js');
    const db = getDb();
    expect(db).toBeDefined();
    await closeDb();
  });

  it('exits fast when DATABASE_URL is missing or malformed', async () => {
    process.env.DATABASE_URL = 'not-a-url';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const errorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const { getPool } = await import('./db.js');
    expect(() => getPool()).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
