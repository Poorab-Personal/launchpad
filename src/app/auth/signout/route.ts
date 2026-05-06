import { redirect } from 'next/navigation';
import { clearSessionCookie } from '@/lib/auth/session';

export async function POST() {
  await clearSessionCookie();
  redirect('/signin');
}

export async function GET() {
  await clearSessionCookie();
  redirect('/signin');
}
