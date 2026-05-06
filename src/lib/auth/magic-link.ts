import 'server-only';
import { SignJWT, jwtVerify } from 'jose';

const MAGIC_LINK_TTL_MINUTES = 15;

type MagicLinkPayload = {
  email: string;
};

function key() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET is not set');
  return new TextEncoder().encode(secret);
}

export async function signMagicLinkToken(email: string): Promise<string> {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${MAGIC_LINK_TTL_MINUTES}m`)
    .setSubject('magic-link')
    .sign(key());
}

export async function verifyMagicLinkToken(token: string): Promise<MagicLinkPayload | null> {
  try {
    const { payload } = await jwtVerify<MagicLinkPayload>(token, key(), {
      algorithms: ['HS256'],
      subject: 'magic-link',
    });
    return { email: payload.email };
  } catch {
    return null;
  }
}
