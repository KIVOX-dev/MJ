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

  it('disables an add-on with a warning when its value is wrong, instead of crashing the bot', () => {
    const c = loadConfig({ ...base, WEB_API_TOKEN: 'short', OWNER_EMAIL: 'not-an-email', BREVO_API_KEY: 'key' });
    expect(c.webApiToken).toBeUndefined();
    expect(c.email.ownerEmail).toBeUndefined();
    expect(c.email.brevoApiKey).toBe('key');
    expect(c.warnings.join(' ')).toMatch(/WEB_API_TOKEN/);
    expect(c.warnings.join(' ')).toMatch(/OWNER_EMAIL/);
  });

  it('still fails when a core setting is wrong, even if an add-on is wrong too', () => {
    expect(() => loadConfig({ ...base, PORT: 'abc', WEB_API_TOKEN: 'short' })).toThrow(/PORT/);
    expect(() => loadConfig({ ...base, NEWS_DIGEST_TIME: '8am' })).toThrow(/NEWS_DIGEST_TIME/);
  });

  it('still requires the mandatory variables', () => {
    expect(() => loadConfig({ GROQ_API_KEYS: 'k' } as NodeJS.ProcessEnv)).toThrow(/MONGODB_URI/);
  });
});
