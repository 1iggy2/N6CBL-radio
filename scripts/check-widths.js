#!/usr/bin/env node
/*
 * Check every page for horizontal viewport overflow.
 *
 * CLAUDE.md requires that no page force `body` wider than the viewport — the
 * failure mode where a wide table zooms the whole page out on a phone. That rule
 * was enforced by "mentally check at 390px", which missed a 5px overflow on
 * /station/ and a real one on /design/. This checks it for real, in a browser.
 *
 *   node scripts/check-widths.js            sweep the default widths
 *   node scripts/check-widths.js 390 1280   sweep specific widths
 *
 * Two failure modes are checked. Overflow is a page wider than the viewport.
 * A crushed column is a table that fits but has squeezed a prose cell down to a
 * few characters per line — /design/ shipped with a 22px "Job" column that
 * overflowed nothing and was unreadable on a phone.
 *
 * Exits 1 on either, naming the page, the width, and the offending elements.
 * Serves the repo over a throwaway local server; nothing is written.
 */
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_WIDTHS = [320, 390, 430, 768, 1024, 1280, 1440];
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
               '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
               '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

function pageRoutes(dir = ROOT, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) pageRoutes(full, found);
    else if (entry.name === 'index.html') {
      const rel = path.relative(ROOT, path.dirname(full));
      found.push(rel === '' ? '/' : `/${rel.split(path.sep).join('/')}/`);
    } else if (entry.name === '404.html' && path.relative(ROOT, dir) === '') {
      found.push('/404.html');
    }
  }
  return found;
}

function serve() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(ROOT, urlPath);
    if (urlPath.endsWith('/')) file = path.join(file, 'index.html');
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  const widths = process.argv.slice(2).map(Number).filter((n) => n > 0);
  const sweep = widths.length ? widths : DEFAULT_WIDTHS;
  const routes = pageRoutes().sort();

  const server = await serve();
  const port = server.address().port;
  const browser = await chromium.launch();
  const failures = [];

  /* One navigation per page, then resize in place — measuring 7 widths with 7
     page loads each is slow enough that nobody would run it. */
  const page = await browser.newPage({ viewport: { width: sweep[0], height: 900 } });
  for (const route of routes) {
    await page.goto(`http://127.0.0.1:${port}${route}`, { waitUntil: 'load' });
    for (const width of sweep) {
      await page.setViewportSize({ width, height: 900 });
      const result = await page.evaluate(() => {
        const offenders = [];
        document.querySelectorAll('body *').forEach((el) => {
          if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
            offenders.push(`${el.tagName}.${String(el.className).split(' ')[0] || '(none)'}`
              + ` needs ${el.scrollWidth}px in ${el.clientWidth}px`);
          }
        });

        /* A table can fit the viewport and still be unreadable: when fixed
           column widths eat the space, the text column is crushed to a few
           characters per line. That overflows nothing, so the check above
           cannot see it. Flag prose cells squeezed below a legible width. */
        const crushed = [];
        /* Body cells only. A <th> wrapping onto three lines above a numeric
           column is normal in a dense table, not a defect. */
        document.querySelectorAll('td').forEach((cell) => {
          if (getComputedStyle(cell).display === 'none') return;
          const text = (cell.textContent || '').trim();
          if (text.length < 20) return;
          const width = cell.clientWidth;
          if (width > 0 && width < 60) {
            crushed.push(`${cell.tagName}.${String(cell.className).split(' ')[0] || '(none)'}`
              + ` is ${width}px wide for ${text.length} chars: ${JSON.stringify(text.slice(0, 30))}`);
          }
        });

        return { body: document.body.scrollWidth, win: window.innerWidth, offenders, crushed };
      });

      if (result.body > result.win) {
        failures.push({ route, width, kind: 'overflow', body: result.body,
                        detail: result.offenders.slice(0, 3) });
      }
      if (result.crushed.length) {
        failures.push({ route, width, kind: 'crushed', detail: result.crushed.slice(0, 3) });
      }
    }
  }
  await page.close();

  await browser.close();
  server.close();

  if (failures.length) {
    console.error(`Layout problems on ${failures.length} page/width combination(s):\n`);
    for (const f of failures) {
      console.error(f.kind === 'overflow'
        ? `  ${f.route} at ${f.width}px — OVERFLOW, body is ${f.body}px`
        : `  ${f.route} at ${f.width}px — CRUSHED COLUMN`);
      for (const d of f.detail) console.error(`      ${d}`);
    }
    process.exit(1);
  }

  console.log(`No overflow and no crushed columns: ${routes.length} pages x ${sweep.length} widths.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
