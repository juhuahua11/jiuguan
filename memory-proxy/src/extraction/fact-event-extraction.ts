import { Salient } from '../types/extraction.js';
import { Fact, FactSource } from '../types/fact.js';
import { Event, EventImportance } from '../types/event.js';

export function buildFactEventPrompt(
  salients: Salient[],
  entities: Array<{ id: string; name: string }>,
  existingFacts: string[]
): string {
  const salientText = salients.map(s => `- [${s.type}] ${s.statement}`).join('\n');
  const entityMap = entities.map(e => `- ${e.name}: ${e.id}`).join('\n');
  const existingText = existingFacts.map(f => `- ${f}`).join('\n');

  return `你是JSON数据提取器。从重要陈述中提取结构化事实和事件，只输出JSON，绝不续写故事。

已知实体ID映射：
${entityMap}

已有事实（请勿重复）：
${existingText || '(无)'}

=== 陈述开始 ===
${salientText}
=== 陈述结束 ===

Fact表达可变更的状态（owns, located_at, trusts, knows, has_trait等），Event记录不可逆的历史事件。没有新事实或事件则返回{"facts":[],"events":[]}。
只输出一行JSON：

{"facts":[{"subject_entity_id":"实体ID","predicate":"owns|located_at|member_of|trusts|knows|likes|carries|...","object_entity_id":"实体ID或null","is_negation":false,"confidence":0.8,"fact_type":"identity|relationship|profile|preference|event|general","source_statement":"原始陈述"}],"events":[{"description":"事件描述","participants":["实体ID"],"location_id":"地点ID或null","significance":"LOW|MEDIUM|HIGH|CRITICAL","round":0}]}

fact_type说明：
- identity: 身份信息（是谁、是什么物种/性别/年龄等不可变属性）
- relationship: 长期关系（婚姻、血缘、师徒、同盟、敌对等）
- profile: 可变化的状态/拥有物（位置、持有物品、所属组织）
- preference: 喜好/情感态度（喜欢、讨厌、害怕、崇拜）
- event: 一次性历史事件（给予了、丢失了、杀死了、学到了）
- general: 无法归类的事实（默认）`;
}

export function parseFactEventResponse(
  response: string,
  sessionId: string,
  source: FactSource,
  traceId: string,
  defaultRound: number
): { facts: Array<Partial<Fact>>; events: Array<Partial<Event>> } {
  try {
    let cleaned = response.trim();
    // If model output narrative mixed with JSON, extract just the JSON portion
    let jsonStart = cleaned.indexOf('{"facts"');
    if (jsonStart === -1) jsonStart = cleaned.indexOf('{');
    if (jsonStart !== -1) {
      const braceEnd = cleaned.lastIndexOf('}');
      if (braceEnd > jsonStart) {
        cleaned = cleaned.slice(jsonStart, braceEnd + 1);
      }
    }
    // Strip markdown code fences if present
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    const parsed = JSON.parse(cleaned);
    const facts = (parsed.facts || []).map((f: any) => ({
      session_id: sessionId,
      subject_id: f.subject_entity_id || '',
      predicate: f.predicate || '',
      object_id: f.object_entity_id || null,
      statement: f.source_statement || '',
      confidence: f.confidence || 0.6,
      source,
      valid_from: defaultRound,
      valid_to: null,
      fact_type: f.fact_type ?? 'general',
      trace_id: traceId,
    }));
    const events = (parsed.events || []).map((e: any) => ({
      session_id: sessionId,
      description: e.description || '',
      participants: e.participants || [],
      location_id: e.location_id || undefined,
      timestamp_round: e.round || defaultRound,
      significance: (e.significance as EventImportance) || EventImportance.MEDIUM,
      caused_by: [],
      causes: [],
      trace_id: traceId,
    }));
    return { facts, events };
  } catch (err: any) {
    // Mirror parseSalientResponse's diagnostics — previously this failed silently,
    // which hid v4 reasoning-content issues (empty content → JSON.parse('') threw).
    console.error('[MemoryProxy] FactEvent parse failed:', err?.message || err, 'response preview:', response.slice(0, 200));
    return { facts: [], events: [] };
  }
}
