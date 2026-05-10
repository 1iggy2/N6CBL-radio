#!/usr/bin/env python3
"""
Process ADIF files from logs/ into data/qso-log.json.
Runs automatically via GitHub Actions on every push to main.

File convention: logs/YYYY-MM-DD[-description].adi
Park reference and session type are derived from ADIF data, not filename.
"""
import re
import json
from pathlib import Path
from datetime import datetime, timezone


def parse_adif_fields(text):
    fields = {}
    for m in re.finditer(
        r'<([A-Za-z_][A-Za-z0-9_]*)(?::(\d+)(?::[A-Z])?)?>([^<]*)',
        text, re.DOTALL
    ):
        name = m.group(1).upper()
        if name in ('EOH', 'EOR'):
            continue
        fields[name] = m.group(3).strip()
    return fields


def parse_adif_file(path):
    content = Path(path).read_text(encoding='utf-8', errors='replace')
    eoh = re.search(r'<EOH>', content, re.IGNORECASE)
    records_text = content[eoh.end():] if eoh else content
    qsos = []
    for chunk in re.split(r'<EOR>', records_text, flags=re.IGNORECASE):
        chunk = chunk.strip()
        if not chunk:
            continue
        qso = parse_adif_fields(chunk)
        if qso.get('CALL'):
            qsos.append(qso)
    return qsos


def maidenhead_to_latlon(grid):
    grid = grid.upper().strip()
    if len(grid) < 4:
        return None, None
    try:
        lon = (ord(grid[0]) - ord('A')) * 20 - 180
        lat = (ord(grid[1]) - ord('A')) * 10 - 90
        lon += int(grid[2]) * 2
        lat += int(grid[3])
        if len(grid) >= 6:
            lon += (ord(grid[4]) - ord('A')) * 5 / 60
            lat += (ord(grid[5]) - ord('A')) * 2.5 / 60
            lon += 2.5 / 60
            lat += 1.25 / 60
        else:
            lon += 1
            lat += 0.5
        return round(lat, 4), round(lon, 4)
    except (ValueError, IndexError):
        return None, None


def fmt_date(raw):
    raw = raw.strip()
    if len(raw) == 8 and raw.isdigit():
        return f"{raw[:4]}-{raw[4:6]}-{raw[6:]}"
    return raw


def fmt_time(raw):
    raw = raw.strip()
    if len(raw) >= 4:
        return f"{raw[:2]}:{raw[2:4]}"
    return raw


def generate_was_svg(states_worked):
    W, H = 960, 580

    M_X0, M_X1, M_Y0, M_Y1 = 0, 960, 0, 460
    M_LON0, M_LON1, M_LAT0, M_LAT1 = -125.0, -66.0, 24.0, 49.5

    def proj_main(lat, lon):
        x = M_X0 + (lon - M_LON0) / (M_LON1 - M_LON0) * (M_X1 - M_X0)
        y = M_Y0 + (M_LAT1 - lat) / (M_LAT1 - M_LAT0) * (M_Y1 - M_Y0)
        return x, y

    AK_X0, AK_X1, AK_Y0, AK_Y1 = 5, 220, 465, 578
    AK_LON0, AK_LON1, AK_LAT0, AK_LAT1 = -168.0, -130.0, 54.5, 71.5

    def proj_ak(lat, lon):
        x = AK_X0 + (lon - AK_LON0) / (AK_LON1 - AK_LON0) * (AK_X1 - AK_X0)
        y = AK_Y0 + (AK_LAT1 - lat) / (AK_LAT1 - AK_LAT0) * (AK_Y1 - AK_Y0)
        return x, y

    HI_X0, HI_X1, HI_Y0, HI_Y1 = 230, 420, 492, 578
    HI_LON0, HI_LON1, HI_LAT0, HI_LAT1 = -162.0, -154.0, 18.7, 22.5

    def proj_hi(lat, lon):
        x = HI_X0 + (lon - HI_LON0) / (HI_LON1 - HI_LON0) * (HI_X1 - HI_X0)
        y = HI_Y0 + (HI_LAT1 - lat) / (HI_LAT1 - HI_LAT0) * (HI_Y1 - HI_Y0)
        return x, y

    worked_set = set(states_worked)

    STATES = [
        ('AL', 30.1, 35.0, -88.5, -84.9, proj_main),
        ('AR', 33.0, 36.5, -94.6, -89.7, proj_main),
        ('AZ', 31.3, 37.0, -114.8, -109.0, proj_main),
        ('CA', 32.5, 42.0, -124.4, -114.1, proj_main),
        ('CO', 37.0, 41.0, -109.1, -102.0, proj_main),
        ('CT', 40.9, 42.1, -73.7, -71.8, proj_main),
        ('DE', 38.4, 39.8, -75.8, -75.0, proj_main),
        ('FL', 24.4, 31.0, -87.6, -80.0, proj_main),
        ('GA', 30.4, 35.0, -85.6, -80.9, proj_main),
        ('IA', 40.4, 43.5, -96.6, -90.1, proj_main),
        ('ID', 41.9, 49.0, -117.2, -111.0, proj_main),
        ('IL', 36.9, 42.5, -91.5, -87.5, proj_main),
        ('IN', 37.8, 41.8, -88.1, -84.8, proj_main),
        ('KS', 36.9, 40.0, -102.1, -94.6, proj_main),
        ('KY', 36.5, 39.1, -89.6, -81.9, proj_main),
        ('LA', 28.9, 33.0, -94.0, -89.0, proj_main),
        ('MA', 41.2, 42.9, -73.5, -69.9, proj_main),
        ('MD', 37.9, 39.7, -79.5, -75.1, proj_main),
        ('ME', 43.1, 47.5, -71.1, -67.0, proj_main),
        ('MI', 41.7, 48.3, -90.4, -82.4, proj_main),
        ('MN', 43.5, 49.4, -97.2, -89.5, proj_main),
        ('MO', 35.9, 40.6, -95.8, -89.1, proj_main),
        ('MS', 30.2, 35.0, -91.7, -88.1, proj_main),
        ('MT', 44.4, 49.0, -116.0, -104.0, proj_main),
        ('NC', 33.8, 36.6, -84.3, -75.5, proj_main),
        ('ND', 45.9, 49.0, -104.1, -96.6, proj_main),
        ('NE', 40.0, 43.0, -104.1, -95.3, proj_main),
        ('NH', 42.7, 45.3, -72.6, -70.7, proj_main),
        ('NJ', 38.9, 41.4, -75.6, -74.0, proj_main),
        ('NM', 31.3, 37.0, -109.1, -103.0, proj_main),
        ('NV', 35.0, 42.0, -120.0, -114.0, proj_main),
        ('NY', 40.5, 45.0, -79.8, -71.9, proj_main),
        ('OH', 38.4, 42.3, -84.8, -80.5, proj_main),
        ('OK', 33.6, 37.0, -103.0, -94.4, proj_main),
        ('OR', 41.9, 46.2, -124.6, -116.5, proj_main),
        ('PA', 39.7, 42.3, -80.5, -74.7, proj_main),
        ('RI', 41.1, 42.0, -71.9, -71.1, proj_main),
        ('SC', 32.0, 35.2, -83.4, -78.5, proj_main),
        ('SD', 42.5, 45.9, -104.1, -96.4, proj_main),
        ('TN', 34.9, 36.7, -90.3, -81.7, proj_main),
        ('TX', 25.8, 36.5, -106.6, -93.5, proj_main),
        ('UT', 37.0, 42.0, -114.1, -109.0, proj_main),
        ('VA', 36.5, 39.5, -83.7, -75.2, proj_main),
        ('VT', 42.7, 45.0, -73.4, -71.5, proj_main),
        ('WA', 45.5, 49.0, -124.7, -116.9, proj_main),
        ('WI', 42.5, 47.1, -92.9, -86.8, proj_main),
        ('WV', 37.2, 40.6, -82.6, -77.7, proj_main),
        ('WY', 41.0, 45.0, -111.1, -104.1, proj_main),
        ('AK', 54.6, 71.4, -168.0, -130.0, proj_ak),
        ('HI', 18.9, 22.2, -160.2, -154.8, proj_hi),
    ]

    def make_state(st, lat_min, lat_max, lon_min, lon_max, proj, worked):
        x1, y1 = proj(lat_max, lon_min)
        x2, y2 = proj(lat_min, lon_max)
        rx, ry = min(x1, x2), min(y1, y2)
        rw, rh = abs(x2 - x1), abs(y2 - y1)
        cx, cy = rx + rw / 2, ry + rh / 2
        if worked:
            fill, stroke, tc = '#2a7a2a', '#1a5c1a', '#fff'
        else:
            fill, stroke, tc = '#e8e8e3', '#ccc', '#888'
        fs = max(5.0, min(rw * 0.32, rh * 0.50, 11.0))
        r = (f'<rect x="{rx:.1f}" y="{ry:.1f}" width="{rw:.1f}" height="{rh:.1f}" '
             f'fill="{fill}" stroke="{stroke}" stroke-width="0.5"/>')
        t = (f'<text x="{cx:.1f}" y="{cy:.1f}" font-family="monospace" font-size="{fs:.1f}" '
             f'font-weight="bold" fill="{tc}" text-anchor="middle" '
             f'dominant-baseline="central">{st}</text>')
        return r + t

    lines = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}">']
    lines.append(f'<rect width="{W}" height="{H}" fill="#f5f5f0"/>')
    lines.append(f'<rect x="{AK_X0}" y="{AK_Y0}" width="{AK_X1 - AK_X0}" '
                 f'height="{AK_Y1 - AK_Y0}" fill="#e8e8e3" stroke="#ccc" stroke-width="0.5"/>')
    lines.append(f'<rect x="{HI_X0}" y="{HI_Y0}" width="{HI_X1 - HI_X0}" '
                 f'height="{HI_Y1 - HI_Y0}" fill="#e8e8e3" stroke="#ccc" stroke-width="0.5"/>')

    not_worked = [s for s in STATES if s[0] not in worked_set]
    worked_states = [s for s in STATES if s[0] in worked_set]
    for s in not_worked + worked_states:
        lines.append(make_state(s[0], s[1], s[2], s[3], s[4], s[5], s[0] in worked_set))

    lines.append('</svg>')

    out_path = Path('data/was-map.svg')
    out_path.parent.mkdir(exist_ok=True)
    out_path.write_text('\n'.join(lines))
    print(f'Generated WAS map -> {out_path} ({len(worked_set)} states worked)')


def main():
    logs_dir = Path('logs')
    out_path = Path('data/qso-log.json')

    paths = sorted(
        list(logs_dir.glob('*.adi')) + list(logs_dir.glob('*.adif')),
        key=lambda p: p.stem
    )

    sessions = []
    all_qsos = []

    for path in paths:
        raw_qsos = parse_adif_file(path)
        if not raw_qsos:
            print(f"  {path.name}: no QSOs found, skipping")
            continue

        session_id = path.stem

        # Park reference: check several common ADIF fields in priority order
        park_ref = None
        for q in raw_qsos:
            ref = (q.get('MY_POTA_REF') or q.get('MY_SIG_INFO')
                   or q.get('POTA_REF') or q.get('SIG_INFO'))
            if ref and ref.strip():
                park_ref = ref.strip().upper()
                break

        is_pota = park_ref is not None
        if not is_pota:
            for q in raw_qsos:
                sig = (q.get('MY_SIG') or q.get('SIG', '')).upper()
                if sig == 'POTA':
                    is_pota = True
                    break

        # Derive session date from first QSO or filename
        first = raw_qsos[0]
        date_raw = first.get('QSO_DATE', '')
        date = fmt_date(date_raw) if date_raw else session_id[:10].replace('_', '-')

        session_bands = sorted(set(q.get('BAND', '').lower() for q in raw_qsos if q.get('BAND')))
        session_modes = sorted(set(q.get('MODE', '').upper() for q in raw_qsos if q.get('MODE')))

        sessions.append({
            'id': session_id,
            'date': date,
            'type': 'pota' if is_pota else 'general',
            'reference': park_ref,
            'bands': session_bands,
            'modes': session_modes,
            'qso_count': len(raw_qsos),
        })

        for q in raw_qsos:
            grid = q.get('GRIDSQUARE', '').upper().strip()
            lat, lon = maidenhead_to_latlon(grid) if grid else (None, None)
            all_qsos.append({
                'date':       fmt_date(q.get('QSO_DATE', '')),
                'time':       fmt_time(q.get('TIME_ON', '')),
                'call':       q.get('CALL', '').upper().strip(),
                'band':       q.get('BAND', '').lower(),
                'freq':       q.get('FREQ', ''),
                'mode':       q.get('MODE', '').upper(),
                'rst_sent':   q.get('RST_SENT', ''),
                'rst_rcvd':   q.get('RST_RCVD', ''),
                'name':       q.get('NAME', ''),
                'comment':    q.get('COMMENT', '') or q.get('NOTES', ''),
                'session':    session_id,
                'gridsquare': grid,
                'lat':        lat,
                'lon':        lon,
                'state':      q.get('STATE', '').upper().strip(),
                'dxcc':       q.get('DXCC', '').strip(),
            })

        print(f"  {path.name}: {len(raw_qsos)} QSOs, type={('pota' if is_pota else 'general')}, ref={park_ref or '—'}")

    sessions.sort(key=lambda s: s['date'], reverse=True)
    all_qsos.sort(key=lambda q: (q['date'], q['time']), reverse=True)

    unique_calls = len(set(q['call'] for q in all_qsos if q['call']))
    pota_parks = len(set(s['reference'] for s in sessions if s.get('reference')))
    dates = [q['date'] for q in all_qsos if q['date']]
    date_range = f"{min(dates)} — {max(dates)}" if dates else ''
    unique_grids = len(set(q['gridsquare'] for q in all_qsos if q.get('gridsquare')))
    states_worked = sorted(set(q['state'] for q in all_qsos if q.get('state')))
    generate_was_svg(states_worked)
    band_counts = {}
    for q in all_qsos:
        if q['band']:
            band_counts[q['band']] = band_counts.get(q['band'], 0) + 1
    mode_counts = {}
    for q in all_qsos:
        if q['mode']:
            mode_counts[q['mode']] = mode_counts.get(q['mode'], 0) + 1

    output = {
        'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'stats': {
            'qso_count':     len(all_qsos),
            'session_count': len(sessions),
            'unique_calls':  unique_calls,
            'pota_parks':    pota_parks,
            'date_range':    date_range,
            'unique_grids':  unique_grids,
            'states_worked': states_worked,
            'bands':         band_counts,
            'modes':         mode_counts,
        },
        'sessions': sessions,
        'qsos':     all_qsos,
    }

    out_path.parent.mkdir(exist_ok=True)
    out_path.write_text(json.dumps(output, indent=2))
    print(f"Written {len(all_qsos)} QSOs, {len(sessions)} sessions → {out_path}")


if __name__ == '__main__':
    main()
