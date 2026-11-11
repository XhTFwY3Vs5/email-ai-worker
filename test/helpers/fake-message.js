import { vi } from 'vitest';

export function makeMessage({ from = 'sender@example.com', to = 'me@d.com', headers = {}, raw } = {}) {
  const body = raw ?? `From: ${from}\r\nTo: ${to}\r\nSubject: Hello\r\nMessage-ID: <1@example.com>\r\n\r\nPlain text body\r\n`;
  return {
    from,
    to,
    headers: new Headers(headers),
    raw: new Response(body).body,
    forward: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    setReject: vi.fn()
  };
}

export function makeEnv(overrides = {}) {
  return { AI: { run: vi.fn().mockResolvedValue({ response: 'stub summary' }) }, ...overrides };
}
