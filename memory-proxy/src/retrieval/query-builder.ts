import { QueryContext } from '../types/retrieval.js';
import { ChatMessage } from '../types/provider.js';
import { execQuery } from '../storage/db.js';

/**
 * Build a QueryContext from the current conversation.
 * Extracts entities, locations, intents, and narrative hooks.
 *
 * For V1, uses simple entity matching against the known entity registry.
 * V2 will add LLM-based intent analysis.
 */
export function buildQueryContext(
  sessionId: string,
  recentMessages: ChatMessage[]
): QueryContext {
  const allText = recentMessages.map(m => m.content).join(' ');
  const entities = extractMentionedEntities(sessionId, allText);

  return {
    entities: entities.characterIds,
    locations: entities.locationIds,
    intents: detectIntents(allText),
    narrativeHooks: detectNarrativeHooks(allText),
    implicitRules: detectImplicitRules(allText, sessionId),
  };
}

function extractMentionedEntities(
  sessionId: string,
  text: string
): { characterIds: string[]; locationIds: string[] } {
  const allEntities = execQuery(
    'SELECT id, name, aliases, type FROM entities WHERE session_id = ?',
    [sessionId]
  );

  const characterIds: string[] = [];
  const locationIds: string[] = [];

  for (const entity of allEntities) {
    const aliases: string[] = JSON.parse(entity.aliases || '[]');
    const names = [entity.name, ...aliases];
    const mentioned = names.some((name: string) => text.includes(name));
    if (mentioned) {
      if (entity.type === 'CHARACTER') characterIds.push(entity.id);
      if (entity.type === 'LOCATION') locationIds.push(entity.id);
    }
  }

  return { characterIds, locationIds };
}

function detectIntents(text: string): string[] {
  const intents: string[] = [];
  const patterns: Array<{ regex: RegExp; intent: string }> = [
    { regex: /问|打听|在哪|是谁|什么是|怎么回事/, intent: '询问' },
    { regex: /调查|查探|寻找|追踪|搜查/, intent: '调查' },
    { regex: /攻击|战斗|打倒|消灭|对抗/, intent: '战斗' },
    { regex: /给|送|交给|交易|换取/, intent: '交易' },
    { regex: /去|前往|回到|进入|离开/, intent: '移动' },
    { regex: /说|告诉|透露|坦白|承认/, intent: '对话' },
  ];
  for (const { regex, intent } of patterns) {
    if (regex.test(text)) intents.push(intent);
  }
  return intents;
}

function detectNarrativeHooks(text: string): string[] {
  const hooks: string[] = [];
  const patterns: Array<{ regex: RegExp; hook: string }> = [
    { regex: /之前说|上次|上一回|之前/, hook: '未完成对话' },
    { regex: /继续|接着|然后呢/, hook: '延续剧情' },
    { regex: /后来呢|之后|结果/, hook: '待揭示结果' },
    { regex: /他(说|问)过|答应|承诺/, hook: '等待回复' },
  ];
  for (const { regex, hook } of patterns) {
    if (regex.test(text)) hooks.push(hook);
  }
  return [...new Set(hooks)];
}

function detectImplicitRules(text: string, sessionId: string): string[] {
  const rules: string[] = [];
  // Check if any canon implicit_triggers match entities in text
  const canonEntries = execQuery(
    `SELECT implicit_triggers FROM canon_entries WHERE tier = 'CORE' AND (session_id = ? OR session_id IS NULL) AND archived_at IS NULL`,
    [sessionId]
  );
  for (const canon of canonEntries) {
    const triggers: string[] = JSON.parse(canon.implicit_triggers || '[]');
    for (const trigger of triggers) {
      if (text.includes(trigger)) {
        rules.push(trigger);
      }
    }
  }
  return [...new Set(rules)];
}
