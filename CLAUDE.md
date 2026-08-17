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
The shared page chrome is generated. `/content/nav.json` is the single source of
truth for three blocks, and `node scripts/build-chrome.js` rewrites all three in
every page from it:

- `<ul class="nav-tree">` — the route list
- `<dl class="sidenav-dl">` — the "My Station" facts
- `<footer>` — the site footer

Never hand-edit those blocks; the copies drift, and every one of them already
had. The navigator was missing three routes on one page. The station facts had
split into two variants (`Chameleon SS-17` / `SSB · 20m` on eight pages,
`CHA SS17` / `SSB · FT8 · CW study` on twenty). The footer had split along the
same seam, down to two different inline SVGs, and `/blog/` and `/blog/compose/`
had no footer at all. To change a route, a station fact, or the footer: edit
`nav.json`, run the script, commit the result. The rest of the sidebar (profiles,
operator card) stays hand-written.

The nav tree is always fully expanded. No accordion sections, no hover-reveal, no
`+` expand buttons. Users see the full site structure at all times. Below the nav
tree, the sidebar carries operator metadata, external profiles, and station info.
The sidebar is a persistent operational panel — not a temporary menu.

Key rules:
- Active page indicated by background highlight and/or bold weight
- Implemented routes appear as plain path text; unimplemented routes stay visible in the navigator with muted text until they ship. Do not add separate LIVE, WIP, or PLANNED badges to the sidebar navigation.
- Every public routable internal page appears as its own top-level row in the
  visible navigation list. Do not hide public subpages only inside parent-page body
  links. Exception: individual utilities inside a workbench (`/tools/ham/grid/`,
  `/tools/ham/swr/`, …) are indexed from their workbench page, not the navigator —
  the navigator lists one row per workbench (`↳ ham/`, `↳ night-desk/`, `↳ uav/`) so the visible
  list stays readable as the tool inventory grows.
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

### Sanctioned exception: /tools/uav/x/

`/tools/uav/x/` is a deliberate experiment that opts out of this design doctrine:
a modern, dark, app-like interface (tabs, cards, border-radius, accent gradients)
over the same engine as `/tools/uav/`. It loads the shared `/tools/uav/uav.js`
unchanged and provides the same element IDs in a different shell, so the two
pages stay functionally identical by construction. Do not "fix" its styling to
match the site doctrine, and do not let its aesthetic leak into the rest of the
site. It appears in the navigator as `↳ uav/x/` and is also linked from the
classic UAV page.

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

### Log fidelity

The published QSO log mirrors QRZ Logbook one-to-one. Every row is one ADIF
record from the scheduled fetch; there is no second source of contacts, no
hand-entered QSO, and no derived or estimated row. Do not add one — if a contact
should appear on the site, it belongs in QRZ first.

Two data sources meet in `data/qso-log.json` and must not be conflated:

- **The QSO**, from the logbook export. Confirmations live here
  (`APP_QRZLOG_STATUS=C` for QRZ's own, plus `LOTW_QSL_RCVD`, `EQSL_QSL_RCVD`,
  `QSL_RCVD`), and are the only thing the site may call confirmed. The book-wide
  count from the separate `ACTION=STATUS` call is kept as an independent check on
  them, not as a second answer.
- **The worked station's QRZ profile**, from the XML callsign lookup. It fills
  gaps in a record's name/grid/state/county/DXCC/zone fields and carries the
  `lotw`/`eqsl`/`mqsl` flags, which say what routes that operator *accepts*.

A station that has LoTW is not a contact that is confirmed. Label profile-derived
figures as reach, never as confirmations, and never present a lookup-coverage
count ("QRZ enriched") as though it were an operating statistic.

Before trusting an ADIF field that sounds like confirmation, check its
distribution. `QRZCOM_QSO_DOWNLOAD_STATUS` shipped as one; it is `Y` on every
record — it records that the QSO came from QRZ — and it marked all 163 QSOs
confirmed while QRZ's own book status said 99. A field carrying one value across
the whole export distinguishes nothing, whatever its name promises. Every run
prints a value histogram of each confirmation-shaped field and flags the uniform
ones; read it rather than assuming from the field name. When a figure cannot be
sourced, drop it from the page — do not print a dash where a statistic was
promised.

Cross-check derived counts against whatever the source system reports
independently. The bad field shipped because nothing compared the site's number
to QRZ's own; the `ACTION=STATUS` total now does, and a disagreement is printed
on the page rather than resolved silently.

## Site Structure

Listed in navigator order. The navigator is ordered by operational importance —
the log first, then the writing about it, then the station behind it, then the
tooling — not alphabetically and not by build date. `content/nav.json` holds the
order; keep this list and that file in the same sequence.

```
/                  — splash / home, world map, station overview
/log/              — QSO log: primary source of contact/session records
/log/stats/        — analysis of the QSO log: maps, counts, WAS, bands, modes
/blog/             — posts: technical, radio, misc
/station/          — my station: operator profile, hardware reviews, gear, modes, CW progress
/qsl/              — QSL card: front artwork, card specification, confirmation routes, QSL reach of worked stations
/propagation/      — pre-activation command station: NOAA SWPC indices, per-band reach, 24 h window, Hermosa Beach weather
/tools/            — workbench index: one route per tool discipline
/tools/ham/        — amateur radio workbench: 17 client-side utilities
/tools/night-desk/ — night-ops console: analog VFO, S-meter, Morse paddle, grayline globe, QRZ log
/tools/uav/        — fixed-wing UAV design lab: parametric sizing, Monte Carlo, 3-view
/design/           — design language of record: principles, type, color, patterns, prohibitions
```

A 3D print catalog at `/prints/` is still wanted, but it is not a planned route
until it has content: it shipped as a muted navigator row for long enough that
the row was only advertising an empty promise. Add it back to `content/nav.json`
— and here — in the same change that publishes the page.

## File Layout

```
/index.html              — home page
/404.html                — HTTP 404 page for unknown paths (Workers assets not_found_handling)
/design/index.html       — design language reference (this doctrine, rendered)
/log/index.html          — QSO log
/log/stats/index.html    — QSO log analysis and stats
/station/index.html      — station reference and inventory
/qsl/index.html          — QSL card reference; card artwork plus log-derived QSL reach
/propagation/index.html  — live propagation dashboard (NOAA SWPC + Open-Meteo, client-fetched)
/blog/index.html         — generated field journal running list
/blog/compose/index.html — owner-only browser publisher for structured blog source
/tools/index.html        — workbench index (ham + night-desk + uav)
/tools/ham/*/index.html  — amateur radio utilities (one directory per tool)
/tools/night-desk/       — night-ops console page + desk.js engine
/tools/uav/index.html    — fixed-wing UAV design lab page
/tools/uav/uav.js        — UAV lab engine: parameter/metric registries, model, views, Monte Carlo
/tools/uav/x/            — experimental UAV lab UI (see sanctioned exception below)
/content/blog/           — structured blog post JSON source
/content/nav.json        — shared chrome source: nav routes, station facts, footer
/scripts/build-blog.js   — static blog/home generator
/scripts/build-chrome.js — regenerates nav, station facts, and footer from nav.json
/scripts/check-widths.js — viewport overflow sweep (needs Playwright)
/scripts/fetch-qrz-logbook.py — QRZ Logbook ADIF fetcher for scheduled QSO refresh
/scripts/process-logs.py — derived public QSO log generator
/styles.css              — single shared stylesheet for all pages
/flag-us.svg             — header US flag
/images/                 — page imagery (field photos, world map)
/images/qsl/             — QSL card artwork
/images/blog/            — committed blog photos, grouped by post slug
/data/                   — committed derived data (QRZ/POTA cron output)
/worker.js               — Cloudflare Worker with assets passthrough and blog publisher
/wrangler.jsonc          — Workers deploy config
/.github/workflows/      — QRZ/POTA cron, deploy automation, and PR checks
/tests/                  — unittest suite for the log-processing scripts
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

### Checks

```
python3 -m unittest discover -s tests   # log-processing unit tests
node scripts/build-chrome.js --check    # page chrome matches content/nav.json
node scripts/build-blog.js              # regenerate blog/home output
node scripts/check-widths.js            # viewport overflow sweep (needs Playwright)
python3 -m http.server 8000             # preview the site at localhost:8000
```

All four run on every push and pull request via `.github/workflows/check.yml`.

### Fix what you find

If you notice a defect while working — a broken layout, a stale document, a wrong
label, dead code, a check nothing runs — fix it in the same pass rather than
reporting it and moving on. The operator is not writing code and should not have
to triage a list of findings back to you. This applies to problems you did not
cause and that nobody asked about.

Two limits. Keep the unrelated fix separable, as its own commit with its own
reasoning, so it can be reverted without touching the requested work. And say
plainly in your summary what you fixed beyond what was asked, including anything
you decided to leave alone and why — silently expanding scope is its own defect.

### Repository workflow

Get finished work onto `main` yourself. Do not park it on a branch, and do not
wait to be asked — the operator should never have to request a pull request, or a
merge, or anything else to make finished work land.

Push straight to `main`. That is the default and the preference: no PR, no review
gate, no ceremony.

Some sessions are started pinned to a feature branch and may not push to `main`.
That is a routing constraint, not a reason to stop halfway. Push the branch, open
a pull request, wait for checks, and merge it yourself. A pull request is a
mechanism for getting work onto `main`, not a place to leave it. If the branch
already has an open PR, push to that branch so the commits fold into it instead
of opening a second PR for the same work; if its PR is already merged, restart
the branch from the latest `main`, since a merged PR cannot track new work.

Leave a PR open and unmerged only when checks fail and you cannot fix them, or
when the change needs a decision that is genuinely the operator's to make. Say
which, plainly, rather than leaving it sitting there unexplained.

Either way, keep the commit discipline described above: one commit per concern,
with unrelated fixes separable, so a single commit can be reverted without
touching the rest.

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
- After any table or layout change, check the real thing rather than guessing:
  `node scripts/check-widths.js` loads every page across 320/390/430/768/1024/1280/1440
  and fails with the offending element named. "Mentally check at 390px" missed a
  5px overflow on `/station/` and a real one on `/design/`; the sweep found both.
- The sweep checks two failure modes and both run in CI, so any failure is a
  regression you introduced. Do not merge past it.
  - **Overflow**: the page is wider than the viewport.
  - **Crushed column**: the table fits but a prose cell is squeezed to a few
    characters per line. This overflows nothing, so it is invisible to a width
    check — `/design/` shipped a 22px "Job" column that was unreadable on a phone.
- Declare a table's narrow-viewport rules **after** its base rules, not in an
  earlier `@media` block. Same-specificity rules later in the file win, so mobile
  widths written above the base rules are silently dead. That mistake shipped
  three times (`.design-table`, `.position-table`, `.top-contact-table`).
- The fix for a wide data table is a `<div class="table-scroll">` wrapper, which
  scrolls the table inside its own box instead of widening the page. Dense
  reference tables should keep all their columns and scroll; dropping columns is
  for cases where a column is genuinely redundant on a phone.
- The `<meta name="viewport" content="width=device-width, initial-scale=1.0">` tag is
  required on every page. Never omit or alter it.

## Callsign Context

N6CBL is an FCC-licensed amateur radio operator. The site may include:
- APRS/telemetry data integrations
- Logbook exports
- SDR-related tools
- Band condition displays

These should feel native to the site's aesthetic, not bolted on.
