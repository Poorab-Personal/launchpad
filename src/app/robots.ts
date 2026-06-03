import type { MetadataRoute } from 'next';

/**
 * Block all crawlers across the entire deployment.
 *
 * LaunchPad's surfaces are all either internal team UI, agent-facing
 * onboarding flows reached via direct link (QR code on flyers, email
 * portal links), or sensitive customer portals at /r/<token>. None of
 * them benefit from search-engine indexing, and several actively harm
 * from it (token URLs could leak via search snippets).
 *
 * Paired with the X-Robots-Tag header in vercel.json — robots.txt is
 * the "polite ask" + that header is the binding signal that even bots
 * which crawl despite the disallow rule won't index what they find.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        disallow: '/',
      },
    ],
  };
}
