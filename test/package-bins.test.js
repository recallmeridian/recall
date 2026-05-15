'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

describe('package binary declarations', () => {
  test('all declared package binaries exist in the checkout', () => {
    const pkg = require('../package.json');
    for (const [name, relativePath] of Object.entries(pkg.bin)) {
      const filePath = path.join(root, relativePath);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.statSync(filePath).isFile()).toBe(true);
      expect(name).toBeTruthy();
    }
  });

  test('recall wrapper delegates to the meridian entrypoint', () => {
    const wrapper = fs.readFileSync(path.join(root, 'bin', 'recall.js'), 'utf8');
    expect(wrapper).toContain('#!/usr/bin/env node');
    expect(wrapper).toContain("require('./meridian')");
  });
});
