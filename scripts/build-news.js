#!/usr/bin/env node
/*
 * Regenerate /news/ from content/news/*.json.
 *
 *   node scripts/build-news.js           rewrite news/index.html in place
 *   node scripts/build-news.js --check   exit 1 if committed HTML is stale
 *
 * Marker pairs in news/index.html:
 *   NEWS_COUNT_START/END     latest desk count + date
 *   NEWS_DESK_START/END      latest digest table (or empty-state copy)
 *   NEWS_ARCHIVE_START/END   prior days as Date | N items | Read →
 *   NEWS_HISTORY_START/END   older desks as full tables, newest first
 *
 * The latest desk table is the first full table. Prior days are indexed in
 * the archive and repeated as full tables below it, matching /blog/.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONTENT_DIR = path.join(ROOT, 'content', 'news');
const NEWS_FILE = path.join(ROOT, 'news', 'index.html');
const TOPICS = new Set(['OPS', 'POLICY', 'POTA', 'GEAR', 'WORKBENCH', 'DX', 'RF', 'SPACE']);

function main() {
  const check = process.argv.includes('--check');
  const desks = readDesks();
  const original = fs.readFileSync(NEWS_FILE, 'utf8');
  const updated = renderPage(original, desks);

  if (check) {
    if (updated !== original) {
      console.error('News HTML is stale. Run: node scripts/build-news.js');
      process.exit(1);
    }
    console.log('News output is current.');
    return;
  }

  if (updated !== original) fs.writeFileSync(NEWS_FILE, updated);
  console.log(`Built news desk from ${desks.length} day(s).`);
}

function readDesks() {
  if (!fs.existsSync(CONTENT_DIR)) return [];
  return fs.readdirSync(CONTENT_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const file = path.join(CONTENT_DIR, name);
      const desk = JSON.parse(fs.readFileSync(file, 'utf8'));
      desk.__file = path.relative(ROOT, file);
      desk.__name = name;
      validateDesk(desk);
      return desk;
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

function validateDesk(desk) {
  const file = desk.__file || 'desk';
  if (!desk.date || typeof desk.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(desk.date)) {
    throw new Error(`${file} has invalid date: ${desk.date}`);
  }
  if (desk.__name && desk.__name !== `${desk.date}.json`) {
    throw new Error(`${file} must be named ${desk.date}.json`);
  }
  if (desk.updatedAt && Number.isNaN(Date.parse(desk.updatedAt))) {
    throw new Error(`${file} has invalid updatedAt: ${desk.updatedAt}`);
  }

  const emptyDesk = desk.empty === true;
  if (!Array.isArray(desk.items)) {
    if (emptyDesk) {
      desk.items = [];
    } else {
      throw new Error(`${file} needs a nonempty items array or an explicit empty desk`);
    }
  }
  if (!desk.items.length && !emptyDesk) {
    /* An empty items array is itself an explicit empty desk. */
  }

  desk.items.forEach((item, index) => {
    const required = ['topic', 'title', 'source', 'url', 'blurb'];
    for (const key of required) {
      if (!item[key] || typeof item[key] !== 'string') {
        throw new Error(`${file} item ${index} missing string field: ${key}`);
      }
    }
    if (!TOPICS.has(item.topic)) {
      throw new Error(`${file} item ${index} has invalid topic: ${item.topic}`);
    }
    if (!/^https?:\/\//i.test(item.url)) {
      throw new Error(`${file} item ${index} url must be http(s)`);
    }
  });
}

function renderPage(html, desks) {
  const latest = desks[0];
  const prior = desks.slice(1);
  const countText = latest
    ? `${latest.items.length} ${latest.items.length === 1 ? 'item' : 'items'} &mdash; ${escapeHtml(latest.date)}`
    : '0 items';

  html = replaceBetween(html, 'NEWS_COUNT_START', 'NEWS_COUNT_END', countText);
  html = replaceBetween(html, 'NEWS_DESK_START', 'NEWS_DESK_END', '\n' + renderLatest(latest) + '\n      ');
  html = replaceBetween(html, 'NEWS_ARCHIVE_START', 'NEWS_ARCHIVE_END', '\n' + renderArchive(prior) + (prior.length ? '\n      ' : '      '));
  html = replaceBetween(html, 'NEWS_HISTORY_START', 'NEWS_HISTORY_END', '\n' + renderHistory(desks) + (desks.length ? '\n      ' : '      '));
  return html;
}

function renderLatest(desk) {
  if (!desk) {
    return '      <p class="news-empty">No ham desk has been compiled yet. Add a <span class="path">content/news/YYYY-MM-DD.json</span> file and run <span class="path">node scripts/build-news.js</span>.</p>';
  }
  if (!desk.items.length) {
    return [
      `      <section class="news-desk" id="desk-${desk.date}" aria-label="Latest desk ${desk.date}">`,
      `        <p class="news-empty">Desk ${escapeHtml(desk.date)} is empty. No items were filed this day.</p>`,
      '      </section>',
    ].join('\n');
  }
  return [
    `      <section class="news-desk" id="desk-${desk.date}" aria-label="Latest desk ${desk.date}">`,
    '        <div class="table-scroll">',
    renderTable(desk.items, '          '),
    '        </div>',
    '        <div class="pota-footer">',
    '          <span>Desk compiled from public ham sources. Not a wire service. Links go to the original.</span>',
    '        </div>',
    '      </section>',
  ].join('\n');
}

function renderArchive(desks) {
  if (!desks.length) return '';
  const rows = desks.map((desk) => {
    const n = desk.items.length;
    const count = `${n} ${n === 1 ? 'item' : 'items'}`;
    return [
      '            <tr>',
      `              <td class="blog-date">${escapeHtml(desk.date)}</td>`,
      `              <td class="news-archive-count">${count}</td>`,
      `              <td class="blog-cta"><a href="#desk-${desk.date}">Read &#8594;</a></td>`,
      '            </tr>',
    ].join('\n');
  });
  return [
    '      <section class="news-archive" aria-labelledby="news-archive-heading">',
    '        <div class="section-label split">',
    '          <span id="news-archive-heading">Prior desks</span>',
    `          <span class="log-count">${desks.length} ${desks.length === 1 ? 'day' : 'days'}</span>`,
    '        </div>',
    '        <div class="table-scroll">',
    '          <table class="news-archive-table">',
    '            <thead>',
    '              <tr>',
    '                <th>Date</th>',
    '                <th>Items</th>',
    '                <th>CTA</th>',
    '              </tr>',
    '            </thead>',
    '            <tbody>',
    ...rows,
    '            </tbody>',
    '          </table>',
    '        </div>',
    '      </section>',
  ].join('\n');
}

function renderHistory(desks) {
  if (!desks.length) return '';
  return desks.map((desk, index) => renderHistoryDesk(desk, index === 0)).join('\n');
}

function renderHistoryDesk(desk, isLatest) {
  const n = desk.items.length;
  const count = `${n} ${n === 1 ? 'item' : 'items'}`;
  const headingId = `desk-${desk.date}-label`;
  /* Latest desk already has id="desk-DATE" on the index table. History
     repeats that day as the first full table and must not duplicate the id. */
  const idAttr = isLatest ? '' : ` id="desk-${desk.date}"`;
  const body = desk.items.length
    ? [
        '        <div class="table-scroll">',
        renderTable(desk.items, '          '),
        '        </div>',
      ]
    : [
        `        <p class="news-empty">Desk ${escapeHtml(desk.date)} is empty. No items were filed this day.</p>`,
      ];
  return [
    `      <section class="news-history"${idAttr} aria-labelledby="${headingId}">`,
    '        <div class="section-label split">',
    `          <span id="${headingId}">Desk ${escapeHtml(desk.date)}</span>`,
    `          <span class="log-count">${count}</span>`,
    '        </div>',
    ...body,
    '      </section>',
  ].join('\n');
}

function renderTable(items, indent) {
  const rows = items.map((item) => [
    `${indent}  <tr>`,
    `${indent}    <td class="path">${escapeHtml(item.topic)}</td>`,
    `${indent}    <td class="news-item">`,
    `${indent}      <div class="news-item-title">${escapeHtml(item.title)}</div>`,
    `${indent}      <div class="news-item-blurb">${escapeHtml(item.blurb)}</div>`,
    `${indent}    </td>`,
    `${indent}    <td class="news-source">${escapeHtml(item.source)}</td>`,
    `${indent}    <td class="blog-cta"><a href="${escapeAttribute(item.url)}" target="_blank" rel="noopener">Source &#8599;</a></td>`,
    `${indent}  </tr>`,
  ].join('\n'));
  return [
    `${indent}<table class="news-table">`,
    `${indent}  <thead>`,
    `${indent}    <tr>`,
    `${indent}      <th>Topic</th>`,
    `${indent}      <th>Item</th>`,
    `${indent}      <th>Source</th>`,
    `${indent}      <th>CTA</th>`,
    `${indent}    </tr>`,
    `${indent}  </thead>`,
    `${indent}  <tbody>`,
    ...rows,
    `${indent}  </tbody>`,
    `${indent}</table>`,
  ].join('\n');
}

function replaceBetween(source, startName, endName, replacement) {
  const start = `<!-- ${startName} -->`;
  const end = `<!-- ${endName} -->`;
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(`Missing marker pair ${startName}/${endName}`);
  }
  return source.slice(0, startIndex + start.length) + replacement + source.slice(endIndex);
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

main();
