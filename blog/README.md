# N6CBL.radio blog workflow

The blog publishes as static HTML at `/blog/index.html`, but the source of truth is
now structured JSON under `/content/blog/`. The generated page keeps the dense QSO-log
pattern: newest entry first, dense index table at the top, full post text below.

## Normal path: owner web publisher

1. Open `/blog/compose/` after passing the Cloudflare Access policy for the owner
   email address. The Worker now trusts that Access policy by default, so
   `ALLOWED_EMAIL` is optional instead of required for the owner-only route.
2. Fill out the text fields and select any post images. Captions are one per line,
   or `filename | caption` when you want to bind text to a specific file.
3. Click `Submit post to GitHub`.
4. The Cloudflare Worker validates the Access email and commits a new file at:

   ```text
   /content/blog/YYYY-MM-DD-slug.json
   /images/blog/YYYY-MM-DD-slug/*
   ```

5. The `Build blog` GitHub Action runs `node scripts/build-blog.js`, regenerates the
   static blog/home HTML, and commits the generated output.
6. Cloudflare deploys the committed static files.

## One-time repository / Cloudflare setup

The browser publisher only works after the repository, Cloudflare Worker,
Cloudflare Access policy, and GitHub token are wired together. Do this once per
Cloudflare account or whenever the repository/token changes.

### 1. Protect the publisher routes with Cloudflare Access

Create a Cloudflare Access application/policy that protects both paths:

```text
/blog/compose/*
/api/blog/publish
```

Allow only the owner email address that should be able to publish. The Worker reads
the Access-authenticated email from the request headers and refuses requests with
no Access identity.

### 2. Confirm Worker vars in the repo

`wrangler.jsonc` should contain the non-secret target repository binding:

```json
"vars": {
  "GITHUB_REPO": "1iggy2/N6CBL-radio"
}
```

If the repository moves or is forked, update that value. `GITHUB_BRANCH` is
optional; the Worker defaults to `main`.

### 3. Add Worker secrets in Cloudflare

Create a GitHub token that can write repository contents for this repo, then store
it as a Worker secret. Do not commit the token to the repository.

```sh
npx wrangler secret put GITHUB_TOKEN
```

Optional: add a second Worker-side email allow-list. This is useful if the
Cloudflare Access policy is broader than the single publishing identity.

```sh
npx wrangler secret put ALLOWED_EMAILS
```

Use a comma-separated value such as `owner@example.com,backup@example.com`. The
legacy one-address name `ALLOWED_EMAIL` is still accepted.

### 4. Keep GitHub Actions deploy secrets set

The deploy workflow also needs repository-level GitHub Actions secrets so pushes to
`main` can deploy through Wrangler:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

These are separate from Worker secrets. GitHub Actions secrets let the workflow
deploy. Worker secrets let the deployed Worker commit blog source back to GitHub.

### 5. Expected failure messages

| Message | Meaning | Fix |
|---|---|---|
| `Cloudflare Access identity is required` | The request did not arrive through the protected Access route. | Protect `/blog/compose/*` and `/api/blog/publish`, then reopen the compose page through Access. |
| `Cloudflare Access identity is not authorized` | Access authenticated an email outside the optional Worker allow-list. | Update `ALLOWED_EMAILS` / `ALLOWED_EMAIL`, or remove the extra allow-list if Access is already narrow. |
| `GITHUB_TOKEN and GITHUB_REPO are required` | The Worker is missing the GitHub token secret or repo var. | Run `npx wrangler secret put GITHUB_TOKEN`; confirm `GITHUB_REPO` in `wrangler.jsonc`; redeploy. |
| `GitHub commit failed` | GitHub rejected the API write. | Confirm the token has contents write permission and can access this repository. |

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

- The web publisher submits image files through the Worker with the structured post
  source in a single Git commit.
- Keep each image under 3 MB and the combined image upload under 10 MB. This is an
  owner-publisher convenience, not a bulk media ingestion system.
- JPEG, PNG, WebP, and GIF are accepted. Prefer WebP. JPEG is acceptable for camera
  originals that have already been resized and compressed.
- Store committed images under `/images/blog/YYYY-MM-DD-slug/` so every post owns
  its assets. The browser publisher does this path construction automatically.
- Every image needs a caption and useful `alt` text. Treat images as data: what,
  where, when, and why the reader should care. The caption is reused as alt text
  unless the source JSON is edited manually afterward.
- Multiple images render side-by-side on wider screens and stack at mobile width.

## Post structure

Each post source file generates two pieces:

1. A table row in the index: date, reference, context, `Read →` link.
2. An `<article class="blog-post">` block with a stable `id` matching that link.

The published pages remain static HTML; Cloudflare serves the committed output.

## Publish checklist

- [ ] `/blog/compose/` and `/api/blog/publish` are protected by Cloudflare Access.
- [ ] Worker authentication is configured: Cloudflare Access protects the compose
      page/API route, optional `ALLOWED_EMAIL` or comma-separated `ALLOWED_EMAILS`
      narrows the Access identities, `GITHUB_REPO` is set in `wrangler.jsonc`,
      and the required `GITHUB_TOKEN` secret is configured.
- [ ] Date is `YYYY-MM-DD`.
- [ ] Slug is lowercase hyphenated text.
- [ ] New JSON source file is committed under `/content/blog/`.
- [ ] `node scripts/build-blog.js` regenerates `/blog/index.html` and the home-page
      latest field note.
- [ ] Images resolve under `/images/blog/YYYY-MM-DD-slug/`, stay within upload
      limits, and include captions plus `alt` text.
- [ ] `/blog/index.html` still has a viewport meta tag.
- [ ] The page has no decorative card grid or thumbnail-only navigation.
