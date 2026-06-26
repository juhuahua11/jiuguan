const fs = require('fs');
const path = require('path');

const SYSTEM_PROMPT_SOURCE_PATH = path.join(__dirname, '..', 'src', 'system-prompt.js');
const OPTION_WORD = '\u9009\u9879';
const HEADER_TEXT = '\u3010\u4e0b\u4e00\u6b65\u5267\u60c5\u53d1\u5c55\u63a8\u8350\u9009\u9879\u3011';

function loadOptionTypes() {
  const out = { A: 'A', B: 'B', C: 'C', D: 'D' };
  try {
    const src = fs.readFileSync(SYSTEM_PROMPT_SOURCE_PATH, 'utf-8');
    const re = new RegExp(OPTION_WORD + '\\s*([A-D])\\s*[\\uFF1A:]\\s*\\[([^\\]\\n]+)\\]', 'g');
    let m;
    while ((m = re.exec(src))) out[m[1]] = m[2].trim();
  } catch (e) {
    console.warn('[jiuguan-watchdog] failed to read option styles:', e?.message || e);
  }
  return out;
}

const OPTION_TYPES = loadOptionTypes();

function optionTemplate(label, detail = '') {
  return OPTION_WORD + ' ' + label + ':[' + OPTION_TYPES[label] + ']' + detail;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function typePattern(type) {
  const parts = String(type || '').split('/');
  if (parts.length === 2) return escapeRegExp(parts[0]) + '\\s*/\\s*' + escapeRegExp(parts[1]);
  return escapeRegExp(type);
}

function optionTypePattern(label) {
  return new RegExp(
    OPTION_WORD + '\\s*' + label + '\\s*[\\uFF1A:]\\s*[\\[\\u3010]?\\s*' + typePattern(OPTION_TYPES[label]) + '\\s*[\\]\\u3011]?',
    'i'
  );
}

function validateTypedOptions(text) {
  const s = String(text || '');
  const hasHeader = s.includes(HEADER_TEXT);
  const labels = ['A', 'B', 'C', 'D'];
  const presentOptions = labels.filter((label) => optionTypePattern(label).test(s));
  return {
    ok: hasHeader && presentOptions.length === labels.length,
    hasHeader,
    presentOptions,
    missingOptions: labels.filter((label) => !presentOptions.includes(label)),
  };
}

function missingText(validation) {
  return validation.missingOptions.length
    ? validation.missingOptions.map((label) => label + '[' + OPTION_TYPES[label] + ']').join(', ')
    : validation.hasHeader ? 'option style mismatch' : 'header and option style mismatch';
}

module.exports = {
  HEADER_TEXT,
  OPTION_TYPES,
  optionTemplate,
  validateTypedOptions,
  missingText,
};
