#!/usr/bin/env node
// Install the Memory Proxy plugin to the SillyTavern plugins directory

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const PLUGIN_NAME = 'memory-proxy';

function printUsage() {
  console.error('Usage: node scripts/install-to-st.js <path-to-sillytavern>');
  console.error('  Example: node scripts/install-to-st.js "C:/SillyTavern/SillyTavern Launcher GUI/data/sillytavern/1.18.0"');
  console.error('  Or set ST_PATH environment variable.');
}

// Determine ST plugins path
const stPath = process.env.ST_PATH || process.argv[2];

// Handle help flags and reject anything that looks like a flag instead of a path.
// (A prior `node scripts/install-to-st.js --help` created a literal `--help/` directory tree
//  because `--help` was treated as the install target path.)
if (!stPath || stPath === '-h' || stPath === '--help' || stPath === 'help') {
  printUsage();
  process.exit(stPath ? 0 : 1);
}
if (stPath.startsWith('-')) {
  console.error(`ERROR: unknown option "${stPath}"`);
  printUsage();
  process.exit(1);
}
if (!fs.existsSync(stPath)) {
  console.error(`ERROR: path does not exist: "${stPath}"`);
  printUsage();
  process.exit(1);
}
// Sanity check: an ST install should contain a plugins/ dir or a package.json.
if (!fs.existsSync(path.join(stPath, 'plugins')) && !fs.existsSync(path.join(stPath, 'package.json'))) {
  console.error(`WARNING: "${stPath}" does not look like a SillyTavern install (no plugins/ or package.json). Proceeding anyway.`);
}

const pluginsDir = path.join(stPath, 'plugins', PLUGIN_NAME);
const projectDir = path.join(__dirname, '..');
console.log(`Installing to: ${pluginsDir}`);

// Create plugin directory
fs.mkdirSync(pluginsDir, { recursive: true });

// Step 1: Copy plugin files
const filesToCopy = ['index.js', 'plugin-config.json'];
for (const f of filesToCopy) {
  const src = path.join(projectDir, f);
  const dst = path.join(pluginsDir, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    console.log(`  ${f} -> ${dst}`);
  }
}

// Copy source files (needed for tsx runtime)
const srcDir = path.join(projectDir, 'src');
const dstSrcDir = path.join(pluginsDir, 'src');
if (fs.existsSync(srcDir)) {
  fs.cpSync(srcDir, dstSrcDir, { recursive: true });
  console.log(`  src/ -> ${dstSrcDir}`);
}

// Step 2: Generate self-signed TLS certificate for the internal HTTPS server
// Node.js v24 removed crypto.createCertificate(), so we pre-generate via OpenSSL at install time.
// The plugin reads cert.pem/key.pem at runtime — no OpenSSL dependency at runtime.
// If OpenSSL is unavailable here, we SKIP cert generation: the plugin will generate an
// ephemeral localhost cert in memory at startup (via the `selfsigned` package) instead.
// No private key is ever bundled or written as a fallback.
console.log('Generating TLS certificate...');
try {
  // execFileSync with an argv array — paths are never interpreted by a shell,
  // so spaces/metacharacters in pluginsDir cannot inject commands.
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', path.join(pluginsDir, 'key.pem'),
      '-out', path.join(pluginsDir, 'cert.pem'),
      '-days', '3650', '-nodes', '-subj', '/CN=localhost',
    ],
    { stdio: 'pipe' }
  );
  console.log('  Generated cert.pem + key.pem (valid 10 years)');
} catch (e) {
  console.warn('  OpenSSL not available; skipping cert files. Plugin will generate an ephemeral localhost cert in memory at startup.');
}

// Step 2.5: Copy frontend extension to ST (chat_id injection script for per-chat memory isolation)
const frontendSrc = path.join(projectDir, 'frontend');
const frontendDst = path.join(stPath, 'public', 'scripts', 'extensions', 'third-party', 'memory-proxy');
if (fs.existsSync(frontendSrc)) {
  fs.mkdirSync(frontendDst, { recursive: true });
  fs.cpSync(frontendSrc, frontendDst, { recursive: true });
  console.log(`  frontend/ -> ${frontendDst}`);
}

// Step 3: Create package.json WITHOUT memory-proxy (it's bundled directly, not via npm symlink)
const originalPkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
delete originalPkg.dependencies['memory-proxy'];
fs.writeFileSync(path.join(pluginsDir, 'package.json'), JSON.stringify(originalPkg, null, 2));
console.log(`  package.json -> ${path.join(pluginsDir, 'package.json')}`);

// Step 4: Install npm deps (tsx, fastify, sql.js, tiktoken, uuid)
console.log('Installing dependencies...');
try {
  execSync('npm install --omit=dev', { cwd: pluginsDir, stdio: 'inherit' });
} catch {
  console.log('  (npm install failed — run "npm install" in plugin dir manually)');
}

// Step 5: Copy memory-proxy source into node_modules
// IMPORTANT: strip the src/ prefix so imports like 'memory-proxy/storage/db'
// resolve directly to node_modules/memory-proxy/storage/db.ts
const mpSrcDir = path.join(projectDir, '..', 'memory-proxy', 'src');
const mpDstDir = path.join(pluginsDir, 'node_modules', 'memory-proxy');
const mpPkgSrc = path.join(projectDir, '..', 'memory-proxy', 'package.json');
const mpPkgDst = path.join(pluginsDir, 'node_modules', 'memory-proxy', 'package.json');
if (fs.existsSync(mpSrcDir)) {
  fs.mkdirSync(mpDstDir, { recursive: true });
  // Copy contents of src/ directly into memory-proxy/ (no src/ subdirectory)
  for (const entry of fs.readdirSync(mpSrcDir, { withFileTypes: true })) {
    const srcEntry = path.join(mpSrcDir, entry.name);
    const dstEntry = path.join(mpDstDir, entry.name);
    if (entry.isDirectory()) {
      fs.cpSync(srcEntry, dstEntry, { recursive: true });
    } else {
      fs.copyFileSync(srcEntry, dstEntry);
    }
  }
  // Overwrite package.json: remove "type": "module" so tsx/cjs can require() it,
  // and add "exports" so dynamic import() can resolve .ts files in this package
  const mpPkg = JSON.parse(fs.readFileSync(mpPkgSrc, 'utf-8'));
  delete mpPkg.type;
  mpPkg.exports = { './*': './*.ts' };
  fs.writeFileSync(mpPkgDst, JSON.stringify(mpPkg, null, 2));
  console.log(`  memory-proxy/src/* -> ${mpDstDir}/`);
} else {
  console.error('  WARNING: memory-proxy source not found at', mpSrcDir);
}

console.log('');
console.log('Memory Proxy plugin installed!');
console.log('  Restart SillyTavern to activate.');
