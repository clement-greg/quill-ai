import { Request } from 'express';
import { withOwnerFilter, readOwnedItem, readAccessibleItem } from './owner-guard';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(email: string): Request {
  return { user: { email, sub: 'uid', name: 'Test', picture: '' } } as unknown as Request;
}

function makeContainer(resource: unknown) {
  return {
    item: (_id: string, _pk: string) => ({
      read: async () => ({ resource }),
    }),
  } as any;
}

// ── withOwnerFilter ───────────────────────────────────────────────────────────

describe('withOwnerFilter', () => {
  const EMAIL = 'alice@example.com';

  describe('with a plain email string as source', () => {
    it('adds WHERE clause when query has no WHERE', () => {
      const result = withOwnerFilter(EMAIL, 'SELECT * FROM c');
      expect(result.query).toBe('SELECT * FROM c WHERE c.owner = @_owner');
      expect(result.parameters).toEqual([{ name: '@_owner', value: EMAIL }]);
    });

    it('adds AND clause when query already has a WHERE', () => {
      const result = withOwnerFilter(EMAIL, 'SELECT * FROM c WHERE c.type = "book"');
      expect(result.query).toContain('AND c.owner = @_owner');
      expect(result.parameters).toEqual([{ name: '@_owner', value: EMAIL }]);
    });

    it('inserts owner filter before ORDER BY', () => {
      const result = withOwnerFilter(EMAIL, 'SELECT * FROM c ORDER BY c._ts DESC');
      expect(result.query).toMatch(/WHERE c\.owner = @_owner\s+ORDER BY/i);
      expect(result.query).not.toMatch(/ORDER BY.*WHERE/i);
    });

    it('inserts AND filter before ORDER BY when WHERE already present', () => {
      const sql = 'SELECT * FROM c WHERE c.type = "chapter" ORDER BY c._ts DESC';
      const result = withOwnerFilter(EMAIL, sql);
      expect(result.query).toMatch(/AND c\.owner = @_owner\s+ORDER BY/i);
    });
  });

  describe('with an Express Request as source', () => {
    it('uses req.user.email as the owner', () => {
      const req = makeReq('bob@example.com');
      const result = withOwnerFilter(req, 'SELECT * FROM c');
      expect(result.parameters).toEqual([{ name: '@_owner', value: 'bob@example.com' }]);
    });
  });

  describe('with a SqlQuerySpec as query', () => {
    it('appends the owner parameter to existing parameters', () => {
      const spec = {
        query: 'SELECT * FROM c WHERE c.type = @type',
        parameters: [{ name: '@type', value: 'book' }],
      };
      const result = withOwnerFilter(EMAIL, spec);
      expect(result.query).toContain('AND c.owner = @_owner');
      expect(result.parameters).toEqual([
        { name: '@type', value: 'book' },
        { name: '@_owner', value: EMAIL },
      ]);
    });

    it('works with a SqlQuerySpec that has no parameters array', () => {
      const spec = { query: 'SELECT * FROM c', parameters: [] };
      const result = withOwnerFilter(EMAIL, spec);
      expect(result.query).toBe('SELECT * FROM c WHERE c.owner = @_owner');
      expect(result.parameters).toEqual([{ name: '@_owner', value: EMAIL }]);
    });
  });
});

// ── readOwnedItem ─────────────────────────────────────────────────────────────

describe('readOwnedItem', () => {
  const EMAIL = 'alice@example.com';

  it('returns null when the resource does not exist', async () => {
    const container = makeContainer(undefined);
    const result = await readOwnedItem(container, 'id1', 'pk1', EMAIL);
    expect(result).toBeNull();
  });

  it('returns null when the resource is owned by a different user', async () => {
    const container = makeContainer({ id: 'id1', owner: 'other@example.com', data: 'x' });
    const result = await readOwnedItem(container, 'id1', 'pk1', EMAIL);
    expect(result).toBeNull();
  });

  it('returns the resource when the owner matches', async () => {
    const doc = { id: 'id1', owner: EMAIL, title: 'My Book' };
    const container = makeContainer(doc);
    const result = await readOwnedItem(container, 'id1', 'pk1', EMAIL);
    expect(result).toEqual(doc);
  });

  it('accepts a Request object as the source', async () => {
    const doc = { id: 'id1', owner: EMAIL };
    const container = makeContainer(doc);
    const result = await readOwnedItem(container, 'id1', 'pk1', makeReq(EMAIL));
    expect(result).toEqual(doc);
  });
});

// ── readAccessibleItem ────────────────────────────────────────────────────────

describe('readAccessibleItem', () => {
  const OWNER = 'alice@example.com';
  const COLLABORATOR = 'bob@example.com';
  const STRANGER = 'stranger@example.com';

  it('returns null when the resource does not exist', async () => {
    const container = makeContainer(undefined);
    const result = await readAccessibleItem(container, 'id1', 'pk1', OWNER);
    expect(result).toBeNull();
  });

  it('returns the resource when the user is the owner', async () => {
    const doc = { id: 'id1', owner: OWNER };
    const container = makeContainer(doc);
    const result = await readAccessibleItem(container, 'id1', 'pk1', OWNER);
    expect(result).toEqual(doc);
  });

  it('returns the resource when the user is listed as a collaborator', async () => {
    const doc = { id: 'id1', owner: OWNER, collaborators: [COLLABORATOR] };
    const container = makeContainer(doc);
    const result = await readAccessibleItem(container, 'id1', 'pk1', COLLABORATOR);
    expect(result).toEqual(doc);
  });

  it('returns null when the user is neither owner nor collaborator', async () => {
    const doc = { id: 'id1', owner: OWNER, collaborators: [COLLABORATOR] };
    const container = makeContainer(doc);
    const result = await readAccessibleItem(container, 'id1', 'pk1', STRANGER);
    expect(result).toBeNull();
  });

  it('returns null when collaborators is absent and user is not the owner', async () => {
    const doc = { id: 'id1', owner: OWNER };
    const container = makeContainer(doc);
    const result = await readAccessibleItem(container, 'id1', 'pk1', STRANGER);
    expect(result).toBeNull();
  });
});
