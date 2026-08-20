/**
 * Regression suite for the 2026-08-20 landing-page outage.
 *
 * DMG returned a suite line as a bare JSON number (`Address2: 201`), and
 * `office.Address2?.trim()` threw `TypeError: e?.trim is not a function`.
 * POST /api/agent-lookup 500'd, the browser's `res.json()` rejected on the
 * HTML error body, and EmailForm rendered "Network error. Please try again."
 * 83 alive Keyes/IPRE roster rows carried the bad shape.
 */
import { describe, it, expect } from 'vitest';
import {
  formatOfficeAddress,
  formatServiceAreas,
  stripHtml,
  text,
} from '../src/lib/roster/source-fields';

describe('text()', () => {
  it('passes trimmed strings through', () => {
    expect(text('  1400 Alton Rd  ')).toBe('1400 Alton Rd');
  });

  it('stringifies finite numbers instead of throwing', () => {
    expect(text(201)).toBe('201');
    expect(text(0)).toBe('0');
  });

  it('returns null for empty, nullish, and non-scalar values', () => {
    expect(text('')).toBeNull();
    expect(text('   ')).toBeNull();
    expect(text(null)).toBeNull();
    expect(text(undefined)).toBeNull();
    expect(text(NaN)).toBeNull();
    expect(text({ a: 1 })).toBeNull();
    expect(text(['x'])).toBeNull();
    expect(text(true)).toBeNull();
  });
});

describe('formatOfficeAddress()', () => {
  it('handles a numeric Address2 (the real Keyes/IPRE failure)', () => {
    // Verbatim shape from brokerage_roster.source_data.office for the
    // Keyes Miami Beach office — Address2 is the JSON number 201.
    const office = {
      Address1: '1400 Alton Rd,  ',
      Address2: 201,
      Address3: '',
      City: 'Miami Beach',
      State: 'FL',
    };
    expect(formatOfficeAddress(office)).toBe('1400 Alton Rd, 201, Miami Beach, FL');
  });

  it('joins the ordinary all-string case', () => {
    expect(
      formatOfficeAddress({
        Address1: '123 Main St',
        Address2: 'Suite 4',
        Address3: null,
        City: 'Chicago',
        State: 'IL',
      }),
    ).toBe('123 Main St Suite 4, Chicago, IL');
  });

  it('returns null for a missing or fully empty office', () => {
    expect(formatOfficeAddress(null)).toBeNull();
    expect(formatOfficeAddress(undefined)).toBeNull();
    expect(formatOfficeAddress({ Address1: '', City: null, State: undefined })).toBeNull();
  });
});

describe('formatServiceAreas()', () => {
  it('joins region names and drops internal "employees" regions', () => {
    expect(
      formatServiceAreas([
        { RegionName: 'Commercial' },
        { RegionName: 'Miami-Dade County' },
        { RegionName: 'Keyes Employees' },
      ]),
    ).toBe('Commercial, Miami-Dade County');
  });

  it('survives a numeric or malformed RegionName', () => {
    expect(
      formatServiceAreas([{ RegionName: 33139 }, { RegionName: null }, {}]),
    ).toBe('33139');
  });

  it('returns null for empty input', () => {
    expect(formatServiceAreas([])).toBeNull();
    expect(formatServiceAreas(null)).toBeNull();
  });
});

describe('stripHtml()', () => {
  it('flattens DMG bio HTML to plain text', () => {
    expect(stripHtml('<p>Hi &amp; welcome</p><br/><strong>Bob</strong>')).toBe(
      'Hi & welcome\n\nBob',
    );
  });

  it('does not throw on a non-string bio', () => {
    expect(stripHtml(12345)).toBe('12345');
    expect(stripHtml(null)).toBeNull();
    expect(stripHtml({})).toBeNull();
  });
});
