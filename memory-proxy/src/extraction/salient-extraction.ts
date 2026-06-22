import { Salient } from '../types/extraction.js';
import { ChatMessage } from '../types/provider.js';

/**
 * Build the prompt for Salient Extraction.
 * The caller (Worker) sends this to an LLM and parses the JSON response.
 *
 * NOTE: existingFacts (the de-dup list) is intentionally NOT injected here.
 * Salient extraction's job is to surface *anything worth remembering* from the
 * new dialogue; whether a fact is already stored is a de-dup concern handled
 * downstream by buildFactEventPrompt (which DOES carry the existing-facts list).
 * Sending the full facts table into BOTH prompts was the largest extraction-side
 * token sink (~13KB/call, growing linearly with the facts table). Removing it
 * here keeps salient prompts small and constant-size with no recall risk:
 * anything salient surfaces that's already known gets filtered by fact-event.
 */
export function buildSalientPrompt(messages: ChatMessage[], knownEntities: string[]): string {
  const conversation = messages.map(m => `[${m.role}] ${m.content}`).join('\n');

  return `你是JSON数据提取器，不是角色扮演者。你的任务是分析对话并输出结构化JSON，绝不续写故事。

已知实体：${knownEntities.join(', ') || '(无)'}
忽略：寒暄、语气词、重复确认
保留以下任何值得记住的内容：
- 状态变化、位置移动、物品得失
- 承诺、决定、计划、意图
- 新信息、设定揭示、世界观细节
- 事件、行动、关键行为
- 关系变化、情感表达、态度转变
- 角色特征、习惯、偏好的展现
- 对话中提到的人名、地名、物品名及其关联

每条一句话，最多10条。没有新信息则返回{"salients":[]}。
只输出一行JSON，不要任何其他内容，不要markdown，不要故事续写。

=== 对话开始 ===
${conversation}
=== 对话结束 ===

现在输出你的JSON（只输出一次，不要包含任何叙事文字）：
{"salients":[{"type":"state_change|promise|decision|event|relationship_change|item_transfer|info|reveal|trait|plan","statement":"描述","entities_involved":["实体名"],"round":0}]}`;
}

export function parseSalientResponse(response: string, defaultRound: number): Salient[] {
  try {
    let cleaned = response.trim();
    // If model output narrative mixed with JSON, extract just the JSON portion
    const jsonStart = cleaned.indexOf('{"salients"');
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
    return (parsed.salients || []).map((s: any) => ({
      type: s.type || 'info',
      statement: s.statement || '',
      entities_involved: s.entities_involved || [],
      round: s.round || defaultRound,
    }));
  } catch (err: any) {
    console.error('[MemoryProxy] Salient parse failed:', err.message, 'response preview:', response.slice(0, 200));
    return [];
  }
}
