const fs = require('fs');
const css = fs.readFileSync('src/style.css', 'utf8');
const body = fs.readFileSync('src/body.html', 'utf8');
const prompt = fs.readFileSync('src/system-prompt.js', 'utf8');
const memory = fs.readFileSync('src/memory.js', 'utf8');
const app = fs.readFileSync('src/app.js', 'utf8');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no">
<title>AI Chat</title>
<style>${css}</style>
</head>
<body>
${body}
<script>${prompt}${memory}${app}</script>
</body>
</html>`;

fs.writeFileSync('index.html', html, 'utf8');
console.log('✓ Built index.html  (' + (html.length / 1024).toFixed(1) + ' KB)');
