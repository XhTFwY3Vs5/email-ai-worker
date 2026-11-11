import { it, expect } from 'vitest';
import worker from '../worker.js';

it('GET /health returns ok', async () => {
  const res = await worker.fetch(new Request('https://w.test/health'), {}, {});
  expect(res.status).toBe(200);
  expect((await res.json()).status).toBe('ok');
});
