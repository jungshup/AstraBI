import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearSessionCookie,
  createSessionToken,
  hashPassword,
  hasRole,
  readSessionCookie,
  setSessionCookie,
  verifyPassword,
  verifySessionToken,
} from './auth.js';
import type { SessionUser } from './auth.js';

// Tests use a throwaway secret only; production must provide its own secret.
process.env.SESSION_SECRET = 'unit-test-session-secret-with-more-than-32-bytes';

const user: SessionUser = {
  id: 'user-test-1',
  email: 'analyst@example.test',
  name: 'Test Analyst',
  role: 'ANALYST',
};

test('password hashes verify the original password but never equal plaintext', async () => {
  const hash = await hashPassword('a-long-test-password-123');
  assert.notEqual(hash, 'a-long-test-password-123');
  assert.equal(await verifyPassword('a-long-test-password-123', hash), true);
  assert.equal(await verifyPassword('wrong-password', hash), false);
});

test('session token validates and returns the subject user id', async () => {
  const token = await createSessionToken(user);
  assert.equal(await verifySessionToken(token), user.id);
  assert.equal(await verifySessionToken('not-a-jwt'), null);
});

test('session cookie is HttpOnly, SameSite=Lax, and can be cleared', () => {
  const headers = new Map<string, string>();
  const response = {
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
  } as unknown as Parameters<typeof setSessionCookie>[0];

  setSessionCookie(response, 'signed-token');
  const cookie = headers.get('set-cookie');
  assert.ok(cookie?.includes('HttpOnly'));
  assert.ok(cookie?.includes('SameSite=Lax'));
  assert.ok(cookie?.includes('Path=/api/v1'));
  assert.ok(cookie?.includes('signed-token'));

  clearSessionCookie(response);
  assert.ok(headers.get('set-cookie')?.includes('Max-Age=0'));
});

test('session cookie reader returns only the named cookie', () => {
  const request = {
    headers: { cookie: 'other=value; astrabi_session=encoded%2Dtoken; another=entry' },
  } as unknown as Parameters<typeof readSessionCookie>[0];
  assert.equal(readSessionCookie(request), 'encoded-token');

  const noSession = {
    headers: { cookie: 'other=value' },
  } as unknown as Parameters<typeof readSessionCookie>[0];
  assert.equal(readSessionCookie(noSession), null);
});

test('role checks allow only explicitly listed roles', () => {
  assert.equal(hasRole(user, ['ANALYST', 'ADMIN']), true);
  assert.equal(hasRole(user, ['ADMIN']), false);
});
