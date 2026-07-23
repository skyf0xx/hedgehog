import { envSchema } from './env.schema.js';

describe('envSchema', () => {
  const valid = {
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/app',
    NODE_ENV: 'development',
  };

  it('accepts a fully valid env', () => {
    const result = envSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('rejects a missing DATABASE_URL', () => {
    const rest: Record<string, string> = { ...valid };
    delete rest['DATABASE_URL'];
    const result = envSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects an invalid NODE_ENV value', () => {
    const result = envSchema.safeParse({ ...valid, NODE_ENV: 'staging' });
    expect(result.success).toBe(false);
  });
});
