import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type UserRole = 'ADMIN' | 'ANALYST' | 'VIEWER';
export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
}

const COOKIE_NAME = 'astrabi_session';
const SESSION_TTL_SECONDS = 60 * 60 * 8;

function getSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error('SESSION_SECRET must be set and contain at least 32 bytes.');
  }
  return new TextEncoder().encode(secret);
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function createSessionToken(user: SessionUser): Promise<string> {
  return new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer('astrabi-api')
    .setAudience('astrabi-web')
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSecret());
}

export async function verifySessionToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: 'astrabi-api',
      audience: 'astrabi-web',
    });
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

export function readSessionCookie(request: IncomingMessage): string | null {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return null;
  for (const item of cookieHeader.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === COOKIE_NAME) {
      return decodeURIComponent(item.slice(separator + 1).trim());
    }
  }
  return null;
}

export function setSessionCookie(response: ServerResponse, token: string): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.setHeader('set-cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/api/v1; Max-Age=${SESSION_TTL_SECONDS}${secure}`);
}

export function clearSessionCookie(response: ServerResponse): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.setHeader('set-cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/api/v1; Max-Age=0${secure}`);
}

export function hasRole(user: SessionUser, allowed: UserRole[]): boolean {
  return allowed.includes(user.role);
}
