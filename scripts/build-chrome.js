#!/usr/bin/env node
/*
 * Regenerate the permanent sidebar navigator in every page from content/nav.json.
 *
 * The sidebar is copied into every HTML file, so adding or removing a route used
 * to mean hand-editing ~28 files and the copies drifted apart anyway. This script
 * owns the <ul class="nav-tree"> block only; the rest of each sidebar (station
 * facts, profiles, operator card) stays hand-written, since it varies by page.
 *
 *   node scripts/build-chrome.js           rewrite the nav block in place
 *   node scripts/build-chrome.js --check   exit 1 if any page is out of sync
 *
 * Output is committed static HTML — there is no runtime cost and no client-side
 * navigation rendering, matching how scripts/build-blog.js handles blog output.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const NAV_SOURCE = path.join(ROOT, 'content', 'nav.json');
const NAV_BLOCK = /([ \t]*)<ul class="nav-tree">[\s\S]*?<\/ul>/;

/* Pages that deliberately have no sidebar. /tools/uav/x/ is the sanctioned
   design-doctrine exception and ships its own app-like shell. */
const NO_SIDEBAR = new Set(['tools/uav/x/index.html']);

function htmlFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) htmlFiles(full, found);
    else if (entry.name.endsWith('.html')) found.push(full);
  }
  return found;
}

/* /log/stats/index.html -> /log/stats/ ; index.html -> / */
function routeForFile(relPath) {
  const dir = path.dirname(relPath);
  return dir === '.' ? '/' : `/${dir.split(path.sep).join('/')}/`;
}

function renderNav(routes, currentRoute, indent) {
  const li = `${indent}  `;
  const rows = routes.map((route) => {
    const itemClass = route.unimplemented ? 'nav-item nav-item-unimplemented' : 'nav-item';
    const current = route.path === currentRoute ? ' aria-current="page"' : '';
    /* Child rows show the leaf plus a ↳, and carry the full path for screen
       readers, per the flat-navigation rule in CLAUDE.md. */
    const span = route.child
      ? `<span class="nav-path" aria-label="${route.path}">&#x21B3; ${route.label}</span>`
      : `<span class="nav-path">${route.label}</span>`;
    return [
      `${li}<li class="${itemClass}">`,
      `${li}  <a href="${route.path}"${current}>`,
      `${li}    ${span}`,
      `${li}  </a>`,
      `${li}</li>`,
    ].join('\n');
  });
  return `${indent}<ul class="nav-tree">\n${rows.join('\n')}\n${indent}</ul>`;
}

function main() {
  const check = process.argv.includes('--check');
  const { routes } = JSON.parse(fs.readFileSync(NAV_SOURCE, 'utf8'));

  const stale = [];
  let written = 0;
  let skipped = 0;

  for (const file of htmlFiles(ROOT)) {
    const rel = path.relative(ROOT, file);
    if (NO_SIDEBAR.has(rel.split(path.sep).join('/'))) continue;

    const original = fs.readFileSync(file, 'utf8');
    const match = original.match(NAV_BLOCK);
    if (!match) {
      skipped += 1;
      continue;
    }

    const updated = original.replace(NAV_BLOCK, renderNav(routes, routeForFile(rel), match[1]));
    if (updated === original) continue;

    stale.push(rel);
    if (!check) {
      fs.writeFileSync(file, updated);
      written += 1;
    }
  }

  if (check) {
    if (stale.length) {
      console.error(`Navigator out of sync with content/nav.json in ${stale.length} file(s):`);
      for (const file of stale) console.error(`  ${file}`);
      console.error('Run: node scripts/build-chrome.js');
      process.exit(1);
    }
    console.log('Navigator is in sync with content/nav.json.');
    return;
  }

  console.log(`Navigator rebuilt: ${written} file(s) updated, ${skipped} without a nav block.`);
}

main();
