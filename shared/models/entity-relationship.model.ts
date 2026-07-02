import { AuditedRecord } from './audited-record';

export type RelationshipType =
  | 'parent'
  | 'child'
  | 'sibling'
  | 'spouse'
  | 'friend'
  | 'enemy'
  | 'coworker'
  | 'mentor'
  | 'student'
  | 'rival'
  | 'ally'
  | 'boss'
  | 'subordinate';

export const RELATIONSHIP_TYPES: { value: RelationshipType; label: string }[] = [
  { value: 'parent', label: 'Parent' },
  { value: 'child', label: 'Child' },
  { value: 'sibling', label: 'Sibling' },
  { value: 'spouse', label: 'Spouse' },
  { value: 'friend', label: 'Friend' },
  { value: 'enemy', label: 'Enemy' },
  { value: 'coworker', label: 'Coworker' },
  { value: 'mentor', label: 'Mentor' },
  { value: 'student', label: 'Student' },
  { value: 'rival', label: 'Rival' },
  { value: 'ally', label: 'Ally' },
  { value: 'boss', label: 'Boss' },
  { value: 'subordinate', label: 'Subordinate' },
];

// Maps each relationship type to the type describing the opposite direction.
// Symmetric types map to themselves.
export const INVERSE_RELATIONSHIP: Record<RelationshipType, RelationshipType> = {
  parent: 'child',
  child: 'parent',
  mentor: 'student',
  student: 'mentor',
  boss: 'subordinate',
  subordinate: 'boss',
  sibling: 'sibling',
  spouse: 'spouse',
  friend: 'friend',
  enemy: 'enemy',
  coworker: 'coworker',
  rival: 'rival',
  ally: 'ally',
};

export function relationshipTypeLabel(type: RelationshipType | undefined): string {
  if (!type) return '';
  return RELATIONSHIP_TYPES.find((t) => t.value === type)?.label ?? type;
}

export interface EntityRelationship extends AuditedRecord {
  id: string;
  seriesId: string;
  sourceEntityId: string;
  targetEntityId: string;
  /** The source entity's role toward the target (e.g. source is the parent → 'parent'). */
  relationshipType: RelationshipType;
  /** The target entity's role toward the source (e.g. target is the child → 'child'). */
  inverseRelationshipType?: RelationshipType;
  description?: string;
}

export interface RelationshipAddProposal {
  sourceEntityId: string;
  sourceEntityName: string;
  targetEntityId: string;
  targetEntityName: string;
  relationshipType: RelationshipType;
  inverseRelationshipType?: RelationshipType;
  description?: string;
}

export interface RelationshipExtractionResult {
  adds: RelationshipAddProposal[];
}

export interface ApplyRelationshipProposalsRequest {
  chapterId: string;
  seriesId: string;
  adds: RelationshipAddProposal[];
}

export interface ApplyRelationshipProposalsResult {
  added: number;
}

export interface EntityRelationshipSummary {
  id: string;
  partnerEntityId: string;
  partnerEntityName: string;
  partnerEntityType: 'PERSON' | 'PLACE' | 'THING';
  partnerEntityThumbnailUrl?: string;
  relationshipType: RelationshipType;
  inverseRelationshipType?: RelationshipType;
  description?: string;
  direction: 'source' | 'target';
}

export interface DiagramNodePosition {
  entityId: string;
  x: number;
  y: number;
}

export interface DiagramLayout extends AuditedRecord {
  id: string;
  seriesId: string;
  positions: DiagramNodePosition[];
}
