/**
 * Temp password derivation + resolution.
 *
 * The temp password is a single source of truth used across four surfaces
 * (Send Credentials panel, credentials email, portal Sign In task, Handy
 * page). These lock the documented rule — including the empty-name → email
 * local-part fallback that fixed the "Welcome123!" bug for roster customers
 * whose name came in blank — and the stored-value-wins resolver.
 */
import { describe, it, expect } from 'vitest';
import { tempPasswordFromName, resolveTempPassword } from '@/lib/temp-password';

describe('tempPasswordFromName', () => {
  it('derives Lastname123! from a normal name', () => {
    expect(tempPasswordFromName('John Smith')).toBe('Smith123!');
    expect(tempPasswordFromName('Sooji Hill')).toBe('Hill123!');
  });

  it('pads short surnames to the 8-char minimum', () => {
    expect(tempPasswordFromName('Christina Day')).toBe('Day1234!');
  });

  it('preserves mixed case and strips suffixes/diacritics', () => {
    expect(tempPasswordFromName('Susan DeSantis')).toBe('DeSantis123!');
    expect(tempPasswordFromName('John Smith III')).toBe('Smith123!');
    expect(tempPasswordFromName('Stacia McCallum, PA')).toBe('McCallum123!');
    expect(tempPasswordFromName('Maria González')).toBe('Gonzalez123!');
  });

  it('falls back to the email local-part when the name is empty', () => {
    expect(tempPasswordFromName('', 'sooji.hill@bairdwarner.com')).toBe('Hill123!');
    expect(tempPasswordFromName('   ', 'amy.hill@bairdwarner.com')).toBe('Hill123!');
    // dotless local-part → single token
    expect(tempPasswordFromName('', 'jsmith@keyes.com')).toBe('Jsmith123!');
  });

  it('returns Welcome123! only when neither name nor email is usable', () => {
    expect(tempPasswordFromName('')).toBe('Welcome123!');
    expect(tempPasswordFromName('', '')).toBe('Welcome123!');
  });

  it('prefers the name over the email when both are present', () => {
    expect(tempPasswordFromName('Jane Doe', 'sooji.hill@bairdwarner.com')).toBe('Doe1234!');
  });
});

describe('resolveTempPassword', () => {
  it('returns the stored value verbatim when present', () => {
    expect(
      resolveTempPassword({ tempPassword: 'CustomPass9!', name: 'Sooji Hill', platformEmail: 'sooji.hill@bairdwarner.com' }),
    ).toBe('CustomPass9!');
  });

  it('derives from name when nothing is stored', () => {
    expect(
      resolveTempPassword({ tempPassword: null, name: 'Sooji Hill', platformEmail: 'sooji.hill@bairdwarner.com' }),
    ).toBe('Hill123!');
  });

  it('derives from platform email when stored and name are both empty', () => {
    expect(
      resolveTempPassword({ tempPassword: '', name: '', platformEmail: 'sooji.hill@bairdwarner.com' }),
    ).toBe('Hill123!');
  });

  it('ignores a whitespace-only stored value and derives instead', () => {
    expect(
      resolveTempPassword({ tempPassword: '   ', name: 'Sooji Hill', platformEmail: null }),
    ).toBe('Hill123!');
  });
});
