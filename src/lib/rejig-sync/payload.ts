import type { Customer } from '@/types';
import {
  brandKitMissing,
  DEFAULT_LOGO_SIZES,
  type BrandKit,
  type LogoSizes,
} from '@/lib/brand-kit';

/**
 * Builds the JSON LaunchPad POSTs to Rejig's onboarding staging endpoint
 * (`/onboarding/source/customers`). Pure — no db, no fetch, no server-only —
 * so vitest and the preview script can load it. The caller gathers the
 * inputs. Plan + field mapping: docs/plans/rejig-account-sync.md.
 *
 * Empty strings go as null: Rejig treats null as "not provided", and an empty
 * string would overwrite whatever its create panel would otherwise default.
 */

export type RejigCustomerPayload = {
  source_customer_id: string;
  first_name: string;
  last_name: string;
  /** Account voice: true = team ("we / us"), false = individual ("I / me"). */
  is_team: boolean;
  business_name: string;
  website: string;
  phone: string | null;
  business_address: string | null;
  signin_email: string | null;
  platform_email: string | null;
  other_emails: string[] | null;
  license_number: string | null;
  managed_by: string | null;
  mls_ids: string | null;
  bio: string | null;
  monthly_market_reports: string | null;
  neighborhood_news: string | null;
  topics: string | null;
  hashtags: string | null;
  review_sources: string | null;
  google_business_name: string | null;
  google_place_id: null;
  zillow: string | null;
  account_type: string | null;
  footer_label: string | null;
  customer_type: string;
  /** Rejig's brokerage id ("keyes", "baird"), from brokerages.rejig_broker_id. */
  associated_brokerage: string | null;
  industry: string;
  generate_brand_template: null;
  pick_specific_to_search_tag: null;
  image_custom_search_tags: string[] | null;
  video_custom_search_tags: string[] | null;
  affiliation: string | null;
  other_affiliation: string | null;
  blog_page_url: null;
  profile_image_url: string | null;
  /** Designer's headshot when it differs from the profile photo, else the profile photo. */
  headshot_url: string | null;
  logo_url: string | null;
  logo_black_url: string | null;
  logo_white_url: string | null;
  domain_color_palette: string[] | null;
  derived_logos: string[] | null;
  team_derived_logos: string[] | null;
  apply_custom_font: boolean;
  apply_fixed_logo_height: boolean;
  font: { type: 'primary' | 'secondary' | 'tertiary'; font: string; line_height: number }[] | null;
  brand_logo_sizes: { facebook_square: number; instagram: number };
  team_logo_sizes: { facebook_square: number; instagram: number };
};

/** The subset of Customer the payload reads. */
export type PayloadCustomer = Pick<
  Customer,
  | 'id'
  | 'name'
  | 'type'
  | 'phone'
  | 'businessName'
  | 'businessAddress'
  | 'website'
  | 'contactEmail'
  | 'platformEmail'
  | 'otherEmails'
  | 'licenseNumber'
  | 'serviceOption'
  | 'mlsIds'
  | 'bio'
  | 'serviceAreas'
  | 'localContentAreas'
  | 'topics'
  | 'hashtags'
  | 'reviewSources'
  | 'gmbName'
  | 'zillowProfile'
  | 'agentPhoto'
  | 'productTier'
>;

export type PayloadBrokerage = { name: string; shortName: string; rejigBrokerId: string | null } | null;

export type AgentName = { firstName: string; lastName: string };

export type PayloadInput = {
  customer: PayloadCustomer;
  brokerage: PayloadBrokerage;
  /** Already resolved via resolveAgentName (possibly edited by the Account Creator). */
  name: AgentName;
  /** Already resolved via resolveIsTeam (possibly changed by the Account Creator). */
  isTeam: boolean;
  brandKit: BrandKit | null;
};

// Same labels the workspace "Intake Form Details" panel shows.
const REVIEW_SOURCE_LABELS: Record<string, string> = {
  google: 'Google',
  zillow: 'Zillow',
  testimonial_tree: 'Testimonial Tree',
};

/** Every current LaunchPad customer is a real estate agent. */
const INDUSTRY = 'Realtor';

function str(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  return v === '' ? null : v;
}

function list(values: string[] | null | undefined): string[] | null {
  const v = (values ?? []).map((s) => s.trim()).filter(Boolean);
  return v.length === 0 ? null : v;
}

/** Rejig rejects a website without a scheme; intake often stores bare domains. */
export function normalizeWebsite(raw: string | null | undefined): string | null {
  const v = str(raw);
  if (!v) return null;
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

/** `other_emails` is free text in LaunchPad (comma / semicolon / newline separated). */
export function splitEmails(raw: string | null | undefined): string[] | null {
  return list((raw ?? '').split(/[,;\n]+/));
}

function brokerageLabel(brokerage: PayloadBrokerage): string | null {
  if (!brokerage) return null;
  return str(brokerage.shortName) ?? str(brokerage.name);
}

function managedBy(customer: PayloadCustomer, brokerage: PayloadBrokerage): string | null {
  if (customer.serviceOption === 'Self-Managed') return 'Agent (self-managed)';
  if (customer.serviceOption === 'Brokerage-Managed') {
    return `${brokerageLabel(brokerage) ?? 'Brokerage'} Marketing Team`;
  }
  return null;
}

function sizes(s: LogoSizes): { facebook_square: number; instagram: number } {
  return { facebook_square: s.facebookSquare, instagram: s.instagram };
}

export type NameSource = 'saved' | 'roster' | 'guessed';

export type ResolvedName = AgentName & { source: NameSource };

/**
 * First / last name for Rejig. LaunchPad stores only `name`, which for teams
 * is the business ("The Zeuner Team"), not the agent. Preference order:
 * names the Account Creator saved on an earlier sync, then the DMG roster,
 * then a split of `name` — flagged 'guessed' so the panel can show it red.
 */
export function resolveAgentName(args: {
  saved?: Partial<AgentName> | null;
  roster?: { firstName: string | null; lastName: string | null } | null;
  name: string;
}): ResolvedName {
  const savedFirst = str(args.saved?.firstName);
  const savedLast = str(args.saved?.lastName);
  if (savedFirst && savedLast) {
    return { firstName: savedFirst, lastName: savedLast, source: 'saved' };
  }
  const rosterFirst = str(args.roster?.firstName);
  const rosterLast = str(args.roster?.lastName);
  if (rosterFirst && rosterLast) {
    return { firstName: rosterFirst, lastName: rosterLast, source: 'roster' };
  }
  // Drop a trailing ", PA" / ", REALTOR" style designation before splitting.
  const base = (args.name ?? '').split(',')[0].trim().replace(/\s+/g, ' ');
  const space = base.indexOf(' ');
  return space === -1
    ? { firstName: base, lastName: '', source: 'guessed' }
    : { firstName: base.slice(0, space), lastName: base.slice(space + 1), source: 'guessed' };
}

/**
 * Team ("we / us") or individual ("I / me") voice for the Rejig account. The
 * Account Creator's saved choice wins; otherwise guess from the names
 * ("The Zeuner Team", "Hora Group") so the panel can flag it for a check.
 */
export function resolveIsTeam(args: {
  saved: boolean | null | undefined;
  names: (string | null | undefined)[];
}): { isTeam: boolean; source: 'saved' | 'guessed' } {
  if (typeof args.saved === 'boolean') return { isTeam: args.saved, source: 'saved' };
  return { isTeam: args.names.some((n) => /\b(team|group)\b/i.test(n ?? '')), source: 'guessed' };
}

/**
 * Reasons the sync must not run. Empty = ready. Rejig itself rejects a
 * missing / invalid website (400); names and the brand kit are our rule
 * (no empty data pushed — decision D4).
 */
export function syncPreflight(input: PayloadInput): string[] {
  return [...nameMissing(input.name), ...recordMissing(input.customer, input.brokerage, input.brandKit)];
}

/** Gaps in the stored record — what the sync panel lists while names are still being typed. */
export function recordMissing(
  customer: Pick<PayloadCustomer, 'website' | 'productTier'>,
  brokerage: PayloadBrokerage,
  brandKit: BrandKit | null,
): string[] {
  return [
    ...(normalizeWebsite(customer.website) ? [] : ['Website']),
    // A brokerage agent sent without broker_id would land in Rejig unattached.
    ...(brokerage && !str(brokerage.rejigBrokerId) ? ["Brokerage's Rejig ID (ask an admin)"] : []),
    ...brandKitMissing(brandKit, customer.productTier),
  ];
}

export function nameMissing(name: AgentName): string[] {
  return [...(str(name.firstName) ? [] : ['First name']), ...(str(name.lastName) ? [] : ['Last name'])];
}

export function buildRejigPayload(input: PayloadInput): RejigCustomerPayload {
  const { customer, brokerage, name, brandKit: kit } = input;
  const fonts = kit?.applyCustomFont
    ? (['primary', 'secondary', 'tertiary'] as const).flatMap((type) => {
        const f = kit.fonts?.[type];
        return f ? [{ type, font: f.value, line_height: f.lineHeight }] : [];
      })
    : [];

  return {
    source_customer_id: customer.id,
    first_name: name.firstName.trim(),
    last_name: name.lastName.trim(),
    is_team: input.isTeam,
    business_name: str(customer.businessName) ?? customer.name.trim(),
    website: normalizeWebsite(customer.website) ?? '',
    phone: str(customer.phone),
    business_address: str(customer.businessAddress),
    signin_email: str(customer.contactEmail),
    platform_email: str(customer.platformEmail),
    other_emails: splitEmails(customer.otherEmails),
    license_number: str(customer.licenseNumber),
    managed_by: managedBy(customer, brokerage),
    mls_ids: str(customer.mlsIds),
    bio: str(customer.bio),
    monthly_market_reports: str(customer.serviceAreas),
    neighborhood_news: str(customer.localContentAreas),
    topics: str(customer.topics),
    hashtags: str(customer.hashtags),
    review_sources: str(
      (customer.reviewSources ?? []).map((s) => REVIEW_SOURCE_LABELS[s] ?? s).join(', '),
    ),
    google_business_name: str(customer.gmbName),
    google_place_id: null,
    zillow: str(customer.zillowProfile),
    account_type: customer.productTier ?? null,
    footer_label: str(kit?.footerLabel),
    customer_type: customer.type,
    associated_brokerage: str(brokerage?.rejigBrokerId),
    industry: INDUSTRY,
    generate_brand_template: null,
    pick_specific_to_search_tag: null,
    image_custom_search_tags: list(kit?.imageSearchTags),
    video_custom_search_tags: list(kit?.videoSearchTags),
    affiliation: str(kit?.affiliation?.value),
    other_affiliation: str(kit?.otherAffiliation),
    blog_page_url: null,
    profile_image_url: str(customer.agentPhoto?.[0]?.url),
    headshot_url: str(kit?.logos?.headshot?.url) ?? str(customer.agentPhoto?.[0]?.url),
    logo_url: str(kit?.logos?.primary?.url),
    logo_black_url: str(kit?.logos?.black?.url),
    logo_white_url: str(kit?.logos?.white?.url),
    domain_color_palette: list(kit?.palette),
    derived_logos: list(kit?.logoSelection),
    team_derived_logos: list(kit?.teamLogoSelection),
    apply_custom_font: kit?.applyCustomFont ?? false,
    apply_fixed_logo_height: kit?.applyFixedLogoHeight ?? false,
    font: fonts.length > 0 ? fonts : null,
    brand_logo_sizes: sizes(kit?.brandLogoSizes ?? DEFAULT_LOGO_SIZES),
    team_logo_sizes: sizes(kit?.teamLogoSizes ?? DEFAULT_LOGO_SIZES),
  };
}
