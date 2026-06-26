import { Entity } from '@shared/models/entity.model';

/**
 * All the textual forms an entity may be referred to by — full name, first /
 * last name (derived from the name when not set explicitly), nickname,
 * title-qualified variants, and any aliases. Mirrors the rich-text-editor's
 * reference matching so chat replies and the chapter editor recognise the same
 * mentions. PLACE / THING entities only expose their name and aliases.
 */
export function entityNameVariants(entity: Entity): string[] {
  if (entity.type !== 'PERSON') {
    return [entity.name, ...(entity.aliases ?? [])].filter((v): v is string => !!v?.trim());
  }
  const parts = entity.name.trim().split(/\s+/);
  const firstName = entity.firstName || (parts.length >= 2 ? parts[0] : undefined);
  const lastName = entity.lastName || (parts.length >= 2 ? parts[parts.length - 1] : undefined);
  const title = entity.title;
  const titleFullName = title ? `${title} ${entity.name}` : undefined;
  const titleLastName = title && lastName ? `${title} ${lastName}` : undefined;
  return [
    entity.name,
    firstName,
    lastName,
    entity.nickname,
    titleFullName,
    titleLastName,
    ...(entity.aliases ?? []),
  ].filter((v): v is string => !!v?.trim());
}

/**
 * Wraps occurrences of known entity names in `html` with
 * `<span class="qc-entity-ref" data-entity-id="…">` so the chat can show a
 * hover badge (image, name, bio, open link) — the same affordance the chapter
 * editor gives `.entity-reference` spans.
 *
 * Operates on the parsed DOM and walks text nodes only, so it never corrupts
 * tags/attributes. Text inside links, code, or an existing entity span is left
 * alone (so citations and code samples aren't rewritten). Matching is
 * whole-word and case-insensitive; the longest names win when several overlap.
 */
export function annotateEntityReferences(html: string, entities: Entity[]): string {
  const usable = entities.filter(e => !e.deleted && !e.archived);
  if (!html || usable.length === 0) return html;

  const byName = new Map<string, string>();
  for (const entity of usable) {
    for (const variant of entityNameVariants(entity)) {
      const key = variant.trim().toLowerCase();
      // First writer wins; entries are added in entity order, but the regex is
      // built longest-first so longer names are matched preferentially anyway.
      if (key && !byName.has(key)) byName.set(key, entity.id);
    }
  }
  if (byName.size === 0) return html;

  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  const escaped = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi');

  const div = document.createElement('div');
  div.innerHTML = html;
  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('a, code, pre, .qc-entity-ref')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

  for (const node of textNodes) {
    const text = node.textContent ?? '';
    pattern.lastIndex = 0;
    if (!pattern.test(text)) continue;

    pattern.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const id = byName.get(match[0].toLowerCase());
      if (!id) continue;
      if (match.index > last) frag.appendChild(document.createTextNode(text.slice(last, match.index)));
      const span = document.createElement('span');
      span.className = 'qc-entity-ref';
      span.setAttribute('data-entity-id', id);
      span.textContent = match[0];
      frag.appendChild(span);
      last = match.index + match[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode?.replaceChild(frag, node);
  }

  return div.innerHTML;
}

/** Extracts the entity id from a click on an entity reference span, if any. */
export function entityIdFromClick(event: MouseEvent): string | null {
  const target = (event.target as HTMLElement | null)?.closest('.qc-entity-ref') as HTMLElement | null;
  return target?.getAttribute('data-entity-id') ?? null;
}
