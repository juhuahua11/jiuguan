import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { readStCapabilities, resolveSettingsPath } from '../../../src/adapters/st-config.js';

/** Helper: assert all 6 DynamicCapabilities fields match expected values */
function assertCapabilities(
  caps: ReturnType<typeof readStCapabilities>,
  expected: { contextWindow: number; maxOutputTokens: number; supportsReasoning: boolean }
) {
  expect(caps.contextWindow).toBe(expected.contextWindow);
  expect(caps.maxOutputTokens).toBe(expected.maxOutputTokens);
  expect(caps.supportsSystemRole).toBe(true);
  expect(caps.supportsToolCall).toBe(true);
  expect(caps.supportsJsonMode).toBe(true);
  expect(caps.supportsReasoning).toBe(expected.supportsReasoning);
}

describe('st-config', () => {
  let tmpDir: string;
  let settingsPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-config-test-'));
    const dataDir = path.join(tmpDir, 'data', 'default-user');
    fs.mkdirSync(dataDir, { recursive: true });
    settingsPath = path.join(dataDir, 'settings.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSettings(obj: Record<string, unknown>) {
    fs.writeFileSync(settingsPath, JSON.stringify(obj));
  }

  it('should read DeepSeek config with ST jailbreak limits', () => {
    writeSettings({
      chat_completion_source: 'deepseek',
      deepseek_max_context: 2000000,
      deepseek_max_tokens: 390000,
    });

    const caps = readStCapabilities(settingsPath);
    assertCapabilities(caps, { contextWindow: 2000000, maxOutputTokens: 390000, supportsReasoning: true });
  });

  it('should use defaults when ST config is missing fields', () => {
    writeSettings({ chat_completion_source: 'deepseek' });

    const caps = readStCapabilities(settingsPath);
    assertCapabilities(caps, { contextWindow: 2000000, maxOutputTokens: 390000, supportsReasoning: true });
  });

  it('should read custom source config (MiMo)', () => {
    writeSettings({
      chat_completion_source: 'custom',
      custom_max_context: 1000000,
      custom_max_tokens: 130000,
    });

    const caps = readStCapabilities(settingsPath);
    assertCapabilities(caps, { contextWindow: 1000000, maxOutputTokens: 130000, supportsReasoning: false });
  });

  it('should read real ST oai_settings shape', () => {
    writeSettings({
      oai_settings: {
        chat_completion_source: 'custom',
        openai_max_context: 2000000,
        openai_max_tokens: 20000,
      },
    });

    const caps = readStCapabilities(settingsPath);
    assertCapabilities(caps, { contextWindow: 2000000, maxOutputTokens: 20000, supportsReasoning: false });
  });

  it('should return DeepSeek-class defaults for unsupported source', () => {
    // This plugin only targets DeepSeek/MiMo, so an unknown source falls back to
    // DeepSeek-class capabilities rather than crippling output to 4096 tokens.
    writeSettings({ chat_completion_source: 'claude' });

    const caps = readStCapabilities(settingsPath);
    assertCapabilities(caps, { contextWindow: 2000000, maxOutputTokens: 390000, supportsReasoning: true });
  });

  it('should return DeepSeek-class defaults when settings file does not exist', () => {
    // Missing settings must NOT silently degrade to openai 4096 max_tokens —
    // that would cripple DeepSeek/MiMo output with no diagnostic.
    const caps = readStCapabilities('/nonexistent/path/settings.json');

    expect(caps.contextWindow).toBe(2000000);
    expect(caps.maxOutputTokens).toBe(390000);
    expect(caps.supportsSystemRole).toBe(true);
    expect(caps.supportsToolCall).toBe(true);
    expect(caps.supportsJsonMode).toBe(true);
    expect(caps.supportsReasoning).toBe(true);
  });

  it('should resolve settings path from plugin directory', () => {
    const result = resolveSettingsPath('/app/plugins/memory-proxy');
    expect(result).toBe(path.join('/app', 'data', 'default-user', 'settings.json'));
  });
});
