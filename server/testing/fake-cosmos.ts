/**
 * In-memory stand-in for the Cosmos containers, for route-level tests.
 *
 * Supports the operations the routes actually use: point reads/replaces/deletes,
 * create/upsert, and SQL queries built from the WHERE-clause patterns that appear
 * in this codebase:
 *   - `c.field = @param` / `c.field = true|false`
 *   - `(NOT IS_DEFINED(c.field) OR c.field = false)`
 *   - `(c.owner = @owner OR ARRAY_CONTAINS(c.collaborators, @email))`
 *   - `c.field IN ('a', 'b')`
 *   - `c.field < @param` / `>` / `<=` / `>=`
 * All clauses combine conjunctively, which matches every query the routes issue.
 * `SELECT TOP n|@param` and a single `ORDER BY c.field ASC|DESC` are honoured too.
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

  /** Everything in the container, for asserting on what a route wrote. */
  all(): FakeDoc[] {
    return [...this.docs.values()].map(clone);
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

    // c.field IN ('a', 'b')
    rest = rest.replace(/c\.(\w+)\s+IN\s*\(([^)]*)\)/gi, (_m, field: string, list: string) => {
      const values = list
        .split(',')
        .map(v => v.trim().replace(/^'(.*)'$/, '$1'))
        .map(v => (params.has(v) ? params.get(v) : v));
      predicates.push(doc => values.includes(doc[field] as never));
      return 'TRUE';
    });

    // c.field < @param (and the other three comparisons). Strings compare
    // lexicographically, which is what the ISO timestamps in these queries want.
    rest = rest.replace(/c\.(\w+)\s*(<=|>=|<|>)\s*(@\w+)/g, (_m, field: string, op: string, param: string) => {
      const bound = params.get(param) as string | number;
      predicates.push(doc => {
        const value = doc[field] as string | number | undefined;
        if (value === undefined || value === null) return false;
        switch (op) {
          case '<': return value < bound;
          case '>': return value > bound;
          case '<=': return value <= bound;
          default: return value >= bound;
        }
      });
      return 'TRUE';
    });

    let results = [...this.docs.values()].filter(doc => predicates.every(p => p(doc))).map(clone);

    const order = /ORDER\s+BY\s+c\.(\w+)(\s+(ASC|DESC))?/i.exec(text);
    if (order) {
      const field = order[1];
      const descending = (order[3] ?? 'ASC').toUpperCase() === 'DESC';
      results.sort((a, b) => {
        const left = a[field] as string | number;
        const right = b[field] as string | number;
        if (left === right) return 0;
        return (left < right ? -1 : 1) * (descending ? -1 : 1);
      });
    }

    const top = /SELECT\s+TOP\s+(@?\w+)/i.exec(text);
    if (top) {
      const raw = top[1];
      const limit = Number(raw.startsWith('@') ? params.get(raw) : raw);
      if (Number.isFinite(limit)) results = results.slice(0, limit);
    }

    return results;
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
