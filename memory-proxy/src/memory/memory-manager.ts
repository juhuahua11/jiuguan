import { ChatMessage } from '../types/provider.js';
import { WorkingMemory } from '../session/working-memory.js';
import { TokenBudgetManager, BudgetAllocation } from '../budget/token-budget.js';
import { execQuery } from '../storage/db.js';
import { dualRetrieve, RetrievalItem } from '../retrieval/dual-retrieval.js';
import { buildQueryContext } from '../retrieval/query-builder.js';
import { RetrievalCache } from '../retrieval/retrieval-cache.js';
import { QueryContext } from '../types/retrieval.js';
import { KeywordContext } from '../retrieval/keyword-extractor.js';
import type { ContinuityInjection } from '../types/continuity.js';

export interface AssembledContext {
  messages: ChatMessage[];
  budget_breakdown: BudgetAllocation;
  retrieval?: InjectionTrace;
}

interface AssembleContextOptions {
  trace?: boolean;
  continuity?: ContinuityInjection;
}

interface InjectionTraceItem extends RetrievalItem {
  injected: boolean;
  trimReason?: string;
}

interface TraceBucketSummary {
  total: number;
  injected: number;
  trimmed: number;
  maxIncluded: number;
}

interface InjectionTrace {
  queryContext: QueryContext;
  keywordContext: KeywordContext;
  continuity?: {
    level: string;
    snapshot_id: string | null;
    handoff_id: string | null;
    boost_turns_remaining: number;
    trigger: string;
    injected: boolean;
    trimReason?: string;
  };
  items: InjectionTraceItem[];
  budget: BudgetAllocation;
  summary: {
    facts: TraceBucketSummary;
    events: TraceBucketSummary;
    relationships: TraceBucketSummary;
    cache: {
      mode: 'fresh' | 'cache-reconstructed';
    };
  };
}

export class MemoryManager {
  private budget: TokenBudgetManager;
  private retrievalCache = new RetrievalCache();

  constructor(budget: TokenBudgetManager) {
    this.budget = budget;
  }

  async assembleContext(
    sessionId: string,
    workingMemory: WorkingMemory,
    keywordCtx: KeywordContext,
    options: AssembleContextOptions = {}
  ): Promise<AssembledContext> {
    // 1. Load Core Canon
    const canonEntries = execQuery(
      "SELECT * FROM canon_entries WHERE tier = 'CORE' AND (session_id = ? OR session_id IS NULL) AND archived_at IS NULL",
      [sessionId]
    );
    const canonBlocks = canonEntries.map((e: any) => `[设定] ${e.statement}`);

    // 2. Load Current State
    const stateRow = execQuery(
      'SELECT * FROM current_states WHERE session_id = ?', [sessionId]
    );
    const stateBlock = stateRow.length ? this.formatCurrentState(stateRow[0]) : '';

    // 3. Get working memory messages
    const workingMessages = workingMemory.getMessages();

    // 4. Build query context and dual-retrieve
    const queryCtx = buildQueryContext(sessionId, workingMessages);
    const cacheKey = this.retrievalCache.getCacheKey(
      queryCtx.entities, queryCtx.locations, queryCtx.intents,
      queryCtx.narrativeHooks, queryCtx.implicitRules
    );

    const cached = this.retrievalCache.get(cacheKey);
    let retrievalItems: RetrievalItem[];
    let cacheMode: 'fresh' | 'cache-reconstructed' = 'fresh';
    if (cached) {
      retrievalItems = this.hydrateCachedRetrievalItems(cached);
      cacheMode = 'cache-reconstructed';
    } else {
      retrievalItems = await dualRetrieve(sessionId, queryCtx, keywordCtx, 30);
      retrievalItems = this.augmentGraphRetrievalItems(sessionId, queryCtx.entities, retrievalItems);
      this.retrievalCache.set(cacheKey, {
        facts: retrievalItems.filter((i: RetrievalItem) => i.type === 'fact').map((i: RetrievalItem) => i.id),
        events: retrievalItems.filter((i: RetrievalItem) => i.type === 'event').map((i: RetrievalItem) => i.id),
        relationships: retrievalItems.filter((i: RetrievalItem) => i.type === 'relationship').map((i: RetrievalItem) => i.id),
        canon_entries: retrievalItems.filter((i: RetrievalItem) => i.type === 'canon').map((i: RetrievalItem) => i.id),
      });
    }
    retrievalItems = this.augmentGraphRetrievalItems(sessionId, queryCtx.entities, retrievalItems);

    // 5. Estimate tokens
    const enc = workingMemory.estimateTokens.bind(workingMemory);
    const continuityText = options.continuity?.text || '';
    const continuityBlock = continuityText
      ? `[长期连续性上下文]\n以下内容用于保持剧情、人物关系、事件进度和角色状态连续。不要重置已发生事件，不要改写已建立关系，除非用户明确要求重开或修改设定。\n\n${continuityText}`
      : '';
    const canonTokens = this.estimateTextTokens(canonBlocks.join('\n'), enc);
    const continuityTokens = continuityBlock ? this.estimateTextTokens(continuityBlock, enc) : 0;
    const stateTokens = stateBlock ? this.estimateTextTokens(stateBlock, enc) : 0;
    const workingTokens = enc(workingMessages);
    const factItems = retrievalItems.filter((i: RetrievalItem) => i.type === 'fact');
    const eventItems = retrievalItems.filter((i: RetrievalItem) => i.type === 'event');
    const relationshipItems = retrievalItems.filter((i: RetrievalItem) => i.type === 'relationship');
    const renderFactLine = (item: RetrievalItem) => `[事实] ${item.content} (score: ${item.score.toFixed(2)}, via: ${item.source})`;
    const renderEventLine = (item: RetrievalItem) => `[事件] ${item.content} (score: ${item.score.toFixed(2)}, via: ${item.source})`;
    const renderRelationshipLine = (item: RetrievalItem) => `[关系] ${item.content} (score: ${item.score.toFixed(2)}, via: ${item.source})`;
    const factTokens = factItems.reduce(
      (sum: number, item: RetrievalItem) => sum + this.estimateTextTokens(renderFactLine(item), enc),
      0
    );
    const eventTokens = eventItems.reduce(
      (sum: number, item: RetrievalItem) => sum + this.estimateTextTokens(renderEventLine(item), enc),
      0
    );
    const relationshipTokens = relationshipItems.reduce(
      (sum: number, item: RetrievalItem) => sum + this.estimateTextTokens(renderRelationshipLine(item), enc),
      0
    );

    // 6. Budget allocation
    const alloc = this.budget.allocate({
      canonTokens,
      continuityTokens,
      stateTokens,
      factTokens,
      eventTokens,
      relationshipTokens,
      workingTokens,
      summaryTokens: 0,
    });

    // 7. Assemble system message
    const systemParts: string[] = [];
    systemParts.push(...canonBlocks);
    const continuityInjected = continuityBlock.length > 0 && alloc.continuity > 0;
    if (continuityInjected) systemParts.push(continuityBlock);
    if (stateBlock) systemParts.push(stateBlock);

    const maxFacts = alloc.facts > 0 && factItems.length > 0
      ? Math.min(factItems.length, Math.floor(alloc.facts / 12))
      : 0;
    const injectedFactIds = new Set<string>(factItems.slice(0, maxFacts).map((i: RetrievalItem) => i.id));
    const eventSelection = this.selectBudgetedItems(
      eventItems,
      alloc.events,
      enc,
      renderEventLine
    );
    const relationshipSelection = this.selectBudgetedItems(
      relationshipItems,
      alloc.relationships,
      enc,
      renderRelationshipLine
    );
    const injectedEventIds = eventSelection.injectedIds;
    const injectedRelationshipIds = relationshipSelection.injectedIds;

    const relationshipBlock = relationshipSelection.renderedItems
      .slice(0, relationshipSelection.includedCount)
      .map(({ line }) => line)
      .join('\n');
    if (relationshipBlock) systemParts.push(relationshipBlock);

    const eventBlock = eventSelection.renderedItems
      .slice(0, eventSelection.includedCount)
      .map(({ line }) => line)
      .join('\n');
    if (eventBlock) systemParts.push(eventBlock);

    if (maxFacts > 0) {
      const factBlock = factItems.slice(0, maxFacts)
        .map(renderFactLine)
        .join('\n');
      if (factBlock) systemParts.push(factBlock);
    }

    const systemMsg: ChatMessage = {
      role: 'system',
      content: systemParts.join('\n\n'),
    };

    const context: AssembledContext = {
      messages: [systemMsg, ...workingMessages],
      budget_breakdown: alloc,
    };

    if (options.trace) {
      context.retrieval = this.buildTrace(
        queryCtx,
        keywordCtx,
        retrievalItems,
        injectedFactIds,
        injectedEventIds,
        injectedRelationshipIds,
        alloc,
        maxFacts,
        eventSelection.includedCount,
        relationshipSelection.includedCount,
        cacheMode
      );
      if (options.continuity) {
        context.retrieval.continuity = {
          level: options.continuity.level,
          snapshot_id: options.continuity.snapshot_id,
          handoff_id: options.continuity.handoff_id,
          boost_turns_remaining: options.continuity.boost_turns_remaining,
          trigger: options.continuity.trigger,
          injected: continuityInjected,
          trimReason: continuityBlock.length > 0 && alloc.continuity === 0
            ? 'continuity allocation is 0'
            : undefined,
        };
      }
    }

    return context;
  }

  private hydrateCachedRetrievalItems(cached: any): RetrievalItem[] {
    const facts = cached.facts.map((id: string) => {
      const fact = execQuery('SELECT * FROM facts WHERE id = ?', [id])[0];
      return fact ? { id, type: 'fact' as const, content: fact.statement, score: 1, source: 'cache-reconstructed' as const, tier: 1 as const } : null;
    }).filter(Boolean) as RetrievalItem[];
    const events = cached.events.map((id: string) => {
      const event = execQuery('SELECT * FROM events WHERE id = ?', [id])[0];
      return event ? { id, type: 'event' as const, content: event.description, score: 1, source: 'cache-reconstructed' as const, tier: 1 as const } : null;
    }).filter(Boolean) as RetrievalItem[];
    const relationships = cached.relationships.map((id: string) => {
      const rel = execQuery('SELECT * FROM relationships WHERE id = ?', [id])[0];
      return rel ? {
        id,
        type: 'relationship' as const,
        content: rel.description || `${rel.subject_id} ${rel.relation_type} ${rel.object_id} (intensity: ${rel.intensity})`,
        score: 1,
        source: 'cache-reconstructed' as const,
        tier: 1 as const,
      } : null;
    }).filter(Boolean) as RetrievalItem[];

    return [...facts, ...events, ...relationships];
  }

  private augmentGraphRetrievalItems(
    sessionId: string,
    entityIds: string[],
    retrievalItems: RetrievalItem[]
  ): RetrievalItem[] {
    const byKey = new Map<string, RetrievalItem>();
    for (const item of retrievalItems) {
      byKey.set(`${item.type}:${item.id}`, item);
    }

    for (const row of execQuery('SELECT * FROM relationships WHERE session_id = ?', [sessionId])) {
      if (!entityIds.includes(row.subject_id) && !entityIds.includes(row.object_id)) continue;
      const key = `relationship:${row.id}`;
      const content = row.description || `${row.subject_id} ${row.relation_type} ${row.object_id} (intensity: ${row.intensity})`;
      const existing = byKey.get(key);
      if (existing) {
        existing.content = content;
        existing.score = Math.max(existing.score, Math.abs(row.intensity));
        continue;
      }
      byKey.set(key, {
        id: row.id,
        type: 'relationship',
        content,
        score: Math.abs(row.intensity),
        source: 'graph',
        tier: Math.abs(row.intensity) > 0.5 ? 2 : 3,
      });
    }

    for (const row of execQuery('SELECT * FROM events WHERE session_id = ?', [sessionId])) {
      const participants: string[] = JSON.parse(row.participants || '[]');
      if (!participants.some(participant => entityIds.includes(participant))) continue;
      const key = `event:${row.id}`;
      if (byKey.has(key)) continue;
      const sigScore = row.significance === 'CRITICAL' ? 1.0 :
        row.significance === 'HIGH' ? 0.8 :
        row.significance === 'MEDIUM' ? 0.5 : 0.3;
      byKey.set(key, {
        id: row.id,
        type: 'event',
        content: row.description,
        score: sigScore,
        source: 'graph',
        tier: sigScore > 0.5 ? 2 : 3,
      });
    }

    return Array.from(byKey.values()).sort((a, b) => b.score - a.score);
  }

  private buildTrace(
    queryCtx: QueryContext,
    keywordCtx: KeywordContext,
    retrievalItems: RetrievalItem[],
    injectedFactIds: Set<string>,
    injectedEventIds: Set<string>,
    injectedRelationshipIds: Set<string>,
    alloc: BudgetAllocation,
    maxFacts: number,
    maxEvents: number,
    maxRelationships: number,
    cacheMode: 'fresh' | 'cache-reconstructed'
  ): InjectionTrace {
    const items = retrievalItems.map((item: RetrievalItem) => {
      const injected =
        (item.type === 'fact' && injectedFactIds.has(item.id))
        || (item.type === 'event' && injectedEventIds.has(item.id))
        || (item.type === 'relationship' && injectedRelationshipIds.has(item.id));
      let trimReason: string | undefined;
      if (!injected && item.type === 'fact') {
        trimReason = alloc.facts === 0
          ? 'facts allocation is 0'
          : `beyond maxFacts budget (${maxFacts} items fit)`;
      } else if (!injected && item.type === 'event') {
        trimReason = alloc.events === 0
          ? 'events allocation is 0'
          : maxEvents === 0
            ? 'exceeded remaining events budget'
            : `beyond maxEvents budget (${maxEvents} items fit)`;
      } else if (!injected && item.type === 'relationship') {
        trimReason = alloc.relationships === 0
          ? 'relationships allocation is 0'
          : maxRelationships === 0
            ? 'exceeded remaining relationships budget'
            : `beyond maxRelationships budget (${maxRelationships} items fit)`;
      }

      return {
        ...item,
        injected,
        ...(trimReason ? { trimReason } : {}),
      };
    });

    return {
      queryContext: queryCtx,
      keywordContext: keywordCtx,
      items,
      budget: alloc,
      summary: {
        facts: {
          total: retrievalItems.filter((item: RetrievalItem) => item.type === 'fact').length,
          injected: injectedFactIds.size,
          trimmed: retrievalItems.filter((item: RetrievalItem) => item.type === 'fact').length - injectedFactIds.size,
          maxIncluded: maxFacts,
        },
        events: {
          total: retrievalItems.filter((item: RetrievalItem) => item.type === 'event').length,
          injected: injectedEventIds.size,
          trimmed: retrievalItems.filter((item: RetrievalItem) => item.type === 'event').length - injectedEventIds.size,
          maxIncluded: maxEvents,
        },
        relationships: {
          total: retrievalItems.filter((item: RetrievalItem) => item.type === 'relationship').length,
          injected: injectedRelationshipIds.size,
          trimmed: retrievalItems.filter((item: RetrievalItem) => item.type === 'relationship').length - injectedRelationshipIds.size,
          maxIncluded: maxRelationships,
        },
        cache: {
          mode: cacheMode,
        },
      },
    };
  }

  private selectBudgetedItems(
    items: RetrievalItem[],
    allocation: number,
    enc: (msgs: ChatMessage[]) => number,
    renderItem: (item: RetrievalItem) => string
  ): {
    renderedItems: Array<{ item: RetrievalItem; line: string; tokens: number }>;
    injectedIds: Set<string>;
    includedCount: number;
  } {
    const renderedItems = items.map((item: RetrievalItem) => {
      const line = renderItem(item);
      return {
        item,
        line,
        tokens: this.estimateTextTokens(line, enc),
      };
    });

    const injectedIds = new Set<string>();
    let remaining = allocation;
    let includedCount = 0;
    for (const rendered of renderedItems) {
      if (rendered.tokens > remaining) {
        break;
      }
      injectedIds.add(rendered.item.id);
      remaining -= rendered.tokens;
      includedCount++;
    }

    return { renderedItems, injectedIds, includedCount };
  }

  private formatCurrentState(row: any): string {
    const parts: string[] = [];
    if (row.location_value) parts.push(`[当前位置] ${row.location_value}`);

    const chars = JSON.parse(row.characters_present || '[]');
    if (chars.length > 0) parts.push(`[在场人物] ${chars.join('、')}`);

    const inv = JSON.parse(row.inventory || '[]');
    if (inv.length > 0) parts.push(`[持有物品] ${inv.join('、')}`);

    const questions = JSON.parse(row.pending_questions || '[]');
    const active = questions.filter((q: any) => !q.resolved_at_round);
    if (active.length > 0) parts.push(`[待回复] ${active.map((q: any) => q.description).join('; ')}`);

    const quests = JSON.parse(row.active_quests || '[]');
    const activeQuests = quests.filter((q: any) => !q.resolved_at_round);
    if (activeQuests.length > 0) parts.push(`[进行中任务] ${activeQuests.map((q: any) => q.description).join('; ')}`);

    return parts.join('\n');
  }

  private estimateTextTokens(text: string, enc: (msgs: ChatMessage[]) => number): number {
    return enc([{ role: 'system', content: text }]);
  }
}
