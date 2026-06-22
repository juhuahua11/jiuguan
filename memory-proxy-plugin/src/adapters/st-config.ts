import fs from 'fs';
import path from 'path';

export interface DynamicCapabilities {
  contextWindow: number;
  maxOutputTokens: number;
  supportsSystemRole: boolean;
  supportsToolCall: boolean;
  supportsJsonMode: boolean;
  supportsReasoning: boolean;
}

interface StSettings {
  chat_completion_source: string;
  deepseek_max_context?: number;
  deepseek_max_tokens?: number;
  custom_max_context?: number;
  custom_max_tokens?: number;
  openai_max_context?: number;
  openai_max_tokens?: number;
  [key: string]: unknown;
}

interface StSettingsFile extends Partial<StSettings> {
  oai_settings?: Partial<StSettings>;
}

/**
 * DeepSeek-class capability defaults. This plugin only targets DeepSeek / MiMo,
 * so when ST's settings.json is absent or unreadable we fall back to these
 * (NOT openai's 4096 max_tokens, which would silently cripple output).
 */
const DEEPSEEK_CLASS_DEFAULTS: Omit<DynamicCapabilities, never> = {
  contextWindow: 2000000,
  maxOutputTokens: 390000,
  supportsSystemRole: true,
  supportsToolCall: true,
  supportsJsonMode: true,
  supportsReasoning: true,
};

/** Result of attempting to load ST settings: the parsed settings (or a minimal
 *  fallback) plus whether the file was actually found and parsed. */
interface LoadResult {
  settings: StSettings;
  found: boolean;
}

function loadStSettings(settingsPath: string): LoadResult {
  try {
    if (!fs.existsSync(settingsPath)) {
      console.warn(`[MemoryProxy] ST settings.json not found at ${settingsPath} — using DeepSeek-class capability defaults.`);
      return { settings: { chat_completion_source: 'deepseek' }, found: false };
    }
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw) as StSettingsFile;
    return { settings: { ...parsed, ...(parsed.oai_settings || {}) } as StSettings, found: true };
  } catch (e) {
    console.warn(`[MemoryProxy] ST settings.json parse failed (path=${settingsPath}):`, e instanceof Error ? e.message : String(e), '— using DeepSeek-class capability defaults.');
    return { settings: { chat_completion_source: 'deepseek' }, found: false };
  }
}

export function readStCapabilities(settingsPath: string): DynamicCapabilities {
  const { settings, found } = loadStSettings(settingsPath);

  // If the settings file is missing/unreadable, never degrade to openai 4096 —
  // this plugin targets DeepSeek/MiMo, so use DeepSeek-class defaults.
  if (!found) {
    return { ...DEEPSEEK_CLASS_DEFAULTS };
  }

  const source = settings.chat_completion_source;

  switch (source) {
    case 'deepseek':
      return {
        contextWindow: settings.deepseek_max_context ?? 2000000,
        maxOutputTokens: settings.deepseek_max_tokens ?? 390000,
        supportsSystemRole: true,
        supportsToolCall: true,
        supportsJsonMode: true,
        supportsReasoning: true,
      };

    case 'custom':
      // Custom providers (e.g. MiMo via a custom endpoint) — DeepSeek-class sized.
      return {
        contextWindow: settings.custom_max_context ?? settings.openai_max_context ?? 1000000,
        maxOutputTokens: settings.custom_max_tokens ?? settings.openai_max_tokens ?? 130000,
        supportsSystemRole: true,
        supportsToolCall: true,
        supportsJsonMode: true,
        supportsReasoning: false,
      };

    case 'openai':
      return {
        contextWindow: settings.openai_max_context ?? 128000,
        maxOutputTokens: settings.openai_max_tokens ?? 4096,
        supportsSystemRole: true,
        supportsToolCall: true,
        supportsJsonMode: true,
        supportsReasoning: false,
      };

    default:
      // Unknown source — assume DeepSeek-class rather than crippling to 4096.
      return { ...DEEPSEEK_CLASS_DEFAULTS };
  }
}

/**
 * Resolve the path to ST's settings.json from the plugin directory.
 * Tries multiple candidate layouts and returns the first that exists:
 *   1. MEMPROXY_ST_SETTINGS env override (explicit, absolute)
 *   2. ST Launcher layout: {LAUNCHER}/data/st_data/default-user/settings.json
 *      (plugin lives at {LAUNCHER}/data/sillytavern/<ver>/plugins/memory-proxy,
 *       so 4 levels up reaches {LAUNCHER}/data where st_data is a sibling)
 *   3. Standard ST layout: {ST}/data/default-user/settings.json
 *      (plugin lives at {ST}/plugins/memory-proxy, so 2 levels up reaches {ST})
 * If none exists, returns the standard-layout candidate (best guess) so the
 * caller's warning is actionable. readStCapabilities warns when missing.
 */
export function resolveSettingsPath(pluginDir: string): string {
  const envPath = process.env.MEMPROXY_ST_SETTINGS;
  const candidates: string[] = [];
  if (envPath) candidates.push(envPath);
  // Launcher layout: 4 levels up from plugins/memory-proxy
  candidates.push(path.join(pluginDir, '..', '..', '..', '..', 'st_data', 'default-user', 'settings.json'));
  // Standard ST layout: 2 levels up from plugins/memory-proxy
  candidates.push(path.join(pluginDir, '..', '..', 'data', 'default-user', 'settings.json'));

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // None found — return the standard-layout candidate (most common ST install).
  // readStCapabilities will warn that it's missing and use DeepSeek-class defaults.
  return candidates[candidates.length - 1];
}
