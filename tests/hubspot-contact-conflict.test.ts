/**
 * Contact-conflict recovery for the HubSpot intake push.
 *
 * When findContactByEmail misses but HubSpot's uniqueness check fires anyway
 * (search-index lag, or the email held as a secondary email elsewhere), the
 * push adopts the blocking contact instead of failing. Getting the WRONG id
 * out of the 400 body is the dangerous failure mode: HubSpot names two ids
 * and the first one is the half-allocated record the create was writing to.
 *
 * Fixtures are the verbatim messages from the 2026-09-14 Stacy Beck and
 * Jennifer Boyce alerts.
 */
import { describe, it, expect } from 'vitest';
import { parseConflictingContactId } from '@/lib/integrations/hubspot/intake-handler';

const STACY_BECK_400 = `HTTP-Code: 400
Message: An error occurred.
Body: {"status":"error","message":"Cannot set PropertyValueCoordinates{portalId=44956899, objectTypeId=ObjectTypeId{legacyObjectType=CONTACT}, propertyName=email, value=stacybeckrealtor@gmail.com} on 552148386511. 552239500007 already has that value.","correlationId":"01a0a0eb-ea7a-7303-a6e2-a774cf30316a","category":"VALIDATION_ERROR"}`;

const JENNIFER_BOYCE_400 = `HTTP-Code: 400
Message: An error occurred.
Body: {"status":"error","message":"Cannot set PropertyValueCoordinates{portalId=44956899, objectTypeId=ObjectTypeId{legacyObjectType=CONTACT}, propertyName=email, value=jboyce@ipre.com} on 552226425567. 552313406190 already has that value.","correlationId":"01a0a0d9-e25d-7935-9666-708f656c8b4c","category":"VALIDATION_ERROR"}`;

describe('parseConflictingContactId', () => {
  it('picks the record that already has the email, not the half-allocated one', () => {
    // 552148386511 is the id the create was writing to — adopting it would
    // point LP at a contact that never got the email set.
    expect(parseConflictingContactId(new Error(STACY_BECK_400))).toBe('552239500007');
    expect(parseConflictingContactId(new Error(JENNIFER_BOYCE_400))).toBe('552313406190');
  });

  it('handles the 409 phrasing', () => {
    expect(
      parseConflictingContactId(new Error('Contact already exists. Existing ID: 512159482605')),
    ).toBe('512159482605');
  });

  it('accepts non-Error throwables', () => {
    expect(parseConflictingContactId(STACY_BECK_400)).toBe('552239500007');
  });

  it('returns null for unrelated failures so the caller rethrows', () => {
    expect(parseConflictingContactId(new Error('HTTP-Code: 429\nMessage: rate limited'))).toBeNull();
    expect(parseConflictingContactId(new Error('socket hang up'))).toBeNull();
    expect(parseConflictingContactId(undefined)).toBeNull();
  });
});
