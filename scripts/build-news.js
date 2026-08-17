#!/usr/bin/env node
/*
 * Regenerate /news/ from content/news/*.json.
 *
 *   node scripts/build-news.js           rewrite news/index.html in place
 *   node scripts/build-news.js --check   exit 1 if committed HTML is stale
 *
 * Marker pairs in news/index.html:
 *   NEWS_COUNT_START/END     latest desk count + date
 *   NEWS_DESK_START/END      latest digest as a blog-like article
 *   NEWS_ARCHIVE_START/END   prior days as Date | N items | Read →
 *   NEWS_HISTORY_START/END   older desks as full articles, newest first
 *
 * The latest desk is the first article. Prior days are indexed in the
 * archive and repeated as full articles below it. The latest day is not
 * repeated in history.
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
    const required = ['title', 'source', 'url', 'blurb'];
    for (const key of required) {
      if (!item[key] || typeof item[key] !== 'string') {
        throw new Error(`${file} item ${index} missing string field: ${key}`);
      }
    }
    if (item.topic != null && item.topic !== '') {
      if (typeof item.topic !== 'string' || !TOPICS.has(item.topic)) {
        throw new Error(`${file} item ${index} has invalid topic: ${item.topic}`);
      }
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
  html = replaceBetween(html, 'NEWS_HISTORY_START', 'NEWS_HISTORY_END', '\n' + renderHistory(prior) + (prior.length ? '\n      ' : '      '));
  return html;
}

function renderLatest(desk) {
  if (!desk) {
    return '      <p class="news-empty">No ham desk has been compiled yet. Add a <span class="path">content/news/YYYY-MM-DD.json</span> file and run <span class="path">node scripts/build-news.js</span>.</p>';
  }
  return [
    renderArticle(desk, '      '),
    '      <div class="pota-footer">',
    '        <span>Desk compiled from public ham sources. Not a wire service. Links go to the original.</span>',
    '      </div>',
  ].join('\n');
}

function renderArchive(desks) {
  if (!desks.length) return '';
  const rows = desks.map((desk) => {
    const n = desk.items.length;
    const count = `${n} ${n === 1 ? 'item' : 'items'}`;
    return [
      '            <tr>',
      `              <td class="blog-date"><a href="#desk-${desk.date}">${escapeHtml(desk.date)}</a></td>`,
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
    '        <table class="news-archive-table">',
    '          <thead>',
    '            <tr>',
    '              <th>Date</th>',
    '              <th>Items</th>',
    '              <th>CTA</th>',
    '            </tr>',
    '          </thead>',
    '          <tbody>',
    ...rows,
    '          </tbody>',
    '        </table>',
    '      </section>',
  ].join('\n');
}

function renderHistory(desks) {
  if (!desks.length) return '';
  return desks.map((desk) => renderArticle(desk, '      ')).join('\n');
}

function renderArticle(desk, indent) {
  const n = desk.items.length;
  const sources = uniqueInOrder(desk.items.map((item) => item.source));
  const topics = uniqueInOrder(desk.items.map(itemTopic).filter(Boolean));
  const meta = [`${indent}      <span>${n} ${n === 1 ? 'ITEM' : 'ITEMS'}</span>`];
  if (sources.length) {
    meta.push(`${indent}      <span>SOURCES: ${escapeHtml(sources.join(', '))}</span>`);
  }
  if (topics.length) {
    meta.push(`${indent}      <span>TOPICS: ${escapeHtml(topics.join(', '))}</span>`);
  }

  const body = desk.items.length
    ? desk.items.map((item) => renderItem(item, `${indent}    `)).join('\n')
    : `${indent}    <p class="news-empty">Desk ${escapeHtml(desk.date)} is empty. No items were filed this day.</p>`;

  return [
    `${indent}<article class="blog-post" id="desk-${desk.date}">`,
    `${indent}  <header class="blog-post-header">`,
    `${indent}    <div class="blog-post-date">${escapeHtml(desk.date)}</div>`,
    `${indent}    <h2>Ham desk</h2>`,
    `${indent}    <div class="blog-post-meta">`,
    ...meta,
    `${indent}    </div>`,
    `${indent}  </header>`,
    `${indent}  <div class="blog-prose">`,
    body,
    `${indent}  </div>`,
    `${indent}</article>`,
  ].join('\n');
}

function renderItem(item, indent) {
  const topic = itemTopic(item);
  const topicTag = topic ? `\n${indent}    <span>${escapeHtml(topic)}</span>` : '';
  return [
    `${indent}<div class="news-item">`,
    `${indent}  <h3 class="news-item-title"><a href="${escapeAttribute(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.title)}</a></h3>`,
    `${indent}  <div class="news-item-meta">`,
    `${indent}    <span>${escapeHtml(item.source)}</span>`,
    `${indent}    <a href="${escapeAttribute(item.url)}" target="_blank" rel="noopener">Source &#8599;</a>${topicTag}`,
    `${indent}  </div>`,
    `${indent}  <p>${escapeHtml(item.blurb)}</p>`,
    `${indent}</div>`,
  ].join('\n');
}

function itemTopic(item) {
  return item.topic && TOPICS.has(item.topic) ? item.topic : '';
}

function uniqueInOrder(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
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
