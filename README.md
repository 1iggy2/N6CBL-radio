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

## QRZ Logbook refresh

The public QSO log is generated from QRZ Logbook rather than committed ADIF
uploads. A scheduled GitHub Actions workflow runs every 15 minutes, downloads the
logbook as ADIF into an ignored working file, enriches callsigns with QRZ XML
subscriber data, regenerates `data/qso-log.json`, and commits only the public-safe
JSON/cache output when something changed.

### Owner setup

1. In QRZ Logbook, create/copy the API access key for the N6CBL logbook.
2. In GitHub repository settings, add these **Actions secrets**:
   - `QRZ_LOGBOOK_KEY` — QRZ Logbook API key used for ADIF `FETCH`.
   - `QRZ_USERNAME` — QRZ login username or callsign for XML callsign lookups.
   - `QRZ_PASSWORD` — QRZ login password for XML callsign lookups.
3. Do not put QRZ credentials or raw fetched ADIF in `wrangler.jsonc`, browser
   JavaScript, HTML, committed JSON, or shell snippets that may be copied into the
   repo.
4. The **Refresh QRZ log and deploy** workflow runs on `main` pushes, on manual
   dispatch, and on a `*/15 * * * *` schedule. GitHub may delay scheduled jobs, so
   15 minutes is the target cadence rather than a hard realtime SLA.
5. The site serves the last committed `data/qso-log.json` if QRZ or GitHub Actions
   is temporarily unavailable.

### Local owner use

For a local refresh, export credentials only in the current shell, fetch the QRZ
Logbook ADIF into the ignored cache directory, then regenerate the public log data:

```sh
export QRZ_LOGBOOK_KEY='your-qrz-logbook-api-key'
export QRZ_USERNAME='N6CBL'
export QRZ_PASSWORD='your-qrz-password'
python3 scripts/fetch-qrz-logbook.py
QSO_LOG_ADIF_PATH=.cache/qrz-logbook.adi python3 scripts/enrich-qrz.py
QSO_LOG_ADIF_PATH=.cache/qrz-logbook.adi QSO_LOG_SESSIONIZE=1 python3 scripts/process-logs.py
```

Optional environment controls:

| Variable | Default | Purpose |
|---|---:|---|
| `QRZ_LOGBOOK_ADIF_PATH` | `.cache/qrz-logbook.adi` | Ignored working-file path for fetched ADIF. |
| `QRZ_LOGBOOK_FETCH_OPTION` | `ALL` | QRZ Logbook `FETCH` option, such as `ALL` or `MODSINCE:YYYY-MM-DD`. |
| `QRZ_CACHE_MAX_AGE_DAYS` | `90` | Refresh cached calls older than this many days. |
| `QRZ_LOOKUP_LIMIT` | `250` | Maximum QRZ XML callsign lookups per run. |
| `QRZ_LOOKUP_SLEEP_SECONDS` | `0.2` | Delay between QRZ XML lookup requests. |

### Public cache policy

`data/qrz-callsign-cache.json` is intended to contain only public-safe presentation
fields. The enrichment script intentionally avoids publishing street addresses,
email addresses, ZIP codes, and other personal fields that are not needed for the
public log.
