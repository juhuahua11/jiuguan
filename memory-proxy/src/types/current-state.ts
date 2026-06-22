import { BaseRecord } from './base';

export enum StateSource {
  USER = 'USER',
  ASSISTANT = 'ASSISTANT',
  INFERRED = 'INFERRED',
}

export interface StateField<T> {
  value: T;
  confidence: number;
  source: StateSource;
  updated_round: number;
}

export interface PendingItem {
  id: string;
  description: string;
  raised_at_round: number;
  resolved_at_round: number | null;
  priority: number;
}

export interface CurrentState extends BaseRecord {
  session_id: string;
  location: StateField<string | null>;
  characters_present: StateField<string[]>;
  inventory: StateField<string[]>;
  pending_questions: PendingItem[];
  pending_promises: PendingItem[];
  active_quests: PendingItem[];
  unresolved_hooks: PendingItem[];
  last_updated_round: number;
}
