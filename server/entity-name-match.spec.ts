import { resolveEntityByName, nameMatchScore, entityNameForms, NameMatchable } from './entity-name-match';

const ALICE: NameMatchable = { id: 'e-alice', name: 'Alice Mercer', firstName: 'Alice', lastName: 'Mercer' };
const DALE: NameMatchable = { id: 'e-dale', name: 'Dale', aliases: ['Dale Atkinson'] };
const ATKINSON: NameMatchable = { id: 'e-tyrice', name: 'Tyrice Atkinson', firstName: 'Tyrice', lastName: 'Atkinson', title: 'General' };
const SERIES = [ALICE, DALE, ATKINSON];

describe('resolveEntityByName', () => {
  it('matches an entity by its exact name', () => {
    expect(resolveEntityByName('Dale', SERIES)?.id).toBe('e-dale');
  });

  it('matches by first name, last name, alias, and title', () => {
    expect(resolveEntityByName('Tyrice', SERIES)?.id).toBe('e-tyrice');
    expect(resolveEntityByName('Atkinson', SERIES)?.id).toBe('e-tyrice');
    expect(resolveEntityByName('Dale Atkinson', SERIES)?.id).toBe('e-dale');
    expect(resolveEntityByName('General', SERIES)?.id).toBe('e-tyrice');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(resolveEntityByName('  alice mercer  ', SERIES)?.id).toBe('e-alice');
  });

  // The reported bug: an event about "Alred" — a character not in the series —
  // must NOT be attributed to an unrelated entity like Alice Mercer.
  it('returns null when the name does not match any known entity', () => {
    expect(resolveEntityByName('Alred', SERIES)).toBeNull();
    expect(resolveEntityByName('Alice', SERIES)?.id).toBe('e-alice'); // sanity: a real match still resolves
  });

  it('returns null for empty or non-string input', () => {
    expect(resolveEntityByName('', SERIES)).toBeNull();
    expect(resolveEntityByName('   ', SERIES)).toBeNull();
    expect(resolveEntityByName(undefined, SERIES)).toBeNull();
    expect(resolveEntityByName(null, SERIES)).toBeNull();
  });

  it('returns null when a name is ambiguous across multiple entities', () => {
    const twins = [
      { id: 'e-1', name: 'Jordan Vale', firstName: 'Jordan', lastName: 'Vale' },
      { id: 'e-2', name: 'Jordan Reese', firstName: 'Jordan', lastName: 'Reese' },
    ];
    expect(resolveEntityByName('Jordan', twins)).toBeNull();
    // ...but a fully-qualified name disambiguates.
    expect(resolveEntityByName('Jordan Vale', twins)?.id).toBe('e-1');
  });

  it('prefers an exact match over a weaker whole-word match', () => {
    const list = [
      { id: 'e-full', name: 'Atkinson Hall' },
      { id: 'e-exact', name: 'Atkinson' },
    ];
    expect(resolveEntityByName('Atkinson', list)?.id).toBe('e-exact');
  });
});

describe('nameMatchScore', () => {
  it('scores exact, whole-word, and no match', () => {
    expect(nameMatchScore(['Dale'], 'dale')).toBe(1);
    expect(nameMatchScore(['Dale Atkinson'], 'atkinson')).toBe(0.9);
    expect(nameMatchScore(['Dale'], 'dalek')).toBe(0);
  });

  it('does not match a substring that is not a whole word', () => {
    expect(nameMatchScore(['Alice'], 'ali')).toBe(0);
  });
});

describe('entityNameForms', () => {
  it('collects every non-empty name variant', () => {
    expect(entityNameForms(ATKINSON)).toEqual(
      expect.arrayContaining(['Tyrice Atkinson', 'Tyrice', 'Atkinson', 'General']),
    );
  });
});
