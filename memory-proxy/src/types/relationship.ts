import { BaseRecord } from './base';

export enum RelationType {
  FRIENDSHIP = 'FRIENDSHIP',
  ROMANCE = 'ROMANCE',
  HOSTILITY = 'HOSTILITY',
  LOYALTY = 'LOYALTY',
  MASTER_STUDENT = 'MASTER_STUDENT',
  MARRIAGE = 'MARRIAGE',
  FAMILY = 'FAMILY',
  ALLIANCE = 'ALLIANCE',
  RIVALRY = 'RIVALRY',
}

export interface RelationshipMetrics {
  trust: number;
  affection: number;
  respect: number;
  hostility: number;
}

export interface EvolutionEntry {
  round: number;
  timestamp: number;
  change_desc: string;
  intensity_delta: number;
}

export interface Relationship extends BaseRecord {
  session_id: string;
  subject_id: string;
  object_id: string;
  relation_type: RelationType;
  intensity: number;
  description: string;
  evolution: EvolutionEntry[];
  metrics?: RelationshipMetrics;
  trace_id: string;
}
