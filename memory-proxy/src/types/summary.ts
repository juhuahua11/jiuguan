import { BaseRecord } from './base';

export interface SummaryBlock extends BaseRecord {
  session_id: string;
  level: 1 | 2 | 3;
  content: string;
  source_message_range: { from_round: number; to_round: number };
  parent_ids: string[];
  embedding_id?: string;
  token_count: number;
  importance_score: number;
}
