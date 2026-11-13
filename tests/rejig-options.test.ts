import { describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }));

const { parseAffiliations, parseFonts } = await import('@/lib/integrations/rejig/options');

describe('parseAffiliations', () => {
  const body = {
    code: 200,
    status: true,
    data: {
      industries: [
        { _id: 'ind-chiro', industrie: 'Chiropractor' },
        { _id: 'ind-realtor', industrie: 'Realtor' },
      ],
      affiliations: [
        { _id: 'a1', name: 'Century 21', industrie_id: 'ind-realtor' },
        { _id: 'a2', name: 'Spine Assoc', industrie_id: 'ind-chiro' },
        { _id: 'a3', name: 'Berkshire Hathaway', industrie_id: 'ind-realtor' },
        { _id: 'a4', name: 'Century 21', industrie_id: 'ind-realtor' },
      ],
    },
  };

  it('keeps Realtor affiliations by name, sorted and de-duplicated', () => {
    expect(parseAffiliations(body)).toEqual([
      { value: 'Berkshire Hathaway', label: 'Berkshire Hathaway' },
      { value: 'Century 21', label: 'Century 21' },
    ]);
  });

  it('shows nothing when there is no Realtor industry', () => {
    expect(parseAffiliations({ data: { industries: [], affiliations: body.data.affiliations } })).toEqual([]);
  });

  it('accepts affiliations at the top level', () => {
    expect(parseAffiliations({ data: { industries: body.data.industries }, affiliations: body.data.affiliations }))
      .toHaveLength(2);
  });

  it('survives junk', () => {
    expect(parseAffiliations(null)).toEqual([]);
    expect(parseAffiliations({ data: 'nope' })).toEqual([]);
  });
});

describe('parseFonts', () => {
  it('collapses weights into one option per fontFamily, sorted', () => {
    expect(
      parseFonts({
        status: true,
        data: [
          { id: 'inter-bold', label: 'Inter Bold', fontFamily: 'Inter' },
          { id: 'abeezee-regular-italic', label: 'ABeeZee Regular Italic', fontFamily: 'ABeeZee' },
          { id: 'inter-regular', label: 'Inter Regular', fontFamily: 'Inter' },
          { id: 'no-family', label: 'No family' },
        ],
      }),
    ).toEqual([
      { value: 'ABeeZee', label: 'ABeeZee' },
      { value: 'Inter', label: 'Inter' },
    ]);
  });
});
