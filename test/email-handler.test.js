import { it, expect } from 'vitest';
import worker from '../worker.js';
import { makeMessage, makeEnv } from './helpers/fake-message.js';

it('header mode forwards plain-text email to MAIN_EMAIL_ADDRESS', async () => {
  const message = makeMessage({ to: 'me@d.com' });
  const env = makeEnv({ MAIN_EMAIL_ADDRESS: 'inbox@x.com', FORWARD_ORIGINAL: 'true' });
  await worker.email(message, env, { waitUntil() {} });
  expect(message.forward).toHaveBeenCalledTimes(1);
  expect(message.forward.mock.calls[0][0]).toBe('inbox@x.com');
});
