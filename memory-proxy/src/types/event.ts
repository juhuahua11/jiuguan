import { BaseRecord } from './base';

export enum EventImportance {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

export interface Event extends BaseRecord {
  session_id: string;
  description: string;
  participants: string[];
  location_id?: string;
  timestamp_round: number;
  caused_by: string[];
  causes: string[];
  significance: EventImportance;
  embedding_id?: string;
  trace_id: string;
}
