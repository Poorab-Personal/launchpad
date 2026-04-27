import { NextRequest } from 'next/server';

export async function POST(request: NextRequest) {
  const { password } = await request.json();
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    // No password configured — allow access (local dev)
    return Response.json({ ok: true });
  }

  if (password === adminPassword) {
    // Set a cookie that lasts 24 hours
    const response = Response.json({ ok: true });
    response.headers.set(
      'Set-Cookie',
      `admin_auth=1; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
    );
    return response;
  }

  return Response.json({ error: 'Invalid password' }, { status: 401 });
}
