import { describe, it, expect } from 'vitest';
import { stripHtml, getDomainFromEmail, getAliasForward, determineMode } from '../worker.js';

describe('helpers', () => {
  it('stripHtml removes tags', () => expect(stripHtml('<p>a</p>')).toBe('a'));
  it('getDomainFromEmail lowercases domain', () => expect(getDomainFromEmail('A@B.com')).toBe('b.com'));
  it('getAliasForward maps alias', () => expect(getAliasForward('x@d.com', 'x@d.com:y@g.com')).toBe('y@g.com'));
  it('determineMode reply', () => expect(determineMode('me+reply@d.com', {})).toBe('reply'));
  it('determineMode notify', () => expect(determineMode('me+news@d.com', {})).toBe('notify'));
  it('determineMode header', () => expect(determineMode('me@d.com', {})).toBe('header'));
});
