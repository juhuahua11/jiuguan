import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

// 自动查找并加载 .env 文件
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config(); // fallback to default dotenv behavior
}

export interface Config {
  proxyPort: number;
  dashboardPort: number;
  upstreamUrl: string;
  apiKey: string;
  workingMemoryTokens: number;
  dataDir: string;
  activeProvider: 'openai' | 'deepseek' | 'mimo' | 'claude' | 'none';
}

/** 检测当前激活的 Provider */
export function detectActiveProvider(): 'openai' | 'deepseek' | 'mimo' | 'claude' | 'none' {
  if (process.env.DEEPSEEK_API_KEY) return 'deepseek';
  if (process.env.MIMO_API_KEY) return 'mimo';
  if (process.env.ANTHROPIC_API_KEY) return 'claude';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'none';
}

/** 获取当前 Provider 的显示信息 */
export function getProviderInfo(): { name: string; model: string; url: string } {
  const p = detectActiveProvider();
  switch (p) {
    case 'deepseek':
      return {
        name: 'DeepSeek',
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        url: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
      };
    case 'mimo':
      return {
        name: 'XiaoMi MiMo',
        model: process.env.MIMO_MODEL || 'mimo-v2-flash',
        url: process.env.MIMO_BASE_URL || 'https://api.xiaomimimo.com/v1',
      };
    case 'claude':
      return {
        name: 'Claude (Anthropic)',
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
        url: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1',
      };
    case 'openai':
      return {
        name: 'OpenAI',
        model: process.env.OPENAI_MODEL || 'gpt-4o',
        url: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
      };
    case 'none':
      return { name: '(未配置)', model: '—', url: '—' };
  }
}

export function loadConfig(): Config {
  return {
    proxyPort: parseInt(process.env.PROXY_PORT || '9876', 10),
    dashboardPort: parseInt(process.env.DASHBOARD_PORT || '9877', 10),
    upstreamUrl: process.env.UPSTREAM_URL || 'https://api.openai.com',
    apiKey: process.env.UPSTREAM_API_KEY || process.env.OPENAI_API_KEY || '',
    workingMemoryTokens: parseInt(process.env.WORKING_MEMORY_TOKENS || '32000', 10),
    dataDir: process.env.DATA_DIR || './memory',
    activeProvider: detectActiveProvider(),
  };
}
