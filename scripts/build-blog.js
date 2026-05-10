#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONTENT_DIR = path.join(ROOT, 'content', 'blog');
const BLOG_FILE = path.join(ROOT, 'blog', 'index.html');
const HOME_FILE = path.join(ROOT, 'index.html');

function main() {
  const posts = readPosts();
  updateBlog(posts);
  updateHome(posts[0]);
  console.log(`Built blog index from ${posts.length} structured posts.`);
}

function readPosts() {
  if (!fs.existsSync(CONTENT_DIR)) return [];
  return fs.readdirSync(CONTENT_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const file = path.join(CONTENT_DIR, name);
      const post = JSON.parse(fs.readFileSync(file, 'utf8'));
      post.__file = path.relative(ROOT, file);
      validatePost(post);
      return post;
    })
    .sort(comparePosts);
}

function comparePosts(a, b) {
  const publishedCompare = comparablePublishedAt(b).localeCompare(comparablePublishedAt(a));
  if (publishedCompare) return publishedCompare;
  const dateCompare = b.date.localeCompare(a.date);
  if (dateCompare) return dateCompare;
  return a.slug.localeCompare(b.slug);
}

function comparablePublishedAt(post) {
  if (!post.publishedAt) return `${post.date}T00:00:00.000Z`;
  const date = new Date(post.publishedAt);
  return Number.isNaN(date.getTime()) ? post.publishedAt : date.toISOString();
}

function validatePost(post) {
  const required = ['date', 'title', 'slug', 'type', 'context'];
  for (const key of required) {
    if (!post[key] || typeof post[key] !== 'string') {
      throw new Error(`${post.__file || 'post'} missing string field: ${key}`);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(post.date)) {
    throw new Error(`${post.__file} has invalid date: ${post.date}`);
  }
  if (post.publishedAt && Number.isNaN(Date.parse(post.publishedAt))) {
    throw new Error(`${post.__file} has invalid publishedAt: ${post.publishedAt}`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(post.slug)) {
    throw new Error(`${post.__file} has invalid slug: ${post.slug}`);
  }
  if (!Array.isArray(post.tags)) post.tags = [];
  if (!Array.isArray(post.photos)) post.photos = [];
  if (!Array.isArray(post.body) && !Array.isArray(post.bodyHtml)) {
    throw new Error(`${post.__file} needs body or bodyHtml array`);
  }
}

function updateBlog(posts) {
  let html = fs.readFileSync(BLOG_FILE, 'utf8');
  const countText = `${posts.length} ${posts.length === 1 ? 'post' : 'posts'} &mdash; newest first`;
  html = html.replace(/<span>\d+ posts? &mdash; newest first<\/span>/, `<span>${countText}</span>`);
  html = replaceBetween(html, 'BLOG_INDEX_START', 'BLOG_INDEX_END', '\n' + posts.map(renderIndexRow).join('\n') + '\n          ');
  html = replaceBetween(html, 'BLOG_POSTS_START', 'BLOG_POSTS_END', '\n' + posts.map(renderArticle).join('\n') + '\n        ');
  fs.writeFileSync(BLOG_FILE, html);
}

function updateHome(latest) {
  if (!latest) return;
  let html = fs.readFileSync(HOME_FILE, 'utf8');
  html = replaceBetween(html, 'LATEST_BLOG_ROW_START', 'LATEST_BLOG_ROW_END', '\n' + renderHomeRow(latest) + '\n            ');
  fs.writeFileSync(HOME_FILE, html);
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

function renderIndexRow(post) {
  return `            <tr>\n              <td class="blog-date">${escapeHtml(post.date)}</td>\n              <td class="blog-ref">${escapeHtml(post.title)}</td>\n              <td class="blog-context">${escapeHtml(post.context)}</td>\n              <td class="blog-cta"><a href="#${postId(post)}">Read &#8594;</a></td>\n            </tr>`;
}

function renderHomeRow(post) {
  return `            <tr>\n              <td class="blog-date">${escapeHtml(post.date)}</td>\n              <td class="blog-ref">${escapeHtml(post.title)}</td>\n              <td class="blog-context">${escapeHtml(post.context)}</td>\n              <td class="blog-cta"><a href="/blog/#${postId(post)}">Read &#8594;</a></td>\n            </tr>`;
}

function renderArticle(post) {
  const bodyBlocks = Array.isArray(post.bodyHtml) ? post.bodyHtml : post.body;
  const photoHtml = renderPhotoGrid(photosNotEmbedded(post.photos, bodyBlocks));
  const paragraphs = Array.isArray(post.bodyHtml) ? post.bodyHtml.map(renderHtmlBlock) : post.body.map(renderBodyBlock);
  return `        <article class="blog-post" id="${postId(post)}">\n          <header class="blog-post-header">\n            <div class="blog-post-date">${escapeHtml(post.date)}</div>\n            <h2>${escapeHtml(post.title)}</h2>\n            <div class="blog-post-meta">\n              <span>TYPE: ${escapeHtml(post.type.toUpperCase())}</span>\n              <span>TAGS: ${escapeHtml(post.tags.join(', ') || 'untagged')}</span>\n              <span>STATUS: LIVE</span>${renderPublishedMeta(post)}\n            </div>\n          </header>\n${photoHtml ? photoHtml + '\n' : ''}          <div class="blog-prose">\n${paragraphs.join('\n')}\n          </div>\n        </article>`;
}

function renderPublishedMeta(post) {
  if (!post.publishedAt) return '';
  return `\n              <span>PUBLISHED: ${escapeHtml(formatPublishedAt(post.publishedAt))}</span>`;
}

function formatPublishedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace(/:\d{2}\.\d{3}Z$/, 'Z');
}

function photosNotEmbedded(photos, bodyBlocks) {
  if (!photos.length) return [];
  const bodyText = Array.isArray(bodyBlocks) ? bodyBlocks.join('\n') : '';
  return photos.filter((photo) => !bodyText.includes(photo.src));
}

function renderPhotoGrid(photos) {
  if (!photos.length) return '';
  return `          <div class="blog-photo-grid">\n${photos.map(renderPhoto).join('\n')}\n          </div>`;
}

function renderPhoto(photo) {
  const size = photo.width && photo.height ? ` width="${Number(photo.width)}" height="${Number(photo.height)}"` : '';
  return `            <figure class="blog-photo">\n              <img src="${escapeAttribute(photo.src)}" alt="${escapeAttribute(photo.alt || photo.caption || '')}"${size} loading="lazy">\n              <figcaption>${escapeHtml(photo.caption || photo.alt || '')}</figcaption>\n            </figure>`;
}

function renderBodyBlock(text) {
  const value = String(text);
  if (containsHtml(value)) return renderHtmlBlock(value);
  return `            <p>
              ${renderInlineText(value)}
            </p>`;
}

function containsHtml(value) {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}

function renderInlineText(text) {
  const urlPattern = /https?:\/\/[^\s<>"']+/g;
  let output = '';
  let lastIndex = 0;
  let match;
  while ((match = urlPattern.exec(text)) !== null) {
    const url = match[0];
    const trimmedUrl = url.replace(/[.,!?;:)]*$/, '');
    const trailing = url.slice(trimmedUrl.length);
    output += escapeHtml(text.slice(lastIndex, match.index));
    output += renderExternalLink(trimmedUrl);
    output += escapeHtml(trailing);
    lastIndex = match.index + url.length;
  }
  output += escapeHtml(text.slice(lastIndex));
  return output;
}

function renderExternalLink(url) {
  return `<a href="${escapeAttribute(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)} &#8599;</a>`;
}

function renderHtmlBlock(html) {
  const value = String(html).trim();
  if (/^<(?:figure|div|p|ul|ol|blockquote|pre|table|h[2-6])\b/i.test(value)) {
    return indentHtmlBlock(value);
  }
  return `            <p>\n              ${value}\n            </p>`;
}

function indentHtmlBlock(html) {
  return html.split('\n').map((line) => `            ${line}`).join('\n');
}

function postId(post) {
  return `post-${post.date}-${post.slug}`;
}

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

main();
