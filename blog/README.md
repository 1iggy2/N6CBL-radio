# N6CBL.radio blog workflow

The blog publishes as static HTML at `/blog/index.html`, but the source of truth is
now structured JSON under `/content/blog/`. The generated page keeps the dense QSO-log
pattern: newest entry first, dense index table at the top, full post text below.

## Normal path: owner web publisher

1. Open `/blog/compose/` after passing the Cloudflare Access policy for the owner
   email address.
2. Fill out the text fields. V1 auto-publishing is text-only; the photo controls are
   retained as staging/preview for the next image-upload iteration.
3. Click `Submit post to GitHub`.
4. The Cloudflare Worker validates the Access email and commits a new file at:

   ```text
   /content/blog/YYYY-MM-DD-slug.json
   ```

5. The `Build blog` GitHub Action runs `node scripts/build-blog.js`, regenerates the
   static blog/home HTML, and commits the generated output.
6. Cloudflare deploys the committed static files.

## Local/manual fallback

If the Worker or GitHub API is unavailable, create a JSON file in `/content/blog/`
with this shape, then run `node scripts/build-blog.js` and commit the source plus
generated HTML:

```json
{
  "date": "2026-05-10",
  "title": "Crystal Cove quick activation",
  "slug": "crystal-cove-quick-activation",
  "type": "FIELD REPORT",
  "tags": ["POTA", "KX2", "antenna"],
  "context": "Short description shown in the dense table.",
  "body": [
    "Paragraph one.",
    "Paragraph two."
  ],
  "photos": []
}
```

`bodyHtml` is supported for existing trusted posts that need inline links or code.
New web-submitted posts should use plain `body` paragraphs.

## Photo rules

- V1 web submit is text-only. Do not submit photos through the Worker until image
  upload support is added.
- The post schema keeps a `photos` array so V2 can publish images without changing
  the content model.
- Prefer WebP. JPEG is acceptable for camera originals that have already been
  resized and compressed.
- Store committed images under `/images/blog/YYYY-MM-DD-slug/` so every post owns
  its assets.
- Every image needs a caption and useful `alt` text. Treat images as data: what,
  where, when, and why the reader should care.

## Post structure

Each post source file generates two pieces:

1. A table row in the index: date, reference, context, `Read →` link.
2. An `<article class="blog-post">` block with a stable `id` matching that link.

The published pages remain static HTML; Cloudflare serves the committed output.

## Publish checklist

- [ ] `/blog/compose/` and `/api/blog/publish` are protected by Cloudflare Access.
- [ ] Worker secrets are configured: `ALLOWED_EMAIL`, `GITHUB_TOKEN`, and
      `GITHUB_REPO`.
- [ ] Date is `YYYY-MM-DD`.
- [ ] Slug is lowercase hyphenated text.
- [ ] New JSON source file is committed under `/content/blog/`.
- [ ] `node scripts/build-blog.js` regenerates `/blog/index.html` and the home-page
      latest field note.
- [ ] Images, when reintroduced, resolve under `/images/blog/YYYY-MM-DD-slug/` and
      include captions plus `alt` text.
- [ ] `/blog/index.html` still has a viewport meta tag.
- [ ] The page has no decorative card grid or thumbnail-only navigation.
