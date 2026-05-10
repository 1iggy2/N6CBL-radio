---
name: Blog post draft
description: Draft a field report or journal entry before committing it to /blog/.
title: "Blog draft: YYYY-MM-DD short title"
labels: [blog]
assignees: []
---

## Date

YYYY-MM-DD

## Title / reference

Short, specific title.

## Context line

One sentence for the `/blog/` index table.

## Type

FIELD REPORT / SITE NOTE / TECH NOTE / PHOTO LOG / OTHER

## Tags

POTA, KX2, antenna, repair, etc.

## Body draft

Write paragraphs here. Keep factual details: location, park reference, gear, band,
weather, what worked, what failed, and what should be remembered next time.

## Photos

Drag images into this issue if drafting in GitHub. Before publishing, commit the
optimized files under:

```text
/images/blog/YYYY-MM-DD-slug/
```

| Filename | Caption / alt text |
|---|---|
| example.webp | What the reader is seeing, where, and when. |

## Publish checklist

- [ ] Generate snippets with `/blog/compose/`.
- [ ] Upload optimized images under `/images/blog/YYYY-MM-DD-slug/`.
- [ ] Paste the generated row into the `/blog/index.html` post index.
- [ ] Paste the generated article under the insertion comment.
- [ ] Update the visible post count.
- [ ] Commit with an imperative message.
