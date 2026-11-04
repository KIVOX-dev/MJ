import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const base = { MONGODB_URI: 'mongodb://x', GROQ_API_KEYS: 'k1' } as NodeJS.ProcessEnv;

describe('config with blank optional values', () => {
  it('treats blank optional variables as unset instead of crashing', () => {
    const c = loadConfig({ ...base, BREVO_API_KEY: '', BREVO_SENDER_EMAIL: '', OWNER_EMAIL: ' ', WEB_API_TOKEN: '', CRAWLIT_URL: '', CRAWLIT_TOKEN: '' });
    expect(c.webApiToken).toBeUndefined();
    expect(c.email.ownerEmail).toBeUndefined();
    expect(c.crawlitUrl).toBeUndefined();
  });

  it('still rejects wrong non-blank values', () => {
    expect(() => loadConfig({ ...base, WEB_API_TOKEN: 'short' })).toThrow(/WEB_API_TOKEN/);
    expect(() => loadConfig({ ...base, OWNER_EMAIL: 'not-an-email' })).toThrow(/OWNER_EMAIL/);
  });

  it('still requires the mandatory variables', () => {
    expect(() => loadConfig({ GROQ_API_KEYS: 'k' } as NodeJS.ProcessEnv)).toThrow(/MONGODB_URI/);
  });
});
