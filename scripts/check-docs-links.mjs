#!/usr/bin/env node
// Validate relative markdown links across the repo. Fails (exit 1) on any link
// that points to a missing file, so broken docs/ADR references are caught early.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';

const ROOT = resolve(process.cwd());
const IGNORED_DIRS = new Set(['node_modules', '.git', '.next', 'dist', '.turbo', 'coverage']);
const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;

/** Recursively collect markdown files under `dir`. */
function collectMarkdown(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) collectMarkdown(full, out);
    else if (entry.endsWith('.md')) out.push(full);
  }
  return out;
}

function isExternal(target) {
  return (
    target.startsWith('http://') ||
    target.startsWith('https://') ||
    target.startsWith('mailto:') ||
    target.startsWith('#')
  );
}

/** Return a list of { file, target } broken links. */
export function findBrokenLinks(rootDir = ROOT) {
  const broken = [];
  for (const file of collectMarkdown(rootDir)) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(LINK_RE)) {
      const raw = match[1].trim().split(/\s+/)[0];
      if (!raw || isExternal(raw)) continue;
      const withoutAnchor = raw.split('#')[0];
      if (!withoutAnchor) continue;
      const resolved = resolve(dirname(file), withoutAnchor);
      if (!existsSync(resolved)) {
        broken.push({ file: relative(rootDir, file), target: raw });
      }
    }
  }
  return broken;
}

function main() {
  const broken = findBrokenLinks(ROOT);
  if (broken.length > 0) {
    console.error(`Found ${broken.length} broken markdown link(s):`);
    for (const b of broken) console.error(`  - ${b.file} -> ${b.target}`);
    process.exit(1);
  }
  console.log('All relative markdown links resolve.');
}

// Run when invoked directly (not when imported by a test).
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('check-docs-links.mjs')
) {
  main();
}
