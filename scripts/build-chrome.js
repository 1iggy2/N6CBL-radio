#!/usr/bin/env node
/*
 * Regenerate the shared page chrome in every page from content/nav.json.
 *
 * The chrome is copied into every HTML file, so changing it used to mean
 * hand-editing ~28 files, and the copies drifted apart anyway. This script owns
 * three blocks: the sidebar navigator, the sidebar station facts, and the site
 * footer. The rest of each sidebar (profiles, operator card) is still
 * hand-written.
 *
 * The navigator was the first block to be generated, after one page turned out
 * to be missing three routes. The other two were added once the same failure
 * showed up in them: the site had split into two variants of the station facts
 * (Chameleon SS-17 / SSB · 20m on eight pages, CHA SS17 / SSB · FT8 · CW study
 * on twenty) and two variants of the footer credit — with different inline SVGs
 * — along the same seam, while /blog/ and /blog/compose/ had no footer at all.
 *
 *   node scripts/build-chrome.js           rewrite the chrome blocks in place
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
const STATION_BLOCK = /([ \t]*)<dl class="sidenav-dl">[\s\S]*?<\/dl>/;
/* Matches <footer> with no attributes only, so /tools/uav/x/'s <footer
   class="xfoot"> keeps its own shell. */
const FOOTER_BLOCK = /([ \t]*)<footer>[\s\S]*?<\/footer>/;
/* Where a footer goes on a page that has none yet. */
const LAYOUT_END = /([ \t]*)<\/div><!-- \/\.layout-body -->/;

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
    /* An unimplemented route stays visible — CLAUDE.md requires it — but it is
       not a link. /prints/ shipped as a live <a> to a page that does not exist,
       so the one row on the site advertising future work was also the one row
       that returned a 404. The muted row now says "planned" out loud instead of
       inviting a click that fails. */
    const body = route.unimplemented
      ? [`${li}  <span class="nav-planned" title="Planned route, not published yet">`,
         `${li}    ${span}`,
         `${li}  </span>`]
      : [`${li}  <a href="${route.path}"${current}>`,
         `${li}    ${span}`,
         `${li}  </a>`];
    return [`${li}<li class="${itemClass}">`, ...body, `${li}</li>`].join('\n');
  });
  return `${indent}<ul class="nav-tree">\n${rows.join('\n')}\n${indent}</ul>`;
}

function renderStation(station, indent) {
  const rows = station.map((fact) => [
    `${indent}  <dt>${fact.label}</dt>`,
    `${indent}  <dd>${fact.value}</dd>`,
  ].join('\n'));
  return `${indent}<dl class="sidenav-dl">\n${rows.join('\n')}\n${indent}</dl>`;
}

/* The pixel flag is decorative chrome, not data, so it lives here rather than
   in nav.json — it has no content to keep in sync, only a shape. */
function claudeMark(indent) {
  const rects = [
    'x="2" y="1" width="12" height="7" fill="#c8401a"',
    'x="0" y="3" width="2" height="3" fill="#c8401a"',
    'x="14" y="3" width="2" height="3" fill="#c8401a"',
    'x="5" y="2" width="2" height="3" fill="#0a0a0a"',
    'x="9" y="2" width="2" height="3" fill="#0a0a0a"',
    'x="3" y="8" width="2" height="5" fill="#c8401a"',
    'x="6" y="8" width="2" height="5" fill="#c8401a"',
    'x="9" y="8" width="2" height="5" fill="#c8401a"',
    'x="12" y="8" width="2" height="5" fill="#c8401a"',
  ];
  return [
    `${indent}  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 13" width="18" height="15" aria-hidden="true">`,
    ...rects.map((r) => `${indent}    <rect ${r}/>`),
    `${indent}  </svg>`,
  ].join('\n');
}

function renderFooter(footer, indent) {
  return [
    `${indent}<footer>`,
    `${indent}  <div>`,
    `${indent}    <span>${footer.owner}</span>`,
    `${indent}    <span>${footer.rights}</span>`,
    `${indent}  </div>`,
    `${indent}  <div>`,
    `${indent}    <a href="${footer.contactUrl}" target="_blank" rel="noopener">${footer.contactLabel}</a>`,
    `${indent}  </div>`,
    `${indent}  <div class="footer-claude">`,
    claudeMark(`${indent}  `),
    `${indent}    <span>${footer.credit}</span>`,
    `${indent}  </div>`,
    `${indent}</footer>`,
  ].join('\n');
}

/* Replace the page's block, or append one after .layout-body when the page has
   none — /blog/ and /blog/compose/ shipped with no footer at all. */
function applyBlock(source, pattern, render) {
  const match = source.match(pattern);
  if (match) return source.replace(pattern, render(match[1]));
  const anchor = source.match(LAYOUT_END);
  if (!anchor) return source;
  return source.replace(LAYOUT_END, `${anchor[0]}\n\n${render(anchor[1])}`);
}

function main() {
  const check = process.argv.includes('--check');
  const { routes, station, footer } = JSON.parse(fs.readFileSync(NAV_SOURCE, 'utf8'));

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

    let updated = original.replace(NAV_BLOCK, renderNav(routes, routeForFile(rel), match[1]));
    updated = applyBlock(updated, STATION_BLOCK, (indent) => renderStation(station, indent));
    updated = applyBlock(updated, FOOTER_BLOCK, (indent) => renderFooter(footer, indent));
    if (updated === original) continue;

    stale.push(rel);
    if (!check) {
      fs.writeFileSync(file, updated);
      written += 1;
    }
  }

  if (check) {
    if (stale.length) {
      console.error(`Page chrome out of sync with content/nav.json in ${stale.length} file(s):`);
      for (const file of stale) console.error(`  ${file}`);
      console.error('Run: node scripts/build-chrome.js');
      process.exit(1);
    }
    console.log('Page chrome is in sync with content/nav.json.');
    return;
  }

  console.log(`Page chrome rebuilt: ${written} file(s) updated, ${skipped} without a nav block.`);
}

main();
