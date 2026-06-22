/**
 * Memory Proxy — 交互式配置向导
 *
 * 用法:
 *   npm run setup             交互式配置
 *   npm run start:deepseek    预设 DeepSeek 并启动
 *   npm run start:mimo        预设 MiMo 并启动
 *   npm run start:openai      预设 OpenAI 并启动
 *   npm run start:claude      预设 Claude 并启动
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

interface Preset {
  name: string;
  env: Record<string, string>;
}

const PRESETS: Record<string, Preset> = {
  deepseek: {
    name: 'DeepSeek',
    env: {
      DEEPSEEK_MODEL: 'deepseek-chat',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
      PROXY_PORT: '9876',
      WORKING_MEMORY_TOKENS: '8000',
    },
  },
  mimo: {
    name: 'XiaoMi MiMo',
    env: {
      MIMO_MODEL: 'mimo-v2-flash',
      MIMO_BASE_URL: 'https://api.xiaomimimo.com/v1',
      PROXY_PORT: '9876',
      WORKING_MEMORY_TOKENS: '8000',
    },
  },
  openai: {
    name: 'OpenAI',
    env: {
      OPENAI_MODEL: 'gpt-4o',
      PROXY_PORT: '9876',
      WORKING_MEMORY_TOKENS: '8000',
    },
  },
  claude: {
    name: 'Claude (Anthropic)',
    env: {
      ANTHROPIC_MODEL: 'claude-sonnet-4-6',
      PROXY_PORT: '9876',
      WORKING_MEMORY_TOKENS: '8000',
    },
  },
};

async function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(question, (answer: string) => resolve(answer.trim()));
  });
}

async function interactiveSetup(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(`
╔══════════════════════════════════════════════╗
║     Memory Proxy — 首次配置向导              ║
╚══════════════════════════════════════════════╝

选择 LLM Provider:
  1. DeepSeek    (api.deepseek.com)
  2. XiaoMi MiMo (api.xiaomimimo.com)
  3. OpenAI      (api.openai.com)
  4. Claude      (api.anthropic.com)
`);

  const choice = await ask(rl, '请选择 [1-4]: ');

  const presetMap: Record<string, string> = { '1': 'deepseek', '2': 'mimo', '3': 'openai', '4': 'claude' };
  const presetKey = presetMap[choice] || 'deepseek';
  const preset = PRESETS[presetKey];

  console.log(`\n已选择: ${preset.name}`);

  const keyEnvMap: Record<string, string> = {
    deepseek: 'DEEPSEEK_API_KEY',
    mimo: 'MIMO_API_KEY',
    openai: 'OPENAI_API_KEY',
    claude: 'ANTHROPIC_API_KEY',
  };

  const keyVar = keyEnvMap[presetKey];
  const existingKey = process.env[keyVar] || '';
  const masked = existingKey ? `(已有: ${existingKey.slice(0, 8)}...) ` : '';
  const apiKey = await ask(rl, `\nAPI Key ${masked}: `);

  const finalKey = apiKey || existingKey;
  if (!finalKey) {
    console.log('⚠ 未输入 API Key。你可以稍后在 .env 文件中手动添加。');
  }

  // 写入 .env
  const envLines: string[] = [
    `# Memory Proxy — ${preset.name} 配置`,
    `# 生成时间: ${new Date().toISOString()}`,
    '',
  ];

  for (const [k, v] of Object.entries(preset.env)) {
    envLines.push(`${k}=${v}`);
  }
  if (finalKey) {
    envLines.push(`${keyVar}=${finalKey}`);
  }

  const envPath = path.join(process.cwd(), '.env');
  fs.writeFileSync(envPath, envLines.join('\n') + '\n');
  console.log(`\n✅ 配置已写入: ${envPath}`);

  rl.close();

  // 启动
  console.log('\n正在启动 Memory Proxy...\n');
  const { main } = await import('./index.js');
}

// 命令行预设模式
function applyPreset(presetKey: string): void {
  const preset = PRESETS[presetKey];
  if (!preset) {
    console.error(`未知预设: ${presetKey}。可选: deepseek, mimo, openai, claude`);
    process.exit(1);
  }

  const keyMap: Record<string, string> = {
    deepseek: 'DEEPSEEK_API_KEY',
    mimo: 'MIMO_API_KEY',
    openai: 'OPENAI_API_KEY',
    claude: 'ANTHROPIC_API_KEY',
  };
  const keyVar = keyMap[presetKey];

  // 如果 .env 不存在，创建一个带提示的
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    const envLines: string[] = [
      `# Memory Proxy — ${preset.name} 预设`,
      `# 请填入你的 API Key:`,
      `# ${keyVar}=your-key-here`,
      '',
    ];
    for (const [k, v] of Object.entries(preset.env)) {
      envLines.push(`${k}=${v}`);
    }
    // 不写入假 key，让用户手动填
    envLines.push(`# ${keyVar}=sk-your-key-here`);
    fs.writeFileSync(envPath, envLines.join('\n') + '\n');
    console.log(`📝 已创建 .env 模板（${preset.name} 预设）`);
    console.log(`   请编辑 .env 填入你的 ${keyVar}`);
    console.log(`   然后运行: npm start\n`);
    process.exit(0);
  }

  // .env 已存在，直接启动
  console.log(`🚀 使用 ${preset.name} 预设启动...`);
}

// 主逻辑
async function run() {
  const args = process.argv.slice(2);
  const presetArg = args.indexOf('--preset');
  const launchArg = args.includes('--launch');

  if (presetArg >= 0 && args[presetArg + 1]) {
    const presetKey = args[presetArg + 1];
    applyPreset(presetKey);
    if (launchArg) {
      // 直接启动
      const { main } = await import('./index.js');
    }
    return;
  }

  // 默认: 交互式向导
  await interactiveSetup();
}

run().catch(err => {
  console.error('❌ 配置向导出错:', err.message);
  process.exit(1);
});
