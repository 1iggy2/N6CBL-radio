# N6CBL.radio blog workflow

The blog is a single static page at `/blog/index.html`. It is intentionally a long
running list, matching the QSO-log pattern: newest entry first, dense index table
at the top, full post text below.

## Fast path: GitHub web UI

1. Open `/blog/compose/` on the live site or from a local checkout.
2. Fill out the fields and select any images you plan to publish.
3. Copy the generated index row and article block.
4. In GitHub, upload optimized images to:

   ```text
   /images/blog/YYYY-MM-DD-slug/
   ```

5. In GitHub, edit `/blog/index.html`:
   - paste the new table row at the top of the `Post index` table body;
   - paste the new `<article>` block below the `NEW POST INSERTION POINT` comment;
   - keep newest posts first;
   - update the post count in the `/blog/ — field journal` metadata line.
6. Commit directly with an imperative message, for example:

   ```text
   Add Crystal Cove field report
   ```

## Photo rules

- Prefer WebP. JPEG is acceptable for camera originals that have already been
  resized and compressed.
- Store images under `/images/blog/YYYY-MM-DD-slug/` so every post owns its
  assets.
- Every image needs a caption and useful `alt` text. Treat images as data:
  what, where, when, and why the reader should care.
- Avoid uploading full-resolution phone originals unless the large file is the
  point of the post.

## Post structure

Each post requires two pieces:

1. A table row in the index: date, reference, context, `Read →` link.
2. An `<article class="blog-post">` block with a stable `id` matching that link.

The browser composer generates both snippets. The site has no required build step;
Cloudflare serves the committed files.

## Publish checklist

- [ ] Date is `YYYY-MM-DD`.
- [ ] New index row is newest-first.
- [ ] New article block is newest-first.
- [ ] Image paths resolve under `/images/blog/YYYY-MM-DD-slug/`.
- [ ] Images have captions and `alt` text.
- [ ] `/blog/index.html` still has a viewport meta tag.
- [ ] The page has no decorative card grid or thumbnail-only navigation.
