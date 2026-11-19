import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';

export interface AuthContext {
  subject: string;
  roles: string[];
  tenantId: string;
  expiresAt?: number;
}

export function createAuthContext(input: AuthContext): AuthContext {
  return {
    ...input,
    expiresAt: input.expiresAt ?? Date.now() + 1000 * 60 * 60,
  };
}

export interface AccessTokenClaims {
  subject: string;
  tenantId: string;
  role: string;
  sessionId: string;
}

export async function issueAccessToken(
  claims: AccessTokenClaims,
  secret: string,
  expiresInSeconds = 3600,
): Promise<string> {
  return new SignJWT({ tenantId: claims.tenantId, role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('astrabi')
    .setSubject(claims.subject)
    .setJti(claims.sessionId)
    .setIssuedAt()
    .setExpirationTime(`${expiresInSeconds}s`)
    .sign(new TextEncoder().encode(secret));
}

export async function verifyAccessToken(token: string, secret: string) {
  return jwtVerify(token, new TextEncoder().encode(secret), {
    issuer: 'astrabi',
    algorithms: ['HS256'],
  });
}

export function isAccessTokenError(error: unknown): boolean {
  return error instanceof joseErrors.JOSEError;
}
