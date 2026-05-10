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
    """Generate a lightweight, recognizable WAS SVG map.

    The geometry below is intentionally simplified: state borders are coarse
    enough to keep the static site fast, but shaped enough to read immediately
    as the United States instead of an abstract rectangular tile grid.
    Coordinates are lon/lat pairs, projected into a fixed SVG canvas with
    Alaska and Hawaii in explicit inset boxes.
    """
    W, H = 960, 585
    worked_set = set(states_worked)

    MAIN = {'x0': 22, 'x1': 938, 'y0': 12, 'y1': 430,
            'lon0': -125.0, 'lon1': -66.5, 'lat0': 24.0, 'lat1': 49.5}
    AK = {'x0': 36, 'x1': 326, 'y0': 456, 'y1': 572,
          'lon0': -170.0, 'lon1': -130.0, 'lat0': 52.0, 'lat1': 72.0}
    HI = {'x0': 385, 'x1': 565, 'y0': 496, 'y1': 562,
          'lon0': -161.0, 'lon1': -154.5, 'lat0': 18.5, 'lat1': 22.5}

    def project(pt, box=MAIN):
        lon, lat = pt
        x = box['x0'] + (lon - box['lon0']) / (box['lon1'] - box['lon0']) * (box['x1'] - box['x0'])
        y = box['y0'] + (box['lat1'] - lat) / (box['lat1'] - box['lat0']) * (box['y1'] - box['y0'])
        return x, y

    def path_for(rings, box=MAIN):
        parts = []
        for ring in rings:
            pts = [project(pt, box) for pt in ring]
            parts.append('M ' + ' L '.join(f'{x:.1f},{y:.1f}' for x, y in pts) + ' Z')
        return ' '.join(parts)

    def text_xy(lon, lat, box=MAIN):
        x, y = project((lon, lat), box)
        return f'{x:.1f}', f'{y:.1f}'

    # Simplified state polygons. Not survey-grade; designed as a fast, readable
    # WAS status graphic with true geographic adjacency and a recognizable coast.
    states = {
        'WA': [[(-124.7,48.4),(-124.0,45.6),(-117.0,45.6),(-117.0,49.0),(-123.2,49.0)]],
        'OR': [[(-124.6,45.6),(-123.8,42.0),(-117.0,42.0),(-117.0,45.6)]],
        'CA': [[(-124.3,42.0),(-120.0,42.0),(-114.2,35.0),(-117.1,32.5),(-121.0,34.4),(-123.8,39.0)]],
        'ID': [[(-117.0,49.0),(-111.0,49.0),(-111.0,44.5),(-114.0,44.5),(-114.0,42.0),(-117.0,42.0)]],
        'NV': [[(-120.0,42.0),(-114.0,42.0),(-114.0,37.0),(-114.8,35.0),(-120.0,39.0)]],
        'AZ': [[(-114.8,37.0),(-109.0,37.0),(-109.0,31.3),(-111.0,31.3),(-114.8,32.5)]],
        'MT': [[(-116.0,49.0),(-104.0,49.0),(-104.0,45.0),(-111.0,45.0),(-111.0,44.5),(-116.0,44.5)]],
        'WY': [[(-111.0,45.0),(-104.0,45.0),(-104.0,41.0),(-111.0,41.0)]],
        'UT': [[(-114.0,42.0),(-109.0,42.0),(-109.0,37.0),(-114.0,37.0)]],
        'CO': [[(-109.0,41.0),(-102.0,41.0),(-102.0,37.0),(-109.0,37.0)]],
        'NM': [[(-109.0,37.0),(-103.0,37.0),(-103.0,32.0),(-106.6,31.8),(-109.0,31.3)]],
        'ND': [[(-104.0,49.0),(-97.0,49.0),(-97.0,45.9),(-104.0,45.9)]],
        'SD': [[(-104.0,45.9),(-96.5,45.9),(-96.5,42.5),(-104.0,42.5)]],
        'NE': [[(-104.0,42.5),(-95.3,42.5),(-95.3,40.0),(-102.0,40.0),(-104.0,41.0)]],
        'KS': [[(-102.0,40.0),(-94.6,40.0),(-94.6,37.0),(-102.0,37.0)]],
        'OK': [[(-103.0,37.0),(-94.4,37.0),(-94.4,33.7),(-97.0,33.7),(-97.0,35.0),(-103.0,35.0)]],
        'TX': [[(-106.6,32.0),(-103.0,32.0),(-103.0,35.0),(-97.0,35.0),(-97.0,33.7),(-94.0,33.7),(-93.5,30.0),(-97.0,25.8),(-100.0,28.5),(-104.0,29.8)]],
        'MN': [[(-97.0,49.0),(-89.5,49.0),(-89.5,46.0),(-92.0,46.0),(-92.0,43.5),(-96.5,43.5),(-97.0,45.9)]],
        'IA': [[(-96.5,43.5),(-91.0,43.5),(-90.1,41.0),(-91.0,40.4),(-96.5,40.4)]],
        'MO': [[(-95.8,40.4),(-91.0,40.4),(-89.1,36.0),(-90.0,35.9),(-94.6,36.5),(-94.6,37.0),(-95.8,37.0)]],
        'AR': [[(-94.6,36.5),(-90.0,36.5),(-89.7,33.0),(-94.0,33.0),(-94.6,33.7)]],
        'LA': [[(-94.0,33.0),(-89.7,33.0),(-89.0,29.3),(-91.5,29.0),(-93.8,29.7)]],
        'WI': [[(-92.9,46.8),(-86.8,46.8),(-86.8,43.0),(-90.1,42.5),(-92.0,43.5),(-92.0,46.0)]],
        'IL': [[(-91.5,42.5),(-87.5,42.5),(-87.5,37.0),(-89.1,37.0),(-90.1,40.4)]],
        'MS': [[(-91.7,35.0),(-88.1,35.0),(-88.1,30.2),(-89.7,30.2),(-91.0,31.0)]],
        'AL': [[(-88.5,35.0),(-85.0,35.0),(-85.0,31.0),(-87.6,30.2),(-88.1,30.2)]],
        'MI': [[(-90.4,47.5),(-84.5,47.5),(-84.5,45.5),(-87.0,45.0),(-90.4,46.0)], [(-86.5,45.0),(-82.4,43.8),(-82.4,41.7),(-86.0,41.7),(-87.0,43.0)]],
        'IN': [[(-88.1,41.8),(-84.8,41.8),(-84.8,37.8),(-87.5,37.8),(-87.5,41.8)]],
        'KY': [[(-89.6,37.8),(-82.0,37.8),(-81.9,36.6),(-85.0,36.6),(-89.1,36.9)]],
        'TN': [[(-90.3,36.6),(-81.7,36.6),(-82.2,35.0),(-90.0,35.0)]],
        'OH': [[(-84.8,42.2),(-80.5,42.2),(-80.5,39.0),(-82.0,38.4),(-84.8,39.1)]],
        'WV': [[(-82.6,40.6),(-79.0,40.6),(-77.7,39.0),(-80.0,37.2),(-82.2,37.8)]],
        'VA': [[(-83.7,39.0),(-75.2,39.0),(-75.5,36.6),(-81.7,36.6),(-80.0,37.2)]],
        'NC': [[(-84.3,36.6),(-75.5,36.6),(-75.8,34.0),(-80.0,34.0),(-84.3,35.2)]],
        'SC': [[(-83.4,35.2),(-80.0,34.0),(-78.5,32.0),(-81.0,32.0),(-83.4,33.2)]],
        'GA': [[(-85.0,35.0),(-82.2,35.0),(-80.9,32.0),(-83.0,30.6),(-85.0,31.0)]],
        'FL': [[(-87.6,30.6),(-83.0,30.6),(-80.0,25.2),(-81.2,24.5),(-82.6,27.0),(-84.5,29.0),(-87.6,30.2)]],
        'PA': [[(-80.5,42.3),(-74.7,42.0),(-74.7,39.7),(-79.0,39.7),(-80.5,40.6)]],
        'NY': [[(-79.8,45.0),(-73.3,45.0),(-71.9,41.3),(-74.7,40.5),(-79.8,42.0)]],
        'VT': [[(-73.4,45.0),(-71.5,45.0),(-71.5,42.7),(-73.0,42.7)]],
        'NH': [[(-71.5,45.0),(-70.7,43.0),(-71.1,42.7),(-72.6,42.7),(-72.0,45.0)]],
        'ME': [[(-71.1,47.5),(-67.0,45.0),(-69.8,43.1),(-70.7,43.0),(-71.5,45.0)]],
        'MA': [[(-73.5,42.9),(-69.9,42.6),(-70.6,41.2),(-73.5,41.2)]],
        'RI': [[(-71.9,42.0),(-71.1,42.0),(-71.1,41.1),(-71.9,41.1)]],
        'CT': [[(-73.7,42.1),(-71.8,42.1),(-71.8,40.9),(-73.7,40.9)]],
        'NJ': [[(-75.6,41.4),(-74.0,41.0),(-74.3,38.9),(-75.6,39.7)]],
        'DE': [[(-75.8,39.8),(-75.0,39.7),(-75.0,38.4),(-75.8,38.7)]],
        'MD': [[(-79.5,39.7),(-75.1,39.7),(-75.2,38.0),(-77.0,38.0),(-79.0,39.0)]],
        'AK': [[(-168,71),(-150,70),(-141,60),(-130,56),(-145,54),(-160,55),(-170,60)]],
        'HI': [[(-160.2,22.2),(-159.4,21.8),(-158.0,21.2),(-156.5,20.4),(-155.5,19.5),(-154.8,19.0)]],
    }

    worked_set = worked_set.intersection(states)

    label_pos = {
        'AL': (-86.7, 32.8), 'AK': (-151, 61.2), 'AZ': (-111.8, 34.1), 'AR': (-92.4, 34.8),
        'CA': (-119.5, 37.2), 'CO': (-105.5, 39.0), 'CT': (-72.7, 41.55), 'DE': (-75.35, 39.1),
        'FL': (-82.4, 28.0), 'GA': (-83.4, 32.8), 'HI': (-157.5, 20.7), 'ID': (-114.0, 45.2),
        'IL': (-89.3, 40.0), 'IN': (-86.3, 39.9), 'IA': (-93.5, 42.0), 'KS': (-98.2, 38.4),
        'KY': (-85.2, 37.2), 'LA': (-91.7, 30.8), 'ME': (-69.5, 45.3), 'MD': (-77.0, 38.8),
        'MA': (-71.6, 42.1), 'MI': (-85.5, 44.0), 'MN': (-94.4, 46.2), 'MS': (-89.7, 32.9),
        'MO': (-92.4, 38.5), 'MT': (-110.2, 47.0), 'NE': (-99.7, 41.4), 'NV': (-117.0, 39.0),
        'NH': (-71.6, 43.7), 'NJ': (-74.8, 40.2), 'NM': (-106.0, 34.5), 'NY': (-75.7, 43.1),
        'NC': (-79.5, 35.3), 'ND': (-100.4, 47.5), 'OH': (-82.7, 40.4), 'OK': (-97.5, 35.6),
        'OR': (-120.5, 44.0), 'PA': (-77.7, 40.8), 'RI': (-71.5, 41.5), 'SC': (-80.9, 33.7),
        'SD': (-100.2, 44.4), 'TN': (-86.1, 35.8), 'TX': (-99.2, 31.1), 'UT': (-111.7, 39.5),
        'VT': (-72.6, 44.0), 'VA': (-78.5, 37.6), 'WA': (-120.8, 47.4), 'WV': (-80.6, 38.7),
        'WI': (-89.6, 44.5), 'WY': (-107.5, 43.0),
    }

    def state_box(st):
        if st == 'AK':
            return AK
        if st == 'HI':
            return HI
        return MAIN

    lines = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" role="img" aria-labelledby="was-title was-desc">']
    lines.append('<title id="was-title">Worked All States map</title>')
    lines.append('<desc id="was-desc">United States state map with worked states shown in green and unworked states in gray.</desc>')
    lines.append(f'<rect width="{W}" height="{H}" fill="#f5f5f0"/>')
    lines.append('<g fill="none" stroke="#cfcfc8" stroke-width="1">')
    lines.append(f'<rect x="{AK["x0"]}" y="{AK["y0"]}" width="{AK["x1"] - AK["x0"]}" height="{AK["y1"] - AK["y0"]}"/>')
    lines.append(f'<rect x="{HI["x0"]}" y="{HI["y0"]}" width="{HI["x1"] - HI["x0"]}" height="{HI["y1"] - HI["y0"]}"/>')
    lines.append('</g>')

    for st in sorted(states):
        worked = st in worked_set
        fill = '#2f7d32' if worked else '#e8e8e3'
        stroke = '#1f5e23' if worked else '#c7c7bf'
        lines.append(f'<path id="was-{st}" d="{path_for(states[st], state_box(st))}" fill="{fill}" stroke="{stroke}" stroke-width="1.1" vector-effect="non-scaling-stroke"/>')

    for st in sorted(states):
        bx = state_box(st)
        x, y = text_xy(*label_pos[st], bx)
        color = '#fff' if st in worked_set else '#777'
        fs = '12' if st not in ('CT', 'DE', 'RI', 'NJ', 'MD', 'MA', 'NH', 'VT') else '10'
        lines.append(f'<text x="{x}" y="{y}" font-family="Consolas, Menlo, Monaco, monospace" font-size="{fs}" font-weight="700" fill="{color}" text-anchor="middle" dominant-baseline="central">{st}</text>')

    lines.append('<text x="42" y="449" font-family="Consolas, Menlo, Monaco, monospace" font-size="10" fill="#777">ALASKA INSET</text>')
    lines.append('<text x="391" y="489" font-family="Consolas, Menlo, Monaco, monospace" font-size="10" fill="#777">HAWAII INSET</text>')
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
