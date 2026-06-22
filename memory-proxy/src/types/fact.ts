import { BaseRecord } from './base';

export enum FactSource {
  USER = 'USER',
  ASSISTANT = 'ASSISTANT',
  CONFIRMED = 'CONFIRMED',
}

export enum FactType {
  IDENTITY = 'identity',
  RELATIONSHIP = 'relationship',
  PROFILE = 'profile',
  PREFERENCE = 'preference',
  EVENT = 'event',
  GENERAL = 'general',
}

export interface Fact extends BaseRecord {
  session_id: string;
  subject_id: string;
  predicate: string;
  object_id: string | null;
  statement: string;
  confidence: number;
  source: FactSource;
  fact_type: FactType;
  occurrence_count: number;
  valid_from: number;
  valid_to: number | null;
  embedding_id?: string;
  trace_id: string;
  tombstone?: {
    deleted: boolean;
    deleted_at: number;
    deletion_reason: string;
  };
}
