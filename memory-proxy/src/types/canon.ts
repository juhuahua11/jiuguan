import { BaseRecord } from './base';

export enum CanonTier { CORE = 'CORE', EXTENDED = 'EXTENDED', ARCHIVE = 'ARCHIVE' }
export enum CanonCategory {
  WORLD_RULE = 'WORLD_RULE',
  CHARACTER_SETTING = 'CHARACTER_SETTING',
  TABOO = 'TABOO',
  FIXED_RELATIONSHIP = 'FIXED_RELATIONSHIP',
  USER_PREFERENCE = 'USER_PREFERENCE',
}
export enum CanonSource { USER = 'USER', WORKER_SUGGESTION = 'WORKER_SUGGESTION' }
export enum ConflictPolicy { BLOCK = 'BLOCK', WARN = 'WARN', ALLOW = 'ALLOW' }

export interface CanonEntry extends BaseRecord {
  session_id: string | null;
  tier: CanonTier;
  category: CanonCategory;
  statement: string;
  keywords: string[];
  implicit_triggers: string[];
  embedding_id?: string;
  created_by: CanonSource;
  is_locked: boolean;
  conflict_policy: ConflictPolicy;
  archived_at: number | null;
}
