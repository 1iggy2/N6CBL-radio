# N6CBL.radio

Personal website of N6CBL. Live at [N6CBL.radio](https://N6CBL.radio).

Tools, blog posts, 3D prints, amateur radio resources, and whatever else.

## Hosting

Cloudflare Pages — deploys automatically from the `main` branch of this repo.

## Design

Follows the US Graphics Company design philosophy: dense, explicit, performant,
timeless. See [CLAUDE.md](./CLAUDE.md) for the full doctrine.

## Structure

| Path | Content |
|---|---|
| `/` | Home / current splash |
| `/roadmap/` | Site planning ledger, project priorities, and idea voting |
| `/log/` | QSO log and contact records |
| `/log/stats/` | QSO analysis and statistics |
| `/station/` | My station: operator profile, gear, hardware notes, modes |
| `/blog/` | Posts |
| `/tools/` | Browser utilities |
| `/prints/` | 3D print catalog |

## Development

No build step required for static pages. Just edit HTML/CSS and push.

```sh
git clone https://github.com/1iggy2/n6cbl-radio
cd n6cbl-radio
# open index.html in a browser
```

## License

Content: All rights reserved, N6CBL.  
Code/templates: MIT unless otherwise noted in the file.

## QRZ XML callsign enrichment

The public QSO log can enrich uploaded ADIF records with QRZ XML subscriber data.
This is a read-only integration: it looks up callsigns, stores a public-safe cache,
and merges missing name, grid, state, country, DXCC, zone, and QSL capability fields
into `data/qso-log.json` during the normal deploy workflow.

### Owner setup

1. Confirm the QRZ account for N6CBL has an active XML data subscription.
2. In GitHub, open the repository settings and add these **Actions secrets**:
   - `QRZ_USERNAME` — the QRZ login username or callsign for the subscribed account.
   - `QRZ_PASSWORD` — the QRZ login password.
3. Do not put QRZ credentials in `wrangler.jsonc`, browser JavaScript, HTML, committed
   JSON, or local shell history snippets that may be copied into the repo.
4. Push to `main` or run the **Process logs and deploy** workflow manually. The workflow
   runs `python3 scripts/enrich-qrz.py` before `python3 scripts/process-logs.py`.
5. If the secrets are absent, the enrich step prints a skip message and leaves the
   cache unchanged, so deployments still work without QRZ access.

### Local owner use

For a local refresh, export credentials only in the current shell, run the enrichment
script, then regenerate the public log data:

```sh
export QRZ_USERNAME='N6CBL'
export QRZ_PASSWORD='your-qrz-password'
python3 scripts/enrich-qrz.py
python3 scripts/process-logs.py
```

Optional environment controls:

| Variable | Default | Purpose |
|---|---:|---|
| `QRZ_CACHE_MAX_AGE_DAYS` | `90` | Refresh cached calls older than this many days. |
| `QRZ_LOOKUP_LIMIT` | `250` | Maximum QRZ callsign lookups per run. |
| `QRZ_LOOKUP_SLEEP_SECONDS` | `0.2` | Delay between QRZ lookup requests. |

### Public cache policy

`data/qrz-callsign-cache.json` is intended to contain only public-safe presentation
fields. The enrichment script intentionally avoids publishing street addresses, email
addresses, ZIP codes, and other personal fields that are not needed for the public log.
