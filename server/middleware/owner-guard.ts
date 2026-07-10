import { Request } from 'express';
import { Container, SqlQuerySpec } from '@azure/cosmos';

type OwnerSource = Request | string;

function resolveEmail(source: OwnerSource): string {
  return typeof source === 'string' ? source : source.user!.email;
}

/**
 * Wraps a Cosmos DB SQL query to add a filter restricting results to records
 * owned by the given user. Accepts either an Express Request (uses req.user.email)
 * or a plain email string for use in non-request contexts.
 */
export function withOwnerFilter(source: OwnerSource, query: string | SqlQuerySpec): SqlQuerySpec {
  const email = resolveEmail(source);

  function injectOwner(sql: string): string {
    // Insert owner filter before ORDER BY (or at end if no ORDER BY)
    const orderByMatch = sql.match(/\s+ORDER\s+BY\s+/i);
    if (orderByMatch && orderByMatch.index !== undefined) {
      const before = sql.slice(0, orderByMatch.index);
      const after = sql.slice(orderByMatch.index);
      const hasWhere = /\bwhere\b/i.test(before);
      return hasWhere
        ? `${before} AND c.owner = @_owner${after}`
        : `${before} WHERE c.owner = @_owner${after}`;
    }
    const hasWhere = /\bwhere\b/i.test(sql);
    return hasWhere ? `${sql} AND c.owner = @_owner` : `${sql} WHERE c.owner = @_owner`;
  }

  if (typeof query === 'string') {
    return {
      query: injectOwner(query),
      parameters: [{ name: '@_owner', value: email }],
    };
  }
  return {
    query: injectOwner(query.query),
    parameters: [...(query.parameters ?? []), { name: '@_owner', value: email }],
  };
}

/**
 * Reads a single item by id and returns null if it does not exist or is not
 * owned by the given user. Returns null rather than throwing to avoid leaking
 * the existence of records belonging to other users.
 */
export async function readOwnedItem<T extends { owner?: string }>(
  container: Container,
  id: string,
  partitionKey: string,
  source: OwnerSource,
): Promise<T | null> {
  const { resource } = await container.item(id, partitionKey).read<T>();
  if (!resource || resource.owner !== resolveEmail(source)) return null;
  return resource;
}

/**
 * Reads a single item by id and returns null if it does not exist or if the
 * user is neither the owner nor a listed collaborator.
 */
export async function readAccessibleItem<T extends { owner?: string; collaborators?: string[] }>(
  container: Container,
  id: string,
  partitionKey: string,
  source: OwnerSource,
): Promise<T | null> {
  const email = resolveEmail(source);
  const { resource } = await container.item(id, partitionKey).read<T>();
  if (!resource) return null;
  if (resource.owner === email) return resource;
  if (resource.collaborators?.includes(email)) return resource;
  return null;
}
