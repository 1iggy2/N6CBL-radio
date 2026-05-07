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

- **Typography**: System monospace for data/code/meta, system serif or tight sans for body
- **Color**: High contrast. Black on white baseline. Single functional accent color.
- **Layout**: Grid-based, dense, full-width. No centered hero sections with padding.
- **Borders/Rules**: Use lines to organize. No shadows, no gradients, no border-radius.
- **Interactivity**: Only where it serves information retrieval. No animations for atmosphere.
- **Images**: When used, treated as data — captioned, dated, sourced.

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

When a build system becomes necessary (blog, asset pipeline), document the
decision here with rationale before implementing.

## Site Structure (planned)

```
/               — splash / home
/blog/          — posts: technical, radio, misc
/tools/         — browser-based utilities
/prints/        — 3D print catalog with files
/radio/         — ham radio resources, logs, etc.
```

## Development Guidelines

- HTML must validate. Run `tidy -errors -quiet -utf8` to check.
- CSS should work without JavaScript. Progressive enhancement only.
- Every page must have a `<title>`, `<meta description>`, and correct `lang`.
- No external font loading. System font stacks only.
- Images: compress before committing. Use WebP where possible.
- No `!important` in CSS without a comment explaining why.
- Commit messages: imperative mood, present tense, specific.

## Callsign Context

N6CBL is an FCC-licensed amateur radio operator. The site may include:
- APRS/telemetry data integrations
- Logbook exports
- SDR-related tools
- Band condition displays

These should feel native to the site's aesthetic, not bolted on.
