/**
 * Brokerage landing page — bare top-level slug (e.g. /ipre, /keyes).
 *
 * Server component. Resolves the brokerage by `landing_page_slug` against an
 * allowlist (active brokerages only). Unknown slugs → notFound() so this
 * dynamic segment can't swallow 404s or shadow future top-level routes.
 * Next.js gives explicit segments (/admin, /workspace, /r, /signin, /auth,
 * /api) precedence over this catch dynamic segment regardless.
 *
 * Renders brokerage name + logo (master_logo_url if present) + the email /
 * hCaptcha verification form. Neutral/clean styling — flow first, brand later.
 *
 * See docs/integrations/dmg-roster-plan.md §4.2.
 */
import { notFound } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db';
import * as schema from '@/db/schema';
import EmailForm from './EmailForm';

export const dynamic = 'force-dynamic';

export default async function BrokerageLandingPage(props: PageProps<'/[slug]'>) {
  const { slug } = await props.params;

  const brokerage = await db.query.brokerages.findFirst({
    where: and(
      eq(schema.brokerages.landingPageSlug, slug),
      eq(schema.brokerages.active, true),
    ),
  });

  // Allowlist: only active brokerage slugs render. Everything else 404s.
  if (!brokerage) notFound();

  const siteKey = process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY ?? '';
  const tagline =
    brokerage.pricingTagline?.replace(/\{Name\}/g, brokerage.name) ?? '';

  return (
    <div className="min-h-screen bg-[#F7F4EB] flex flex-col">
      {/* Top bar */}
      <header className="bg-white border-b border-[#E0DEE4]">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 py-4 flex items-center justify-between">
          {brokerage.masterLogoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={brokerage.masterLogoUrl}
              alt={brokerage.name}
              className="h-9 max-w-[200px] object-contain"
            />
          ) : (
            <span className="text-lg font-semibold text-[#1B2E35]">
              {brokerage.name}
            </span>
          )}
          <span className="text-xs text-[#1B2E35]/50">Powered by Rejig.ai</span>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <div className="rounded-2xl bg-white border border-[#E0DEE4] shadow-sm p-8">
            <h1 className="text-2xl font-bold text-[#1B2E35]">
              Get started with {brokerage.name}
            </h1>
            <p className="mt-2 text-sm text-[#1B2E35]/70">
              {tagline ||
                'Enter your work email to verify your agent profile and begin onboarding.'}
            </p>

            <div className="mt-6">
              <EmailForm slug={slug} siteKey={siteKey} />
            </div>
          </div>

          <p className="mt-6 text-center text-xs text-[#1B2E35]/40">
            We use your email only to match you against your brokerage roster.
          </p>
        </div>
      </main>
    </div>
  );
}
