// ST plugin entry — CommonJS
// ST plugin-loader calls: require('./index.js')(app)

const path = require('path');

let cleanup = null;

function memoryProxyPlugin(app) {
  console.log('[MemoryProxy] Loading V3...');

  let initPlugin;
  try {
    require('tsx/cjs');
    const mod = require('./src/plugin.ts');
    initPlugin = mod.initPlugin;
  } catch (e) {
    console.error('[MemoryProxy] Failed to load:', e.message);
    console.error('[MemoryProxy] Ensure "tsx" is installed: npm install tsx');
    return () => {};
  }

  const result = initPlugin(app, __dirname);
  cleanup = result;
  return result;
}

memoryProxyPlugin.info = {
  id: 'memory-proxy',
  name: 'Memory Proxy',
  description: 'Long-term context memory management for RP (DeepSeek / MiMo)',
};

memoryProxyPlugin.init = memoryProxyPlugin;
memoryProxyPlugin.exit = async function exitMemoryProxyPlugin() {
  if (cleanup && typeof cleanup.then === 'function') {
    cleanup = await cleanup;
  }
  if (typeof cleanup === 'function') {
    await cleanup();
    cleanup = null;
  }
};

module.exports = memoryProxyPlugin;
