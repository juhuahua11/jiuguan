import { startProxy } from './server/proxy.js';
import { loadConfig, getProviderInfo, detectActiveProvider } from './config.js';
import fs from 'fs';
import path from 'path';

function showBanner() {
  const config = loadConfig();
  const provider = getProviderInfo();
  const hasEnv = fs.existsSync(path.join(process.cwd(), '.env'));

  console.log(`
╔══════════════════════════════════════════════════════╗
║           Memory Proxy — 长期记忆中间件                ║
╠══════════════════════════════════════════════════════╣
║                                                      ║
║  Provider : ${provider.name.padEnd(41)}║
║  Model    : ${provider.model.padEnd(41)}║
║  Upstream : ${provider.url.padEnd(41)}║
║                                                      ║
║  Proxy    : http://localhost:${String(config.proxyPort).padEnd(33)}║
║  Dashboard: http://localhost:${String(config.dashboardPort).padEnd(33)}║
║  工作记忆 : ${String(config.workingMemoryTokens + ' tokens').padEnd(41)}║
║  配置文件 : ${(hasEnv ? '.env (已加载)' : '(未找到 .env — 使用默认值)').padEnd(41)}║
║                                                      ║
╠══════════════════════════════════════════════════════╣
║  SillyTavern 配置:                                    ║
║    OpenAI 兼容 → http://localhost:${String(config.proxyPort).padEnd(28)}║
║    Anthropic   → http://localhost:${String(config.proxyPort).padEnd(28)}║
╚══════════════════════════════════════════════════════╝
`);
}

function validateConfig(): string[] {
  const warnings: string[] = [];
  const provider = detectActiveProvider();

  if (provider === 'none') {
    warnings.push('⚠ 未检测到任何 API Key！请创建 .env 文件或设置环境变量');
    warnings.push('  快速开始: npm run setup');
    warnings.push('  查看选项: cat .env.example');
  }

  if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    warnings.push('💡 提示: 设置 UPSTREAM_API_KEY 作为通用 API Key 兜底');
  }

  return warnings;
}

export async function main() {
  // 0. 防呆检查
  const warnings = validateConfig();
  showBanner();

  if (warnings.length > 0) {
    console.log('--- 启动检查 ---');
    for (const w of warnings) console.log(w);
    console.log('');
  }

  // 1. 启动代理
  await startProxy();

  const config = loadConfig();
  console.log(`
✅ Memory Proxy 已就绪
   SillyTavern 中将 API URL 设为:
   http://localhost:${config.proxyPort}/v1

   按 Ctrl+C 停止
`);
}

main().catch(err => {
  console.error('❌ 启动失败:', err.message);
  console.error('   → 检查端口是否被占用: npx kill-port 9876');
  console.error('   → 或使用其他端口: PROXY_PORT=9878 npm start');
  process.exit(1);
});
