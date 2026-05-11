import { NextRequest } from 'next/server';
import { redirect } from 'next/navigation';
import { verifyMagicLinkToken } from '@/lib/auth/magic-link';
import { setSessionCookie } from '@/lib/auth/session';
import { getTeamMemberByEmail } from '@/lib/db';

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  if (!token) {
    redirect('/signin?error=missing-token');
  }

  const payload = await verifyMagicLinkToken(token);
  if (!payload) {
    redirect('/signin?error=expired');
  }

  // Re-check Team Members at verify time — covers the case where someone
  // was deactivated between requesting and clicking the link.
  const member = await getTeamMemberByEmail(payload.email);
  if (!member) {
    redirect('/signin?error=not-authorized');
  }

  await setSessionCookie({
    memberId: member.id,
    email: member.email,
    role: member.role,
  });

  redirect('/workspace');
}
