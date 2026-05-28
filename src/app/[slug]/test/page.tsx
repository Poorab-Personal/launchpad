/**
 * Test-mode brokerage landing — /[slug]/test (e.g. /ipre/test).
 *
 * Server component. Same brand chrome as the real landing (/[slug]) — it
 * reuses the SAME <LandingShell> + theme map, with no styling fork — but
 * renders the two-field <TestEmailForm> and a 🧪 TEST MODE banner so an
 * internal tester can exercise the full B2B flow against REAL roster data
 * while routing every downstream email to their own inbox.
 *
 * Gates:
 *   - brokerage allowlist (active brokerages only) — same as the real page;
 *     unknown slug → notFound().
 *   - settings.b2b_test_route_enabled must equal 'on' — otherwise notFound().
 *     This keeps a public test endpoint from minting junk customers when we
 *     aren't actively testing. The setting is env-independent/runtime and is
 *     inserted out-of-band (not seeded here).
 *
 * See docs/integrations/dmg-roster-plan.md §4.2 + the B2B test-route plan.
 */
import { notFound } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';
import { getSetting } from '@/lib/db';
import LandingShell from '../LandingShell';
import { themeForSlug } from '../theme';
import TestEmailForm from './TestEmailForm';

export const dynamic = 'force-dynamic';

export default async function BrokerageTestLandingPage(
  props: PageProps<'/[slug]/test'>,
) {
  const { slug } = await props.params;

  // Route gate: the test endpoint only renders while explicitly enabled.
  const testEnabled = (await getSetting('b2b_test_route_enabled')) === 'on';
  if (!testEnabled) notFound();

  const brokerage = await db.query.brokerages.findFirst({
    where: and(
      eq(schema.brokerages.landingPageSlug, slug),
      eq(schema.brokerages.active, true),
    ),
  });

  // Allowlist: only active brokerage slugs render. Everything else 404s.
  if (!brokerage) notFound();

  const theme = themeForSlug(slug);
  const siteKey = process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY ?? '';
  const tagline =
    brokerage.pricingTagline?.replace(/\{Name\}/g, brokerage.name) ?? '';

  const banner = (
    <div
      className="rounded-lg border px-3 py-3 text-sm"
      style={{
        backgroundColor: '#FEF3C7', // amber-100
        borderColor: '#FCD34D', // amber-300
        color: '#92400E', // amber-800
      }}
    >
      <p className="font-semibold">🧪 TEST MODE</p>
      <p className="mt-1 text-[13px] leading-snug">
        This creates a clearly-marked test customer
        (<span className="font-medium">LP&nbsp;TEST&nbsp;—&nbsp;…</span>) using a
        real agent&apos;s roster data, but routes every onboarding email to{' '}
        <span className="font-medium">your</span> inbox. Re-enter your receive
        email to pick a session back up.
      </p>
    </div>
  );

  return (
    <LandingShell
      brokerage={{
        name: brokerage.name,
        masterLogoUrl: brokerage.masterLogoUrl ?? null,
        tagline,
      }}
      theme={theme}
      banner={banner}
      form={<TestEmailForm slug={slug} siteKey={siteKey} theme={theme} />}
    />
  );
}
