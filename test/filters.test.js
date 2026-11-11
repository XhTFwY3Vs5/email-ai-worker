import { describe, it, expect } from 'vitest';
import worker, { matchesSenderRule, isWhitelisted, isBlacklisted } from '../worker.js';
import { makeMessage, makeEnv } from './helpers/fake-message.js';

const wl = (v, from) => isWhitelisted({ SENDER_WHITELIST: v }, from);
const bl = (v, from) => isBlacklisted({ SENDER_BLACKLIST: v }, from);

describe('sender filters', () => {
  it('rejects look-alike domain', () => expect(wl('gmail.com', 'evil@gmail.com.attacker.net')).toBe(false));
  it('accepts domain and subdomain', () => {
    expect(wl('gmail.com', 'a@gmail.com')).toBe(true);
    expect(wl('gmail.com', 'a@mail.gmail.com')).toBe(true);
  });
  it('address entry is exact', () => {
    expect(wl('ann@x.com', 'joann@x.com')).toBe(false);
    expect(wl('ann@x.com', 'ann@x.com')).toBe(true);
  });
  it('blacklist exact address', () => expect(bl('spam@example.com', 'spam@example.com')).toBe(true));
  it('unset lists', () => {
    expect(isWhitelisted({}, 'a@b.com')).toBeNull();
    expect(isBlacklisted({}, 'a@b.com')).toBe(false);
  });
  it('trims whitespace and empty entries', () => {
    expect(wl(' gmail.com , x.com ,', 'a@x.com')).toBe(true);
    expect(wl(' , ', 'a@x.com')).toBe(false);
  });
  it('case-insensitive', () => expect(wl('Gmail.com', 'A@GMAIL.COM')).toBe(true));
  it('@domain form', () => {
    expect(matchesSenderRule('a@x.com', '@x.com')).toBe(true);
    expect(matchesSenderRule('a@y.com', '@x.com')).toBe(false);
  });
  it('empty sender never matches', () => expect(matchesSenderRule('', 'x.com')).toBe(false));

  it('handler skips blacklisted sender', async () => {
    const message = makeMessage({ from: 'spam@example.com' });
    const env = makeEnv({ SENDER_BLACKLIST: 'spam@example.com', MAIN_EMAIL_ADDRESS: 'inbox@x.com' });
    await worker.email(message, env, { waitUntil() {} });
    expect(env.AI.run).not.toHaveBeenCalled();
    expect(message.forward).not.toHaveBeenCalled();
  });
  it('handler: blacklist wins over whitelist', async () => {
    const message = makeMessage({ from: 'spam@example.com' });
    const env = makeEnv({ SENDER_WHITELIST: 'example.com', SENDER_BLACKLIST: 'spam@example.com', MAIN_EMAIL_ADDRESS: 'inbox@x.com' });
    await worker.email(message, env, { waitUntil() {} });
    expect(message.forward).not.toHaveBeenCalled();
  });
});
