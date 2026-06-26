// Bootstrap wrapper for jiuguan server.
// It injects src/stream-watchdog-patch.js into index.html at runtime so the
// frontend can handle the backend's replace_branch SSE control event even when
// index.html was built before the patch existed.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const originalReadFile = fsp.readFile.bind(fsp);
const patchPath = path.join(__dirname, 'src', 'stream-watchdog-patch.js');

function shouldPatchHtml(filePath) {
  const name = String(filePath || '').replace(/\\/g, '/');
  return name.endsWith('/index.html') || name === 'index.html';
}

function injectPatch(html, patch) {
  if (!patch || html.includes('Streaming watchdog patch')) return html;
  if (html.includes('</script>\n</body>')) {
    return html.replace('</script>\n</body>', patch + '\n</script>\n</body>');
  }
  if (html.includes('</script></body>')) {
    return html.replace('</script></body>', patch + '\n</script></body>');
  }
  if (html.includes('</body>')) {
    return html.replace('</body>', '<script>' + patch + '</script>\n</body>');
  }
  return html;
}

fsp.readFile = async function patchedReadFile(filePath, options) {
  const data = await originalReadFile(filePath, options);
  try {
    if (!shouldPatchHtml(filePath) || !fs.existsSync(patchPath)) return data;
    const patch = await originalReadFile(patchPath, 'utf8');
    if (Buffer.isBuffer(data)) {
      return Buffer.from(injectPatch(data.toString('utf8'), patch), 'utf8');
    }
    if (typeof data === 'string') return injectPatch(data, patch);
  } catch (e) {
    console.warn('[jiuguan-watchdog] failed to inject frontend stream patch:', e?.message || e);
  }
  return data;
};

require('./server.js');
