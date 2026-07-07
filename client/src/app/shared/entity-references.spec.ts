import { Entity } from '@shared/models/entity.model';
import { entityNameVariants, annotateEntityReferences, entityIdFromClick } from './entity-references';

function makeEntity(overrides: Partial<Entity>): Entity {
  return {
    id: 'e-1',
    name: 'Arthur Dent',
    type: 'PERSON',
    seriesId: 's-1',
    ...overrides,
  };
}

describe('entityNameVariants', () => {
  it('derives first and last name from a two-part PERSON name', () => {
    const variants = entityNameVariants(makeEntity({ name: 'Arthur Dent' }));
    expect(variants).toEqual(['Arthur Dent', 'Arthur', 'Dent']);
  });

  it('derives last name from the final word of a multi-part name', () => {
    const variants = entityNameVariants(makeEntity({ name: 'Johann Sebastian Bach' }));
    expect(variants).toContain('Johann');
    expect(variants).toContain('Bach');
    expect(variants).not.toContain('Sebastian');
  });

  it('prefers explicit firstName/lastName over derived ones', () => {
    const variants = entityNameVariants(
      makeEntity({ name: 'Arthur Dent', firstName: 'Art', lastName: 'Denton' })
    );
    expect(variants).toContain('Art');
    expect(variants).toContain('Denton');
    expect(variants).not.toContain('Arthur');
  });

  it('does not derive first/last name from a single-word name', () => {
    expect(entityNameVariants(makeEntity({ name: 'Zaphod' }))).toEqual(['Zaphod']);
  });

  it('includes nickname, title variants, and aliases', () => {
    const variants = entityNameVariants(
      makeEntity({ name: 'Arthur Dent', nickname: 'Arty', title: 'Dr.', aliases: ['The Sandwich Maker'] })
    );
    expect(variants).toContain('Arty');
    expect(variants).toContain('Dr. Arthur Dent');
    expect(variants).toContain('Dr. Dent');
    expect(variants).toContain('The Sandwich Maker');
  });

  it('only exposes name and aliases for non-PERSON entities', () => {
    const variants = entityNameVariants(
      makeEntity({ name: 'Bag End', type: 'PLACE', title: 'The', aliases: ['The Hill'] })
    );
    expect(variants).toEqual(['Bag End', 'The Hill']);
  });

  it('filters out blank variants', () => {
    const variants = entityNameVariants(makeEntity({ name: 'Zaphod', aliases: ['', '  '] }));
    expect(variants).toEqual(['Zaphod']);
  });
});

describe('annotateEntityReferences', () => {
  const arthur = makeEntity({ id: 'arthur', name: 'Arthur Dent' });

  it('wraps whole-word mentions in an entity span', () => {
    const html = annotateEntityReferences('<p>Then Arthur Dent woke up.</p>', [arthur]);
    expect(html).toBe(
      '<p>Then <span class="qc-entity-ref" data-entity-id="arthur">Arthur Dent</span> woke up.</p>'
    );
  });

  it('matches case-insensitively but preserves the original text', () => {
    const html = annotateEntityReferences('<p>ARTHUR shouted.</p>', [arthur]);
    expect(html).toContain('data-entity-id="arthur">ARTHUR</span>');
  });

  it('does not match inside larger words', () => {
    const html = annotateEntityReferences('<p>The Dented car.</p>', [arthur]);
    expect(html).not.toContain('qc-entity-ref');
  });

  it('leaves text inside links, code, and existing entity spans alone', () => {
    const input =
      '<p><a href="#">Arthur</a> and <code>Arthur</code> and ' +
      '<span class="qc-entity-ref" data-entity-id="x">Arthur</span></p>';
    expect(annotateEntityReferences(input, [arthur])).toBe(input);
  });

  it('prefers the longest matching name when variants overlap', () => {
    const ford = makeEntity({ id: 'ford', name: 'Ford Prefect' });
    const prefect = makeEntity({ id: 'title', name: 'Prefect', type: 'THING' });
    const html = annotateEntityReferences('<p>Ford Prefect arrived.</p>', [prefect, ford]);
    expect(html).toContain('data-entity-id="ford">Ford Prefect</span>');
  });

  it('ignores deleted and archived entities', () => {
    const html = annotateEntityReferences('<p>Arthur Dent</p>', [
      makeEntity({ deleted: true }),
      makeEntity({ archived: true }),
    ]);
    expect(html).toBe('<p>Arthur Dent</p>');
  });

  it('returns the input unchanged for empty html or no entities', () => {
    expect(annotateEntityReferences('', [arthur])).toBe('');
    expect(annotateEntityReferences('<p>hi</p>', [])).toBe('<p>hi</p>');
  });

  it('annotates multiple mentions across text nodes', () => {
    const html = annotateEntityReferences('<p>Arthur met Dent.</p><p>Later, Arthur left.</p>', [arthur]);
    expect(html.match(/qc-entity-ref/g)?.length).toBe(3);
  });
});

describe('entityIdFromClick', () => {
  it('returns the entity id when a reference span is clicked', () => {
    const container = document.createElement('div');
    container.innerHTML = '<span class="qc-entity-ref" data-entity-id="e-42">Arthur</span>';
    const event = { target: container.querySelector('span') } as unknown as MouseEvent;
    expect(entityIdFromClick(event)).toBe('e-42');
  });

  it('returns null for clicks outside a reference span', () => {
    const container = document.createElement('div');
    container.innerHTML = '<p>plain</p>';
    const event = { target: container.querySelector('p') } as unknown as MouseEvent;
    expect(entityIdFromClick(event)).toBeNull();
  });
});
