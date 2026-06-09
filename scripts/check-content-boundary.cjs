#!/usr/bin/env node

const { execFileSync } = require('node:child_process');

function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  return output.split('\0').filter(Boolean);
}

const findings = trackedFiles()
  .filter((filePath) => filePath.startsWith('.flow-agents/'))
  .map((filePath) => `${filePath}:1 Flow Agents runtime artifact must not be tracked in this repo`);

if (findings.length > 0) {
  console.error('Content boundary check failed:');
  for (const finding of findings) {
    console.error(`- ${finding}`);
  }
  process.exit(1);
}

console.log('Content boundary check passed.');
