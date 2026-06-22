import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Plugin scaffold', () => {
  it('should have working test runner', () => {
    expect(true).toBe(true);
  });

  it('should expose an exit hook for SillyTavern cleanup', () => {
    const plugin = require('../../index.js');
    expect(plugin.exit).toBeTypeOf('function');
  });

  it('installer should import execSync before using it', () => {
    const script = fs.readFileSync(path.join(__dirname, '../../scripts/install-to-st.js'), 'utf-8');
    expect(script).toMatch(/execSync/);
    expect(script).toMatch(/const\s*\{[^}]*execSync[^}]*\}\s*=\s*require\('child_process'\)/s);
  });
});
