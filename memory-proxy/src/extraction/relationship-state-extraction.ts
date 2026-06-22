import { Salient, RelationshipSignal } from '../types/extraction.js';

export interface StatePatchOp {
  op: string;
  value?: string;
  item?: string;
  id?: string;
  text?: string;
}

export interface RecentSignal {
  actor: string;
  target: string;
  type: string;
  round: number;
  description: string;
}

export interface PendingItemForPrompt {
  kind: 'question' | 'promise' | 'quest' | 'hook';
  description: string;
  round: number;
}

const SIGNAL_TYPES = [
  'protective_action', 'saved_life', 'betrayal', 'shared_secret', 'verbal_insult',
  'gift_exchange', 'romantic_gesture', 'confession', 'helped_in_battle', 'kept_promise',
  'broke_promise', 'deception', 'mentor_teaching', 'showing_mercy', 'intimidation',
];

const STATE_OPS = [
  'set_location', 'add_character', 'remove_character',
  'add_question', 'add_promise', 'add_quest', 'add_hook',
  'resolve_question', 'resolve_promise', 'resolve_quest', 'resolve_hook',
];

export function buildRelationshipStatePrompt(
  salients: Salient[],
  entities: Array<{ id: string; name: string }>,
  pendingList: PendingItemForPrompt[],
  recentSignals: RecentSignal[]
): string {
  const salientText = salients.map(s => `- [${s.type}] ${s.statement}`).join('\n');
  const entityMap = entities.map(e => `- ${e.name}: ${e.id}`).join('\n');
  const pendingText = pendingList.length
    ? pendingList.map(p => `- [${p.kind}] ${p.description} (round ${p.round})`).join('\n')
    : '(无)';
  const recentText = recentSignals.length
    ? recentSignals.map(s => `- [round ${s.round}] ${s.actor}→${s.target} ${s.type}: ${s.description}`).join('\n')
    : '(无)';

  return `你是JSON数据提取器。从陈述中提取关系信号和状态变更，只输出JSON，绝不续写故事。

已知实体ID映射：
${entityMap}

当前未决事项（如已解决，请用resolve_*勾销，text须与原文一致）：
${pendingText}

已记录的近期关系信号（勿重复输出过去已发生事件的回忆，只输出本轮新发生的关系变化）：
${recentText}

=== 陈述开始 ===
${salientText}
=== 陈述结束 ===

relationship_signals：识别关系变化信号。type必须是以下之一：
${SIGNAL_TYPES.join('|')}
actor/target用实体ID。没有则返回[]。

state_patches：识别场景与未决事项变更。op必须是以下之一：
${STATE_OPS.join('|')}
- set_location: value=地点（本轮对话发生的地点）
- add_character: item=实体ID —— 记录本轮在场人物。陈述中entities_involved出现的人物都应用add_character记录（除非已确定离场）。每次对话至少记录在场的主角
- remove_character: item=实体ID（人物离场时）
- add_question/add_promise/add_quest/add_hook: text=描述
- resolve_question/resolve_promise/resolve_quest/resolve_hook: text=与上文"当前未决事项"中某条原文一致
没有则返回[]。

只输出一行JSON，不要任何其他内容，不要markdown，不要故事续写：
{"relationship_signals":[{"type":"confession","actor":"实体ID","target":"实体ID","description":"描述","round":0}],"state_patches":[{"op":"set_location","value":"麦田"},{"op":"add_character","item":"实体ID"}]}`;
}

export function parseRelationshipStateResponse(
  response: string,
  defaultRound: number
): { signals: RelationshipSignal[]; statePatches: StatePatchOp[] } {
  try {
    let cleaned = response.trim();
    // Slice from the JSON object start to the last brace (tolerates surrounding prose).
    const jsonStart = cleaned.indexOf('{"relationship_signals"');
    if (jsonStart === -1) {
      // Fall back to first '{' if the model omitted the key prefix.
      const fb = cleaned.indexOf('{');
      if (fb !== -1) {
        const end = cleaned.lastIndexOf('}');
        if (end > fb) cleaned = cleaned.slice(fb, end + 1);
      }
    } else {
      const braceEnd = cleaned.lastIndexOf('}');
      if (braceEnd > jsonStart) {
        cleaned = cleaned.slice(jsonStart, braceEnd + 1);
      }
    }
    // Strip markdown code fences if present.
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    const parsed = JSON.parse(cleaned);
    const signals: RelationshipSignal[] = (parsed.relationship_signals || []).map((s: any) => ({
      type: s.type || '',
      actor: s.actor || '',
      target: s.target || '',
      description: s.description || '',
      round: s.round || defaultRound,
    }));
    const statePatches: StatePatchOp[] = (parsed.state_patches || []).map((p: any) => ({
      op: p.op || '',
      value: p.value,
      item: p.item,
      id: p.id,
      text: p.text,
    }));
    return { signals, statePatches };
  } catch (err: any) {
    console.error('[MemoryProxy] RelationshipState parse failed:', err?.message || err, 'response preview:', response.slice(0, 200));
    return { signals: [], statePatches: [] };
  }
}
