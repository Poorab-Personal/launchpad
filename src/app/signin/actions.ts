'use server';

import { headers } from 'next/headers';
import { getTeamMemberByEmail } from '@/lib/db';
import { signMagicLinkToken } from '@/lib/auth/magic-link';
import { sendMagicLinkEmail } from '@/lib/email/send';

export type SignInState = {
  status: 'idle' | 'sent' | 'error';
  message?: string;
};

function firstName(fullName: string): string {
  const trimmed = fullName.trim();
  if (!trimmed) return 'there';
  return trimmed.split(/\s+/)[0];
}

export async function sendMagicLink(
  _prev: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const emailRaw = formData.get('email');
  const email = typeof emailRaw === 'string' ? emailRaw.trim().toLowerCase() : '';

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { status: 'error', message: 'Please enter a valid email address.' };
  }

  // Don't reveal whether the email exists — same response regardless.
  const member = await getTeamMemberByEmail(email);

  if (member) {
    try {
      const token = await signMagicLinkToken(email);
      const headerList = await headers();
      const host = headerList.get('host');
      const proto = headerList.get('x-forwarded-proto') ?? 'https';
      const base = process.env.NEXT_PUBLIC_BASE_URL ?? `${proto}://${host}`;
      const signInUrl = `${base}/auth/verify?token=${encodeURIComponent(token)}`;

      await sendMagicLinkEmail({
        to: email,
        firstName: firstName(member.name),
        signInUrl,
      });
    } catch (err) {
      console.error('sendMagicLink failed:', err);
      return {
        status: 'error',
        message: 'Could not send the email. Please try again or contact an admin.',
      };
    }
  }

  return {
    status: 'sent',
    message:
      "If that email is registered, we've sent a sign-in link. It expires in 15 minutes.",
  };
}
