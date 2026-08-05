# N6CBL.radio

Personal website of N6CBL. Live at [N6CBL.radio](https://N6CBL.radio).

Tools, blog posts, 3D prints, amateur radio resources, and whatever else.

## Hosting

Cloudflare Pages — deploys automatically from the `main` branch of this repo.

## Design

Follows the US Graphics Company design philosophy: dense, explicit, performant,
timeless. See [CLAUDE.md](./CLAUDE.md) for the full doctrine.

## Structure

In navigator order — the sidebar is ordered by operational importance, not
alphabetically.

| Path | Content |
|---|---|
| `/` | Home / current splash |
| `/log/` | QSO log and contact records |
| `/log/stats/` | QSO analysis and statistics |
| `/blog/` | Posts |
| `/station/` | My station: operator profile, hardware reviews, gear, modes |
| `/qsl/` | QSL card: front artwork, card specification, confirmation routes, QSL reach of worked stations |
| `/propagation/` | Live propagation dashboard: NOAA SWPC indices, per-band reach, local weather |
| `/tools/` | Workbench index |
| `/tools/ham/` | Amateur radio utilities (17 tools) |
| `/tools/uav/` | Fixed-wing UAV design lab |
| `/design/` | Design language: principles, type, color, layout patterns, prohibitions |

A 3D print catalog is still planned; it gets a navigator row when the page ships.

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

Every published QSO is one ADIF record from that fetch — there is no second
source of contacts and no hand-entered row. QSO fields are taken from the record
as QRZ exported it; only when a record omits a field (name, grid, state, county,
DXCC, zones) does the worked station's cached QRZ profile fill the gap.

Confirmation status is read per contact from the export: `APP_QRZLOG_STATUS=C`
for QRZ's own confirmation, plus `LOTW_QSL_RCVD`, `EQSL_QSL_RCVD`, and
`QSL_RCVD` for the other routes. The fetch separately asks QRZ for the book
status (`.cache/qrz-logbook-status.json`), whose confirmed count is kept as an
independent check on the per-contact count — two systems counting the same thing.
The pages report the disagreement if the two ever diverge.

`QRZCOM_QSO_DOWNLOAD_STATUS` is deliberately not read. It looks like a
confirmation flag and is not one: it is `Y` on every record, recording that the
QSO came from QRZ, and honouring it marked all 163 QSOs confirmed against QRZ's
own count of 99. Every run now prints a value histogram of each
confirmation-shaped ADIF field and flags any field that is uniform across the
export, so the next lookalike shows up in the workflow log rather than on the
site.

Nothing is ever inferred from the other station's QRZ profile: a station that
uses LoTW has not thereby confirmed the contact.

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
| `QRZ_LOGBOOK_STATUS_PATH` | `.cache/qrz-logbook-status.json` | Ignored working-file path for QRZ book totals, including the confirmed count. |
| `QRZ_LOGBOOK_FETCH_OPTION` | `ALL` | QRZ Logbook `FETCH` option. The default asks QRZ for the entire book in one export; use options such as `TYPE:ADIF,MAX:250,AFTERLOGID:0` only when a logbook is large enough to need QRZ logid paging. |
| `QRZ_CACHE_MAX_AGE_DAYS` | `90` | Refresh cached calls older than this many days. |
| `QRZ_LOOKUP_LIMIT` | `250` | Maximum QRZ XML callsign lookups per run. |
| `QRZ_LOOKUP_SLEEP_SECONDS` | `0.2` | Delay between QRZ XML lookup requests. |

### Public cache policy

`data/qrz-callsign-cache.json` is intended to contain only public-safe presentation
fields. The enrichment script intentionally avoids publishing street addresses,
email addresses, ZIP codes, and other personal fields that are not needed for the
public log.
