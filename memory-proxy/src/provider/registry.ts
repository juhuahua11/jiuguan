import { Provider } from '../types/provider.js';
import { OpenAIProvider } from './openai.js';
import { ClaudeProvider } from './claude.js';
import { DeepSeekProvider } from './deepseek.js';
import { MiMoProvider } from './mimo.js';

export function getProviderForRequest(
  path: string,
  headers: Record<string, string>
): Provider {
  const isAnthropicPath = path.includes('/v1/messages');
  const providerHeader = headers['x-provider']?.toLowerCase();

  // Explicit provider header takes priority
  if (providerHeader === 'deepseek') {
    return new DeepSeekProvider();
  }
  if (providerHeader === 'mimo' || providerHeader === 'xiaomi') {
    return new MiMoProvider();
  }
  if (providerHeader === 'claude' || providerHeader === 'anthropic') {
    return new ClaudeProvider();
  }
  if (providerHeader === 'openai') {
    return new OpenAIProvider();
  }

  // Anthropic path: check for DeepSeek/MiMo env config first, else Claude
  if (isAnthropicPath) {
    if (process.env.DEEPSEEK_API_KEY) {
      return new DeepSeekProvider();
    }
    if (process.env.MIMO_API_KEY) {
      return new MiMoProvider();
    }
    // Anthropic-version header or /v1/messages path → Claude
    if (headers['anthropic-version']) {
      return new ClaudeProvider();
    }
    return new ClaudeProvider();
  }

  // OpenAI path: check env auto-detection
  if (process.env.DEEPSEEK_API_KEY && !process.env.OPENAI_API_KEY) {
    return new DeepSeekProvider();
  }
  if (process.env.MIMO_API_KEY && !process.env.OPENAI_API_KEY && !process.env.DEEPSEEK_API_KEY) {
    return new MiMoProvider();
  }

  return new OpenAIProvider();
}

export { OpenAIProvider, ClaudeProvider, DeepSeekProvider, MiMoProvider };
