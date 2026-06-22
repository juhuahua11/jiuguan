// src/types/entity.ts
import { BaseRecord } from './base';

export enum EntityType {
  CHARACTER = 'CHARACTER',
  ITEM = 'ITEM',
  LOCATION = 'LOCATION',
  FACTION = 'FACTION',
  CONCEPT = 'CONCEPT',
}

export interface Entity extends BaseRecord {
  session_id: string;
  name: string;
  aliases: string[];
  type: EntityType;
  first_seen_round: number;
  last_seen_round: number;
  embedding_id?: string;
}
