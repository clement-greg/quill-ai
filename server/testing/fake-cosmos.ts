/**
 * In-memory stand-in for the Cosmos containers, for route-level tests.
 *
 * Supports the operations the routes actually use: point reads/replaces/deletes,
 * create/upsert, and SQL queries built from the WHERE-clause patterns that appear
 * in this codebase:
 *   - `c.field = @param` / `c.field = true|false`
 *   - `(NOT IS_DEFINED(c.field) OR c.field = false)`
 *   - `(c.owner = @owner OR ARRAY_CONTAINS(c.collaborators, @email))`
 * All clauses combine conjunctively, which matches every query the routes issue.
 */

export type FakeDoc = { id: string } & Record<string, unknown>;

interface QuerySpec {
  query: string;
  parameters?: { name: string; value: unknown }[];
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function notFound(): Error & { code: number } {
  return Object.assign(new Error('Entity with the specified id does not exist'), { code: 404 });
}

export class FakeContainer {
  private docs = new Map<string, FakeDoc>();

  seed(...docs: FakeDoc[]): void {
    for (const doc of docs) this.docs.set(doc.id, clone(doc));
  }

  get(id: string): FakeDoc | undefined {
    const doc = this.docs.get(id);
    return doc ? clone(doc) : undefined;
  }

  clear(): void {
    this.docs.clear();
  }

  item = (id: string, _partitionKey?: unknown) => ({
    read: async () => ({ resource: this.get(id) }),
    replace: async (doc: FakeDoc) => {
      if (!this.docs.has(id)) throw notFound();
      this.docs.set(id, clone(doc));
      return { resource: clone(doc) };
    },
    delete: async () => {
      if (!this.docs.has(id)) throw notFound();
      this.docs.delete(id);
      return {};
    },
  });

  items = {
    create: async (doc: FakeDoc) => {
      this.docs.set(doc.id, clone(doc));
      return { resource: clone(doc) };
    },
    upsert: async (doc: FakeDoc) => {
      this.docs.set(doc.id, clone(doc));
      return { resource: clone(doc) };
    },
    query: (spec: string | QuerySpec, _options?: unknown) => ({
      fetchAll: async () => ({ resources: this.runQuery(spec) }),
    }),
  };

  private runQuery(spec: string | QuerySpec): FakeDoc[] {
    const text = typeof spec === 'string' ? spec : spec.query;
    const params = new Map(
      (typeof spec === 'string' ? [] : (spec.parameters ?? [])).map(p => [p.name, p.value]),
    );
    const predicates: ((doc: FakeDoc) => boolean)[] = [];
    let rest = text;

    // (c.owner = @owner OR ARRAY_CONTAINS(c.collaborators, @email))
    rest = rest.replace(
      /\(c\.(\w+)\s*=\s*(@\w+)\s+OR\s+ARRAY_CONTAINS\(c\.(\w+),\s*(@\w+)\)\)/gi,
      (_m, field: string, param: string, arrayField: string, arrayParam: string) => {
        predicates.push(
          doc =>
            doc[field] === params.get(param) ||
            (Array.isArray(doc[arrayField]) && (doc[arrayField] as unknown[]).includes(params.get(arrayParam))),
        );
        return 'TRUE';
      },
    );

    // (NOT IS_DEFINED(c.field) OR c.field = false)
    rest = rest.replace(/\(NOT\s+IS_DEFINED\(c\.(\w+)\)\s+OR\s+c\.\1\s*=\s*false\)/gi, (_m, field: string) => {
      predicates.push(doc => !doc[field]);
      return 'TRUE';
    });

    // c.field = @param
    rest = rest.replace(/c\.(\w+)\s*=\s*(@\w+)/g, (_m, field: string, param: string) => {
      predicates.push(doc => doc[field] === params.get(param));
      return 'TRUE';
    });

    // c.field = true|false
    rest = rest.replace(/c\.(\w+)\s*=\s*(true|false)/gi, (_m, field: string, literal: string) => {
      const expected = literal.toLowerCase() === 'true';
      predicates.push(doc => !!doc[field] === expected);
      return 'TRUE';
    });

    return [...this.docs.values()].filter(doc => predicates.every(p => p(doc))).map(clone);
  }
}

export interface FakeCosmos {
  getContainer: (name: string) => FakeContainer;
  container: (name: string) => FakeContainer;
  reset: () => void;
}

export function createFakeCosmos(): FakeCosmos {
  const containers = new Map<string, FakeContainer>();
  const getContainer = (name: string): FakeContainer => {
    if (!containers.has(name)) containers.set(name, new FakeContainer());
    return containers.get(name)!;
  };
  return {
    getContainer,
    container: getContainer,
    reset: () => containers.forEach(c => c.clear()),
  };
}
