import type { ChatMessage } from './provider.js';

export type ContinuityInjectionLevel = 'normal' | 'compact' | 'medium' | 'full';

export interface ContinuityConfig {
  enabled: boolean;
  snapshotDetail: 'full';
  normalMaxTokens: number;
  compactMaxTokens: number;
  mediumMaxTokens: number;
  fullMaxTokens: number;
  refreshEveryTurns: number;
}

export interface HandoffConfig {
  enabled: boolean;
  triggerOnModelSwitch: boolean;
  manualRefreshEnabled: boolean;
  boostTurns: number;
  fullTurns: number;
  mediumTurns: number;
}

export interface ContinuityRuntimeConfig {
  continuity: ContinuityConfig;
  handoff: HandoffConfig;
}

export interface SceneState {
  location: string | null;
  characters_present: string[];
  current_action: string | null;
}

export interface PlotState {
  active_quests: string[];
  recent_progress: string[];
}

export interface UnresolvedState {
  pending_questions: string[];
  pending_promises: string[];
  unresolved_hooks: string[];
}

export interface RelationshipContinuity {
  subject_id: string;
  object_id: string;
  relation_type: string;
  intensity: number;
  description: string;
}

export interface CharacterContinuity {
  id: string;
  notes: string[];
}

export interface ProtagonistContinuity {
  assets: string[];
  goals: string[];
}

export interface TimelineEvent {
  id: string;
  description: string;
  round: number;
  significance: string;
}

export interface WorldContinuity {
  notes: string[];
}

export interface InteractionContract {
  notes: string[];
}

export interface ContinuityConstraint {
  statement: string;
  source: 'canon' | 'state' | 'relationship' | 'event' | 'fact';
}

export interface ContinuitySnapshot {
  id?: string;
  session_id: string;
  version: number;
  source_round: number;
  scene: SceneState;
  plot: PlotState;
  unresolved: UnresolvedState;
  relationships: RelationshipContinuity[];
  characters: CharacterContinuity[];
  protagonist: ProtagonistContinuity;
  timeline: TimelineEvent[];
  world: WorldContinuity;
  interaction_contract: InteractionContract;
  continuity_constraints: ContinuityConstraint[];
  compact_text: string;
  medium_text: string;
  full_text: string;
  created_at?: number;
  updated_at?: number;
}

export interface ContinuitySnapshotBuildInput {
  sourceRound: number;
  recentMessages: ChatMessage[];
}

export interface ModelHandoff {
  id: string;
  session_id: string;
  from_model: string | null;
  to_model: string;
  snapshot_id: string;
  created_round: number;
  boost_turns_total: number;
  boost_turns_remaining: number;
  full_turns: number;
  medium_turns: number;
  handoff_text: string;
  active: boolean;
  created_at: number;
  updated_at: number;
}

export interface ContinuityInjection {
  level: ContinuityInjectionLevel;
  text: string;
  snapshot_id: string | null;
  handoff_id: string | null;
  boost_turns_remaining: number;
  trigger: 'model-switch' | 'manual' | 'keyword' | 'normal' | 'none';
}
