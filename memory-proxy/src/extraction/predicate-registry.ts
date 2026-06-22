export enum PredicateLayer {
  PHYSICAL = 'physical',
  SOCIAL = 'social',
  MENTAL = 'mental',
  KNOWLEDGE = 'knowledge',
  EMOTIONAL = 'emotional',
}

interface PredicateEntry {
  layer: PredicateLayer;
  category: string;
}

export const PREDICATE_REGISTRY: Record<string, PredicateEntry> = {
  // Physical
  'owns': { layer: PredicateLayer.PHYSICAL, category: 'possession' },
  'located_at': { layer: PredicateLayer.PHYSICAL, category: 'location' },
  'carries': { layer: PredicateLayer.PHYSICAL, category: 'possession' },
  'equipped': { layer: PredicateLayer.PHYSICAL, category: 'possession' },
  'gave': { layer: PredicateLayer.PHYSICAL, category: 'transfer' },
  'lost': { layer: PredicateLayer.PHYSICAL, category: 'transfer' },
  'found': { layer: PredicateLayer.PHYSICAL, category: 'transfer' },
  // Social
  'member_of': { layer: PredicateLayer.SOCIAL, category: 'affiliation' },
  'leads': { layer: PredicateLayer.SOCIAL, category: 'hierarchy' },
  'allied_with': { layer: PredicateLayer.SOCIAL, category: 'alliance' },
  'rivals_with': { layer: PredicateLayer.SOCIAL, category: 'conflict' },
  // Mental
  'trusts': { layer: PredicateLayer.MENTAL, category: 'trust' },
  'suspects': { layer: PredicateLayer.MENTAL, category: 'suspicion' },
  'believes': { layer: PredicateLayer.MENTAL, category: 'belief' },
  'doubts': { layer: PredicateLayer.MENTAL, category: 'doubt' },
  // Knowledge
  'knows': { layer: PredicateLayer.KNOWLEDGE, category: 'knowledge' },
  'forgot': { layer: PredicateLayer.KNOWLEDGE, category: 'knowledge' },
  'learned': { layer: PredicateLayer.KNOWLEDGE, category: 'learning' },
  'discovered': { layer: PredicateLayer.KNOWLEDGE, category: 'discovery' },
  // Emotional
  'likes': { layer: PredicateLayer.EMOTIONAL, category: 'affection' },
  'hates': { layer: PredicateLayer.EMOTIONAL, category: 'hostility' },
  'fears': { layer: PredicateLayer.EMOTIONAL, category: 'fear' },
  'admires': { layer: PredicateLayer.EMOTIONAL, category: 'admiration' },
};

/** Map LLM output variants to standard predicates */
const PREDICATE_ALIASES: Record<string, string> = {
  '给': 'gave', '送': 'gave', '交给': 'gave', '赠与': 'gave', '递给': 'gave', '交付': 'gave',
  '有': 'owns', '持有': 'owns', '拿着': 'owns', '带着': 'owns', '拥有': 'owns', '携带': 'carries',
  '在': 'located_at', '位于': 'located_at', '身处': 'located_at', '到达': 'located_at',
  '加入': 'member_of', '进入': 'member_of', '归属': 'member_of', '属于': 'member_of',
  '杀死': 'killed', '杀了': 'killed', '干掉': 'killed',
  '学会': 'learned', '掌握': 'learned', '习得': 'learned',
  '丢失': 'lost', '遗失': 'lost', '被偷': 'lost',
  '信任': 'trusts', '怀疑': 'suspects', '相信': 'believes',
  '知道': 'knows', '忘记': 'forgot', '发现': 'discovered',
  '喜欢': 'likes', '恨': 'hates', '害怕': 'fears', '敬佩': 'admires',
};

export function normalizePredicate(raw: string): string {
  // First check if it's already a standard predicate
  if (PREDICATE_REGISTRY[raw]) return raw;
  // Check aliases (Chinese -> English)
  if (PREDICATE_ALIASES[raw]) return PREDICATE_ALIASES[raw];
  // Check lowercase English
  const lower = raw.toLowerCase();
  if (PREDICATE_REGISTRY[lower]) return lower;
  if (PREDICATE_ALIASES[lower]) return PREDICATE_ALIASES[lower];
  // Return as-is if unknown (extensible)
  return lower.replace(/\s+/g, '_');
}

export function getPredicateLayer(predicate: string): PredicateLayer | null {
  return PREDICATE_REGISTRY[predicate]?.layer || null;
}

export function isStatePredicate(predicate: string): boolean {
  // State predicates describe current state (become Facts)
  const statePredicates = new Set([
    'owns', 'located_at', 'carries', 'equipped', 'member_of', 'leads',
    'trusts', 'suspects', 'believes', 'doubts',
    'knows', 'likes', 'hates', 'fears', 'admires',
    'allied_with', 'rivals_with',
  ]);
  return statePredicates.has(predicate);
}
