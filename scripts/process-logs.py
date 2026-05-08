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

        bands = sorted(set(q.get('BAND', '').lower() for q in raw_qsos if q.get('BAND')))
        modes = sorted(set(q.get('MODE', '').upper() for q in raw_qsos if q.get('MODE')))

        sessions.append({
            'id': session_id,
            'date': date,
            'type': 'pota' if is_pota else 'general',
            'reference': park_ref,
            'bands': bands,
            'modes': modes,
            'qso_count': len(raw_qsos),
        })

        for q in raw_qsos:
            all_qsos.append({
                'date':     fmt_date(q.get('QSO_DATE', '')),
                'time':     fmt_time(q.get('TIME_ON', '')),
                'call':     q.get('CALL', '').upper().strip(),
                'band':     q.get('BAND', '').lower(),
                'freq':     q.get('FREQ', ''),
                'mode':     q.get('MODE', '').upper(),
                'rst_sent': q.get('RST_SENT', ''),
                'rst_rcvd': q.get('RST_RCVD', ''),
                'name':     q.get('NAME', ''),
                'comment':  q.get('COMMENT', '') or q.get('NOTES', ''),
                'session':  session_id,
            })

        print(f"  {path.name}: {len(raw_qsos)} QSOs, type={('pota' if is_pota else 'general')}, ref={park_ref or '—'}")

    sessions.sort(key=lambda s: s['date'], reverse=True)
    all_qsos.sort(key=lambda q: (q['date'], q['time']), reverse=True)

    unique_calls = len(set(q['call'] for q in all_qsos if q['call']))
    pota_parks = len(set(s['reference'] for s in sessions if s.get('reference')))
    dates = [q['date'] for q in all_qsos if q['date']]
    date_range = f"{min(dates)} — {max(dates)}" if dates else ''

    output = {
        'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'stats': {
            'qso_count':     len(all_qsos),
            'session_count': len(sessions),
            'unique_calls':  unique_calls,
            'pota_parks':    pota_parks,
            'date_range':    date_range,
        },
        'sessions': sessions,
        'qsos':     all_qsos,
    }

    out_path.parent.mkdir(exist_ok=True)
    out_path.write_text(json.dumps(output, indent=2))
    print(f"Written {len(all_qsos)} QSOs, {len(sessions)} sessions → {out_path}")


if __name__ == '__main__':
    main()
