export interface Salient {
  type: 'state_change' | 'promise' | 'decision' | 'event' | 'relationship_change' | 'item_transfer' | 'info';
  statement: string;
  entities_involved: string[];
  round: number;
}

export interface RelationshipSignal {
  type: string;
  actor: string;
  target: string;
  description: string;
  round: number;
}

export interface StatePatch {
  operations: Array<{
    op: 'set_location' | 'add_inventory' | 'remove_inventory' |
        'add_character' | 'remove_character' |
        'add_question' | 'resolve_question' |
        'add_promise' | 'resolve_promise' |
        'add_quest' | 'resolve_quest' |
        'add_hook' | 'resolve_hook';
    value?: string;
    item?: string;
    id?: string;
    text?: string;
  }>;
}

export interface ExtractionReport {
  run_id: string;
  session_id: string;
  round: number;
  timestamp: number;
  duration_ms: number;
  entities_found: number;
  entities_new: number;
  state_operations: number;
  salients_extracted: number;
  facts_extracted: number;
  facts_blocked_by_canon: number;
  events_extracted: number;
  relationships_extracted: number;
  writes_succeeded: number;
  writes_failed: number;
  errors: string[];
  warnings: string[];
}
