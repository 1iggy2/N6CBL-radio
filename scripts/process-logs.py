#!/usr/bin/env python3
"""
Process ADIF records into data/qso-log.json.

The scheduled production path fetches QRZ Logbook ADIF into an ignored working
file, then passes that path through QSO_LOG_ADIF_PATH. A legacy logs/ fallback is
kept for local one-off parsing, but committed log uploads are no longer the source
of truth. Park reference and session type are derived from ADIF data, not filename.
"""
import re
import json
import os
import sys
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



def load_qrz_cache():
    cache_path = Path('data/qrz-callsign-cache.json')
    if not cache_path.exists():
        return {}
    try:
        data = json.loads(cache_path.read_text(encoding='utf-8'))
    except json.JSONDecodeError as exc:
        print(f"  {cache_path}: invalid QRZ cache JSON ({exc}), skipping")
        return {}
    calls = data.get('calls', {})
    if not isinstance(calls, dict):
        return {}
    return {str(call).upper(): record for call, record in calls.items() if isinstance(record, dict)}


def first_value(*values):
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ''



def split_reference_list(raw):
    refs = []
    for part in re.split(r'[,;\s]+', str(raw or '').upper().strip()):
        part = part.strip()
        if part and part not in refs:
            refs.append(part)
    return refs


def proper_name(text):
    text = re.sub(r'\s+', ' ', str(text or '').strip())
    if not text:
        return ''
    if text.isupper() or text.islower():
        return text.title()
    return text


def first_token(text):
    text = re.sub(r'"[^"]*"', ' ', str(text or ''))
    text = re.sub(r'[^A-Za-z\s-]', ' ', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return proper_name(text.split(' ')[0]) if text else ''

def qrz_record_for(qrz_cache, call):
    record = qrz_cache.get(str(call or '').upper().strip(), {})
    if record.get('found'):
        return record
    return {}


def qrz_flag(record, key):
    value = str(record.get(key, '')).strip().lower()
    return value in ('1', 'true', 'yes', 'y')

def load_activation_notes():
    notes_dir = Path('content/activations')
    notes = {}
    if not notes_dir.exists():
        return notes
    for path in sorted(notes_dir.glob('*.json')):
        try:
            note = json.loads(path.read_text(encoding='utf-8'))
        except json.JSONDecodeError as exc:
            print(f"  {path}: invalid activation note JSON ({exc}), skipping")
            continue
        keys = {path.stem}
        if note.get('slug') and note.get('date'):
            keys.add(f"{note['date']}-{note['slug']}")
        if note.get('logPath'):
            keys.add(Path(note['logPath']).stem)
        for key in keys:
            notes[str(key)] = note
    return notes


def configured_adif_paths():
    explicit = [arg for arg in sys.argv[1:] if arg.strip()]
    env_paths = [part for part in os.environ.get('QSO_LOG_ADIF_PATH', '').split(os.pathsep) if part.strip()]
    if explicit or env_paths:
        return sorted([Path(path) for path in explicit + env_paths], key=lambda p: p.stem)

    logs_dir = Path('logs')
    paths = []
    for suffix in ('*.adi', '*.adif', '*.log', '*.txt'):
        paths.extend(logs_dir.glob(suffix))
    return sorted(paths, key=lambda p: p.stem)


def qso_group_key(qso, fallback):
    date = fmt_date(qso.get('QSO_DATE', '')) or fallback
    park_ref = first_value(
        qso.get('MY_POTA_REF', ''),
        qso.get('MY_SIG_INFO', ''),
        qso.get('POTA_REF', ''),
        qso.get('SIG_INFO', ''),
    ).upper().strip()
    if park_ref:
        return f'{date}-{slug_text(park_ref)}'
    return date or fallback


def slug_text(value):
    return re.sub(r'[^a-z0-9]+', '-', str(value or '').lower()).strip('-') or 'log'


def should_sessionize(path):
    if os.environ.get('QSO_LOG_SESSIONIZE', '').strip().lower() in ('1', 'true', 'yes'):
        return True
    return path.stem == 'qrz-logbook'


def main():
    out_path = Path('data/qso-log.json')
    activation_notes = load_activation_notes()
    qrz_cache = load_qrz_cache()

    paths = configured_adif_paths()

    sessions = []
    all_qsos = []

    for path in paths:
        raw_qsos = parse_adif_file(path)
        if not raw_qsos:
            print(f"  {path.name}: no QSOs found, skipping")
            continue

        qso_groups = {path.stem: raw_qsos}
        if should_sessionize(path):
            qso_groups = {}
            for qso in raw_qsos:
                qso_groups.setdefault(qso_group_key(qso, path.stem), []).append(qso)

        for session_id, session_qsos in sorted(qso_groups.items()):
            # Park reference: check several common ADIF fields in priority order
            park_ref = None
            for q in session_qsos:
                ref = (q.get('MY_POTA_REF') or q.get('MY_SIG_INFO')
                       or q.get('POTA_REF') or q.get('SIG_INFO'))
                if ref and ref.strip():
                    park_ref = ref.strip().upper()
                    break

            is_pota = park_ref is not None
            if not is_pota:
                for q in session_qsos:
                    sig = (q.get('MY_SIG') or q.get('SIG', '')).upper()
                    if sig == 'POTA':
                        is_pota = True
                        break

            # Derive session date from first QSO or filename
            first = session_qsos[0]
            date_raw = first.get('QSO_DATE', '')
            date = fmt_date(date_raw) if date_raw else session_id[:10].replace('_', '-')

            session_bands = sorted(set(q.get('BAND', '').lower() for q in session_qsos if q.get('BAND')))
            session_modes = sorted(set(q.get('MODE', '').upper() for q in session_qsos if q.get('MODE')))
            note = activation_notes.get(session_id, {})

            session = {
                'id': session_id,
                'date': date,
                'type': 'pota' if is_pota else 'general',
                'reference': note.get('reference') or park_ref,
                'bands': session_bands,
                'modes': session_modes,
                'qso_count': len(session_qsos),
            }
            for key in ('title', 'location', 'report', 'tags'):
                if note.get(key):
                    session[key] = note[key]
            sessions.append(session)

            for q in session_qsos:
                call = q.get('CALL', '').upper().strip()
                qrz = qrz_record_for(qrz_cache, call)
                grid = first_value(q.get('GRIDSQUARE', ''), qrz.get('grid', '')).upper().strip()
                lat, lon = maidenhead_to_latlon(grid) if grid else (None, None)
                state = first_value(q.get('STATE', ''), qrz.get('state', '')).upper().strip()
                country = first_value(q.get('COUNTRY', ''), qrz.get('country', ''), qrz.get('land', ''))
                name = first_value(q.get('NAME', ''), qrz.get('display_name', ''), qrz.get('name_fmt', ''))
                first_name = first_value(qrz.get('nickname', ''), first_token(qrz.get('fname', '')), first_token(name))
                last_name = first_value(proper_name(qrz.get('name', '')), '')
                hunted_pota_refs = []
                if (q.get('SIG', '') or '').upper().strip() == 'POTA':
                    hunted_pota_refs = split_reference_list(q.get('POTA_REF') or q.get('SIG_INFO'))
                elif q.get('POTA_REF'):
                    hunted_pota_refs = split_reference_list(q.get('POTA_REF'))
                all_qsos.append({
                    'date':       fmt_date(q.get('QSO_DATE', '')),
                    'time':       fmt_time(q.get('TIME_ON', '')),
                    'call':       call,
                    'band':       q.get('BAND', '').lower(),
                    'freq':       q.get('FREQ', ''),
                    'mode':       q.get('MODE', '').upper(),
                    'rst_sent':   q.get('RST_SENT', ''),
                    'rst_rcvd':   q.get('RST_RCVD', ''),
                    'name':       name,
                    'first_name': proper_name(first_name),
                    'last_name':  proper_name(last_name),
                    'comment':    q.get('COMMENT', '') or q.get('NOTES', ''),
                    'session':    session_id,
                    'gridsquare': grid,
                    'lat':        lat,
                    'lon':        lon,
                    'state':      state,
                    'country':    country,
                    'county':     first_value(q.get('CNTY', ''), q.get('COUNTY', ''), qrz.get('county', '')),
                    'pota_refs':  hunted_pota_refs,
                    'dxcc':       first_value(q.get('DXCC', ''), qrz.get('dxcc', '')),
                    'cqzone':     first_value(q.get('CQZ', ''), qrz.get('cqzone', '')),
                    'ituzone':    first_value(q.get('ITUZ', ''), qrz.get('ituzone', '')),
                    'lotw':       qrz_flag(qrz, 'lotw'),
                    'eqsl':       qrz_flag(qrz, 'eqsl'),
                    'mqsl':       qrz_flag(qrz, 'mqsl'),
                    'qrz_url':    first_value(qrz.get('qrz_url', ''), f"https://www.qrz.com/db/{call}" if call else ''),
                    'qrz_enriched': bool(qrz),
                })

            print(f"  {path.name}#{session_id}: {len(session_qsos)} QSOs, type={('pota' if is_pota else 'general')}, ref={park_ref or '—'}")

    sessions.sort(key=lambda s: s['date'], reverse=True)
    all_qsos.sort(key=lambda q: (q['date'], q['time']), reverse=True)

    unique_calls = len(set(q['call'] for q in all_qsos if q['call']))
    pota_parks = len(set(s['reference'] for s in sessions if s.get('reference')))
    dates = [q['date'] for q in all_qsos if q['date']]
    date_range = f"{min(dates)} — {max(dates)}" if dates else ''
    unique_grids = len(set(q['gridsquare'] for q in all_qsos if q.get('gridsquare')))
    states_worked = sorted(set(q['state'] for q in all_qsos if q.get('state')))
    countries_worked = sorted(set(q['country'] for q in all_qsos if q.get('country')))
    dxcc_worked = sorted(set(q['dxcc'] for q in all_qsos if q.get('dxcc')))
    qrz_enriched = len(set(q['call'] for q in all_qsos if q.get('qrz_enriched') and q.get('call')))
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
            'countries_worked': countries_worked,
            'dxcc_worked':   dxcc_worked,
            'qrz_enriched_calls': qrz_enriched,
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
