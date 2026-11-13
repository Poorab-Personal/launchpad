/**
 * Rejig account-sync payload builder + brand-kit completeness.
 *
 * Locks the field mapping in docs/plans/rejig-account-sync.md: which LaunchPad
 * field feeds which Rejig key, empty → null, the name-resolution order
 * (saved → roster → guessed), and the "no empty data pushed" pre-flight.
 */
import { describe, it, expect } from 'vitest';
import {
  brandKitMissing,
  emptyBrandKit,
  parseBrandKit,
  sanitizeBrandKitFields,
  type BrandKit,
} from '@/lib/brand-kit';
import {
  buildRejigPayload,
  normalizeWebsite,
  resolveAgentName,
  splitEmails,
  syncPreflight,
  resolveIsTeam,
  type PayloadCustomer,
} from '@/lib/rejig-sync/payload';

function customer(overrides: Partial<PayloadCustomer> = {}): PayloadCustomer {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Kenny Hora',
    type: 'B2B',
    phone: '(319) 651-9335',
    businessName: 'Kenny Hora',
    businessAddress: '226 East 2nd Street, Muscatine, IA',
    website: 'kennyhora.ruhlhomes.com',
    contactEmail: 'kennyhora@ruhlhomes.com',
    platformEmail: 'kennyhora@ruhlhomes.com',
    otherEmails: '',
    licenseNumber: 'S72575000',
    serviceOption: 'Self-Managed',
    mlsIds: 'Muscatine MLS: hok',
    bio: 'Bio text',
    serviceAreas: 'MUSCATINE COUNTY, SCOTT COUNTY',
    localContentAreas: 'MUSCATINE, WEST LIBERTY',
    topics: 'FIRST TIME BUYERS, LANDLORDS',
    hashtags: '',
    reviewSources: ['google', 'testimonial_tree'],
    gmbName: 'Kenny Hora, Realtor',
    zillowProfile: '',
    agentPhoto: [{ url: 'https://x.public.blob.vercel-storage.com/headshot.png' }],
    productTier: 'Premium',
    ...overrides,
  };
}

function completeKit(overrides: Partial<BrandKit> = {}): BrandKit {
  return {
    ...emptyBrandKit(),
    logos: {
      primary: { url: 'https://x.public.blob.vercel-storage.com/logo.png' },
      black: { url: 'https://x.public.blob.vercel-storage.com/logo-black.png' },
    },
    palette: ['#00395d', '#FFFFFF', '#F1C400', '#F2F2F2', '#666666'],
    logoSelection: ['logo_white', 'logo', 'logo_black', 'logo', 'logo_white'],
    teamLogoSelection: ['logo_white', 'logo', 'logo_black', 'logo', 'logo_black'],
    footerLabel: 'Kenny-Hora-Ruhl-Footer',
    affiliation: { value: 'ruhl', label: 'Ruhl & Ruhl' },
    ...overrides,
  };
}

const ruhl = { name: 'RuhlHomes', shortName: 'Ruhl', rejigBrokerId: 'ruhl' };
const name = { firstName: 'Kenny', lastName: 'Hora' };

describe('buildRejigPayload', () => {
  it('maps intake fields and brokerage', () => {
    const p = buildRejigPayload({ customer: customer(), brokerage: ruhl, isTeam: false, name, brandKit: completeKit() });
    expect(p.source_customer_id).toBe('11111111-1111-1111-1111-111111111111');
    expect(p.first_name).toBe('Kenny');
    expect(p.website).toBe('https://kennyhora.ruhlhomes.com');
    expect(p.signin_email).toBe('kennyhora@ruhlhomes.com');
    expect(p.monthly_market_reports).toBe('MUSCATINE COUNTY, SCOTT COUNTY');
    expect(p.neighborhood_news).toBe('MUSCATINE, WEST LIBERTY');
    expect(p.review_sources).toBe('Google, Testimonial Tree');
    expect(p.managed_by).toBe('Agent (self-managed)');
    expect(p.customer_type).toBe('B2B');
    expect(p.associated_brokerage).toBe('ruhl');
    expect(p).not.toHaveProperty('broker');
    expect(p.industry).toBe('Realtor');
    expect(p.account_type).toBe('Premium');
    expect(p.profile_image_url).toBe('https://x.public.blob.vercel-storage.com/headshot.png');
  });

  it('sends empty strings as null', () => {
    const p = buildRejigPayload({ customer: customer(), brokerage: ruhl, isTeam: false, name, brandKit: completeKit() });
    expect(p.hashtags).toBeNull();
    expect(p.zillow).toBeNull();
    expect(p.other_emails).toBeNull();
    expect(p.logo_white_url).toBeNull();
    expect(p.image_custom_search_tags).toBeNull();
  });

  it('maps the brand kit', () => {
    const p = buildRejigPayload({ customer: customer(), brokerage: ruhl, isTeam: false, name, brandKit: completeKit() });
    expect(p.logo_url).toBe('https://x.public.blob.vercel-storage.com/logo.png');
    expect(p.logo_black_url).toBe('https://x.public.blob.vercel-storage.com/logo-black.png');
    expect(p.domain_color_palette).toHaveLength(5);
    expect(p.derived_logos).toEqual(['logo_white', 'logo', 'logo_black', 'logo', 'logo_white']);
    expect(p.team_derived_logos).toEqual(['logo_white', 'logo', 'logo_black', 'logo', 'logo_black']);
    expect(p.footer_label).toBe('Kenny-Hora-Ruhl-Footer');
    expect(p.affiliation).toBe('ruhl');
    expect(p.brand_logo_sizes).toEqual({ facebook_square: 100, instagram: 100 });
    expect(p.apply_custom_font).toBe(false);
    expect(p.font).toBeNull();
  });

  it('sends fonts only when custom font is on', () => {
    const kit = completeKit({
      applyCustomFont: true,
      fonts: {
        primary: { value: 'Montserrat', label: 'Montserrat', lineHeight: 1.2 },
        secondary: { value: 'Lora', label: 'Lora', lineHeight: 1.5 },
        tertiary: { value: 'Open Sans', label: 'Open Sans', lineHeight: 1 },
      },
    });
    const p = buildRejigPayload({ customer: customer(), brokerage: ruhl, isTeam: false, name, brandKit: kit });
    expect(p.apply_custom_font).toBe(true);
    expect(p.font).toEqual([
      { type: 'primary', font: 'Montserrat', line_height: 1.2 },
      { type: 'secondary', font: 'Lora', line_height: 1.5 },
      { type: 'tertiary', font: 'Open Sans', line_height: 1 },
    ]);
  });

  it('sends the designer headshot, else the profile photo', () => {
    const photo = { url: 'https://x.public.blob.vercel-storage.com/photo.jpg', filename: 'photo.jpg' };
    const shot = { url: 'https://x.public.blob.vercel-storage.com/headshot.png', filename: 'headshot.png' };
    const c = customer({ agentPhoto: [photo] });
    const without = buildRejigPayload({ customer: c, brokerage: ruhl, isTeam: false, name, brandKit: completeKit() });
    expect(without.headshot_url).toBe(photo.url);
    const kit = completeKit();
    const withShot = buildRejigPayload({
      customer: c,
      brokerage: ruhl, isTeam: false,
      name,
      brandKit: { ...kit, logos: { ...kit.logos, headshot: shot } },
    });
    expect(withShot.headshot_url).toBe(shot.url);
    expect(withShot.profile_image_url).toBe(photo.url);
  });

  it('labels brokerage-managed agents with the brokerage team', () => {
    const p = buildRejigPayload({
      customer: customer({ serviceOption: 'Brokerage-Managed' }),
      brokerage: ruhl, isTeam: false,
      name,
      brandKit: completeKit(),
    });
    expect(p.managed_by).toBe('Ruhl Marketing Team');
  });

  it('has no brokerage for D2C and falls back to name for business name', () => {
    const p = buildRejigPayload({
      customer: customer({ type: 'D2C', serviceOption: null, businessName: '' }),
      brokerage: null, isTeam: false,
      name,
      brandKit: completeKit(),
    });
    expect(p.associated_brokerage).toBeNull();
    expect(p.managed_by).toBeNull();
    expect(p.business_name).toBe('Kenny Hora');
  });

  it('falls back to the full brokerage name when short name is empty', () => {
    const p = buildRejigPayload({
      customer: customer({ serviceOption: 'Brokerage-Managed' }),
      brokerage: { name: 'Coach Realtors', shortName: '', rejigBrokerId: 'coach' }, isTeam: false,
      name,
      brandKit: completeKit(),
    });
    expect(p.managed_by).toBe('Coach Realtors Marketing Team');
    expect(p.associated_brokerage).toBe('coach');
  });
});

describe('is_team', () => {
  it('sends the resolved voice', () => {
    const p = buildRejigPayload({ customer: customer(), brokerage: ruhl, isTeam: true, name, brandKit: completeKit() });
    expect(p.is_team).toBe(true);
  });

  it('prefers the saved choice, else guesses from team / group in the names', () => {
    expect(resolveIsTeam({ saved: false, names: ['The Zeuner Team'] })).toEqual({ isTeam: false, source: 'saved' });
    expect(resolveIsTeam({ saved: null, names: ['The Zeuner Team'] })).toEqual({ isTeam: true, source: 'guessed' });
    expect(resolveIsTeam({ saved: null, names: ['Kenny Hora', 'Hora Group LLC'] }).isTeam).toBe(true);
    expect(resolveIsTeam({ saved: null, names: ['Kenny Hora', null] })).toEqual({ isTeam: false, source: 'guessed' });
    expect(resolveIsTeam({ saved: null, names: ['Steamboat Realty'] }).isTeam).toBe(false);
  });
});

describe('helpers', () => {
  it('normalizes websites', () => {
    expect(normalizeWebsite('a.keyes.com')).toBe('https://a.keyes.com');
    expect(normalizeWebsite('http://a.com')).toBe('http://a.com');
    expect(normalizeWebsite('  ')).toBeNull();
  });

  it('splits other emails', () => {
    expect(splitEmails('a@x.com, b@x.com;c@x.com\nd@x.com')).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
      'd@x.com',
    ]);
    expect(splitEmails('')).toBeNull();
  });
});

describe('resolveAgentName', () => {
  it('prefers saved names', () => {
    expect(
      resolveAgentName({
        saved: { firstName: 'Shari', lastName: 'Zeuner' },
        roster: { firstName: 'X', lastName: 'Y' },
        name: 'The Zeuner Team',
      }),
    ).toEqual({ firstName: 'Shari', lastName: 'Zeuner', source: 'saved' });
  });

  it('uses the roster next', () => {
    expect(
      resolveAgentName({ roster: { firstName: 'Shari', lastName: 'Zeuner' }, name: 'The Zeuner Team' }),
    ).toEqual({ firstName: 'Shari', lastName: 'Zeuner', source: 'roster' });
  });

  it('ignores a half-filled roster row and guesses from name', () => {
    expect(resolveAgentName({ roster: { firstName: 'Shari', lastName: '' }, name: 'Shari Zeuner' })).toEqual({
      firstName: 'Shari',
      lastName: 'Zeuner',
      source: 'guessed',
    });
  });

  it('strips designations and keeps compound surnames', () => {
    expect(resolveAgentName({ name: 'Stacia McCallum, PA' })).toMatchObject({
      firstName: 'Stacia',
      lastName: 'McCallum',
    });
    expect(resolveAgentName({ name: 'Maria de la Cruz' })).toMatchObject({
      firstName: 'Maria',
      lastName: 'de la Cruz',
    });
  });

  it('leaves last name empty for a single word', () => {
    expect(resolveAgentName({ name: 'Cher' })).toEqual({ firstName: 'Cher', lastName: '', source: 'guessed' });
  });
});

describe('brandKitMissing', () => {
  it('is empty for a complete kit (black/white logos optional)', () => {
    expect(brandKitMissing(completeKit({ logos: { primary: { url: 'https://x/l.png' } } }), 'Luxury')).toEqual([]);
  });

  it('lists everything required for a missing kit', () => {
    expect(brandKitMissing(null, null)).toEqual([
      'Primary logo',
      'Palette (5 colours)',
      'Logo selection',
      'Team logo selection',
      'Account type',
      'Footer label',
      'Affiliation',
    ]);
  });

  it('rejects short palettes, bad hex, and partial selections', () => {
    const missing = brandKitMissing(
      completeKit({
        palette: ['#00395d', 'white', '#F1C400', '#F2F2F2', '#666666'],
        logoSelection: ['logo', 'logo'],
      }),
      'Premium',
    );
    expect(missing).toEqual(['Palette (5 colours)', 'Logo selection']);
  });

  it('requires all three fonts only when custom font is on', () => {
    const kit = completeKit({
      applyCustomFont: true,
      fonts: { primary: { value: 'Inter', label: 'Inter', lineHeight: 1 } },
    });
    expect(brandKitMissing(kit, 'Premium')).toEqual(['Fonts + line heights']);
    expect(brandKitMissing({ ...kit, applyCustomFont: false }, 'Premium')).toEqual([]);
  });
});

describe('syncPreflight', () => {
  it('blocks on website, names and the brand kit', () => {
    expect(
      syncPreflight({
        customer: customer({ website: '', productTier: null }),
        brokerage: ruhl, isTeam: false,
        name: { firstName: 'Kenny', lastName: '' },
        brandKit: completeKit(),
      }),
    ).toEqual(['Last name', 'Website', 'Account type']);
  });

  it("blocks a brokerage agent whose brokerage has no Rejig id", () => {
    expect(
      syncPreflight({
        customer: customer(),
        brokerage: { ...ruhl, rejigBrokerId: null }, isTeam: false,
        name,
        brandKit: completeKit(),
      }),
    ).toEqual(["Brokerage's Rejig ID (ask an admin)"]);
  });

  it('passes a complete customer', () => {
    expect(syncPreflight({ customer: customer(), brokerage: ruhl, isTeam: false, name, brandKit: completeKit() })).toEqual([]);
  });
});

describe('sanitizeBrandKitFields / parseBrandKit', () => {
  it('coerces junk form input into a safe draft', () => {
    const f = sanitizeBrandKitFields({
      palette: ['#00395D', '#fff', 42, '#F2F2F2', '#666666', '#EXTRA0'],
      logoSelection: ['logo', 'not-a-variant'],
      applyCustomFont: 'yes',
      fonts: { primary: { value: 'Inter', lineHeight: '1.15' }, secondary: { value: '' } },
      brandLogoSizes: { facebookSquare: -5, instagram: '80' },
      footerLabel: '  Keyes-Deb-Slavin-Footer  ',
      affiliation: { value: 'Keyes' },
      imageSearchTags: ['keyes', 'keyes', '', 'luxury'],
      logos: { primary: { url: 'https://evil.example/x.png' } },
    });
    expect(f.palette).toEqual(['#00395D', '#fff', '', '#F2F2F2', '#666666']);
    expect(f.logoSelection).toEqual(['logo', 'logo']);
    expect(f.applyCustomFont).toBe(false);
    expect(f.fonts.primary).toEqual({ value: 'Inter', label: 'Inter', lineHeight: 1.15 });
    expect(f.fonts.secondary).toBeUndefined();
    expect(f.brandLogoSizes).toEqual({ facebookSquare: 100, instagram: 80 });
    expect(f.footerLabel).toBe('Keyes-Deb-Slavin-Footer');
    expect(f.affiliation).toEqual({ value: 'Keyes', label: 'Keyes' });
    expect(f.imageSearchTags).toEqual(['keyes', 'luxury']);
    // The form never writes logos — they have their own action.
    expect('logos' in f).toBe(false);
  });

  it('parses stored kits and rejects non-objects', () => {
    expect(parseBrandKit(null)).toBeNull();
    expect(parseBrandKit([])).toBeNull();
    const k = parseBrandKit({ logos: { primary: { url: 'https://x/l.png', filename: 'l.png' } }, footerLabel: 'F' });
    expect(k?.logos.primary?.url).toBe('https://x/l.png');
    expect(k?.logos.black).toBeUndefined();
    expect(k?.footerLabel).toBe('F');
    expect(k?.brandLogoSizes).toEqual({ facebookSquare: 100, instagram: 100 });
  });
});
