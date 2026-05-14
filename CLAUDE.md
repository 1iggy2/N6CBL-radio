# N6CBL.radio — CLAUDE.md

## Project Overview

Personal website for N6CBL, hosted at `N6CBL.radio`. Content will include tools,
blog posts, 3D print files, amateur radio resources, and whatever else suits the
operator's fancy. Static site, Cloudflare-hosted, targeting this repo as the
deployment source.

## Design Philosophy

This site follows the **US Graphics Company** design doctrine. Every UI decision
must be defensible against these principles:

| Principle | Implication |
|---|---|
| Emergent over prescribed aesthetics | Don't decorate. Let structure create beauty. |
| Expose state and inner workings | Show metadata, timestamps, counts, status. Don't hide the machine. |
| Dense, not sparse | Whitespace is earned, not default. Fill space with information. |
| Explicit is better than implicit | Label everything. Don't make users guess. |
| Engineered for human vision and perception | Use contrast, alignment, and typographic hierarchy intentionally. |
| Regiment functionalism | Every element has a job. No decorative elements without function. |
| Performance *is* design | Fast load = good design. Heavy frameworks are a design failure. |
| Verbosity over opacity | More words > ambiguous icons. Explain the thing. |
| Ignore design trends | No glassmorphism, no parallax, no trendy typefaces. Timeless. |
| Flat, not hierarchical | Navigation should be shallow. No mega-menus, no deep nesting. |
| Complex as it needs to be | Don't simplify for simplicity's sake. Add complexity when it serves the user. |
| Driven by objective reasoning | Design choices need rationale, not vibes. |
| Don't infantilize users | Trust users to read, to scroll, to handle information. |

### Aesthetic Execution

- **Typography**: Engineered, not decorative. Three roles:
  - **Data/UI/labels**: `"Consolas", "Menlo", "Monaco", "Courier New", monospace` — Consolas and Menlo are clean geometric monospaces; Courier New is a last resort only (too slab-serif at display sizes).
  - **Body/prose**: `system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif`
  - **Display/headings**: `"DIN Alternate", "Arial Narrow", "Helvetica Neue", Helvetica, Arial, sans-serif` — DIN Alternate ships on all Apple devices and is essentially free D-Din. Aspirational paid upgrades: D-Din (type.today) or Los Alamos Mono (US Graphics Company). Do not use Courier New at display sizes — it reads as slab-serif and lacks precision.
  - Never use: Comic Sans, Papyrus, rounded typefaces, anything that reads as casual or decorative.
- **Color**: High contrast. Black on white baseline. Single functional accent color.
- **Layout**: Grid-based, dense, full-width. No centered hero sections with padding.
- **Borders/Rules**: Use lines to organize. No shadows, no gradients, no border-radius.
- **Interactivity**: Only where it serves information retrieval. No animations for atmosphere.
- **Images**: When used, treated as data — captioned, dated, sourced.

### Layout Patterns

**Two-panel layout (canonical page structure)**
All content pages use a permanent left sidebar (220px fixed) + scrollable main content
(1fr). The sidebar is sticky to the viewport. Never collapse it behind a toggle. The
structure is always visible — it *is* the design.

Reference: Racket language documentation guide.

**Permanent sidebar navigation**
The nav tree is always fully expanded. No accordion sections, no hover-reveal, no
`+` expand buttons. Users see the full site structure at all times. Below the nav
tree, the sidebar carries operator metadata, external profiles, and station info.
The sidebar is a persistent operational panel — not a temporary menu.

Key rules:
- Active page indicated by background highlight and/or bold weight
- Implemented routes appear as plain path text; unimplemented routes stay visible in the navigator with muted text until they ship. Do not add separate LIVE, WIP, or PLANNED badges to the sidebar navigation.
- Every public routable internal page appears as its own top-level row in the
  visible navigation list. Do not hide public subpages only inside parent-page body
  links.
- Owner-only operational routes, such as `/blog/compose/`, may be omitted from the
  public navigator when protected by Cloudflare Access and used only as publishing
  controls rather than public site content.
- Keep this exposure flat: subpages remain peer rows in the always-visible
  navigator. For subpage labels, use `↳` (`&#x21B3;`) plus the leaf route (for
  example `↳ compose/`) to indicate path hierarchy without repeating the parent
  path; do not use nested lists, indentation-only hierarchy, or expandable child
  controls.
- Links use `font-family: var(--mono)` for paths, muted for descriptions
- External links end with ↗, internal links have no icon
- Every implemented or planned public site route must be exposed in the permanent
  sidebar navigator. "Flat, not hierarchical" means a shallow visible list, not
  hidden secondary pages, footer-only links, hover menus, accordions, or
  mega-menus.
- When a route is moved or consolidated, update the navigator and site plan so the
  visible list points at the durable destination; do not leave orphaned pages
  discoverable only by URL.

**Reference / inventory pages**
Operational reference pages such as `/station/` should lead with labeled data blocks
and dense tables, not a billboard-style narrative summary. If the section label and
table headers already identify the page purpose, do not add a standalone hero, lede,
or prose explainer above the first data table. Put explanatory copy in table notes,
section labels, captions, or row descriptions where it directly supports a specific
fact. The data is the page.

**Table-of-text content indexes**
Content archives (blog posts, POTA activations, print files) are presented as dense
text tables: Date | Reference | Context | CTA. Every row has an explicit action link.
No card grids. No thumbnails as primary navigation. No hover-reveal summaries. The
table is the page.

Reference: USGC notes archive (Date / Title / "Read →" pattern).

Key rules:
- Dates in `YYYY-MM-DD` monospace, leftmost column
- References/titles in bold monospace or bold sans
- Descriptive text in muted sans-serif
- CTA as rightmost column: "Read →", "View →", "Download →"
- Empty state is an explicit message, not a hidden table

**CTA conventions**
Action links are inline text with an arrow: `Read →`, `View →`, `Download →`,
`Full profile →`. Never icon-only. Never a styled button with padding. The label
tells the user exactly what happens. CTAs live at the end of each row in a table,
or at the end of a section as a footer link.

### Anti-patterns (never do these)

- Centered hero with big tagline and whitespace
- Cards with drop shadows and rounded corners
- Hamburger menus hiding content
- "Loading..." skeletons for content that could be server-rendered
- Hover-only information
- Auto-playing anything
- Cookie banners for a site with no cookies

## Technical Stack

**Constraint**: Keep it simple. Performance is design.

- Static HTML/CSS as the baseline
- No CSS framework (write real CSS)
- JavaScript only when it adds information value, not atmosphere
- No build step required for basic pages
- Cloudflare Pages for hosting (auto-deploys from this repo)
- Blog output is generated from structured post source because browser submission
  must not require hand-editing HTML or manually updating duplicate metadata.

The blog build step is intentionally narrow: `scripts/build-blog.js` reads
`/content/blog/*.json` and regenerates the static blog/home HTML that Cloudflare
serves. Do not add runtime Markdown rendering or a client-side CMS for core posts.

## Site Structure (planned)

```
/                  — splash / home, world map, station overview
/roadmap/          — site planning ledger: route inventory, project backlog, idea voting
/log/              — QSO log: primary source of contact/session records
/log/stats/        — analysis of the QSO log: maps, counts, WAS, bands, modes
/station/          — my station: operator profile, gear, hardware notes, modes, CW progress
/blog/             — posts: technical, radio, misc
/tools/            — browser-based utilities
/prints/           — 3D print catalog with files
```

## File Layout

```
/index.html              — home page
/roadmap/index.html      — roadmap and idea planning ledger
/log/index.html          — QSO log
/log/stats/index.html    — QSO log analysis and stats
/station/index.html      — station reference and inventory
/blog/index.html         — generated field journal running list
/blog/compose/index.html — owner-only browser publisher for structured blog source
/content/blog/           — structured blog post JSON source
/scripts/build-blog.js   — static blog/home generator
/scripts/fetch-qrz-logbook.py — QRZ Logbook ADIF fetcher for scheduled QSO refresh
/scripts/process-logs.py — derived public QSO log generator
/styles.css              — single shared stylesheet for all pages
/flag-us.svg             — header US flag
/images/                 — page imagery (field photos, world map)
/images/blog/            — committed blog photos, grouped by post slug
/data/                   — committed derived data (QRZ/POTA cron output)
/worker.js               — Cloudflare Worker with assets passthrough and blog publisher
/wrangler.jsonc          — Workers deploy config
/.github/workflows/      — QRZ/POTA cron and deploy automation
```

CSS lives in a single shared stylesheet (`/styles.css`). Most pages are
hand-written HTML files that link it. Blog posts are the exception: structured JSON
source is committed under `/content/blog/`, then `scripts/build-blog.js` regenerates
static HTML so publishing does not require HTML surgery.

## Development Guidelines

- HTML must validate. Run `tidy -errors -quiet -utf8` to check.
- CSS should work without JavaScript. Progressive enhancement only.
- Every page must have a `<title>`, `<meta description>`, and correct `lang`.
- No external font loading. System font stacks only.
- Images: compress before committing. Use WebP where possible.
- No `!important` in CSS without a comment explaining why.
- Commit messages: imperative mood, present tense, specific.

### Repository workflow

Agents should always push directly to `main` without opening a pull request.

### Mobile width discipline

Any CSS or HTML change that touches layout, tables, or flex/grid containers **must**
be checked for mobile viewport overflow. The canonical failure mode: a wide table or
fixed-width element forces `body` wider than the viewport, causing the page to zoom
out on iOS/Android.

Rules:
- Tables must never have a fixed total width that exceeds the viewport. Prefer
  `table-layout: fixed` with `overflow-x: auto` on a wrapping `div`, or drop columns
  on narrow viewports via `@media`.
- No table column whose content is purely decorative or navigational (e.g., a "View →"
  CTA that duplicates a section-footer link) — these are the first candidates to cut
  when a table is too wide for mobile.
- After any table or layout change, mentally check: what happens at 390px (iPhone 15)?
  Does any element create horizontal scroll? If yes, fix before committing.
- The `<meta name="viewport" content="width=device-width, initial-scale=1.0">` tag is
  required on every page. Never omit or alter it.

## Callsign Context

N6CBL is an FCC-licensed amateur radio operator. The site may include:
- APRS/telemetry data integrations
- Logbook exports
- SDR-related tools
- Band condition displays

These should feel native to the site's aesthetic, not bolted on.
