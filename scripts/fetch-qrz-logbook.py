#!/usr/bin/env python3
"""
Fetch the N6CBL QRZ Logbook as ADIF for downstream static-log generation.

QRZ's Logbook API uses a per-logbook access key, not the XML username/password
session used by callsign lookups. The key must be supplied as QRZ_LOGBOOK_KEY and
must never be committed. The fetched ADIF is written to an ignored working file so
only the public-safe derived JSON is committed.

A second call asks QRZ for the book status (record count, confirmed count, DXCC
count) and writes it beside the ADIF. process-logs.py falls back to that confirmed
count if an export ever arrives without per-QSO confirmation status.
"""
import html
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ENDPOINT = 'https://logbook.qrz.com/api'
AGENT = 'N6CBL.radio QRZ log fetch/1.0 (N6CBL)'
DEFAULT_OUTPUT = '.cache/qrz-logbook.adi'
DEFAULT_STATUS_OUTPUT = '.cache/qrz-logbook-status.json'
DEFAULT_FETCH_OPTION = 'ALL'

# Book-wide totals from ACTION=STATUS. QRZ counts its own confirmations here, so
# the site can report a confirmed total even if an ADIF export ever comes back
# without per-QSO status. Integer fields are kept as integers; everything else
# is dropped rather than guessed at.
STATUS_FIELDS = {
    'COUNT':      ('count', int),
    'CONFIRMED':  ('confirmed', int),
    'DXCC_COUNT': ('dxcc_count', int),
    'BOOKNAME':   ('book_name', str),
    'START_DATE': ('start_date', str),
    'END_DATE':   ('end_date', str),
}
ADIF_LOGID_RE = re.compile(r'<APP_QRZLOG_LOGID:\d+[^>]*>(\d+)', re.IGNORECASE)
ADIF_EOR_RE = re.compile(r'<EOR>', re.IGNORECASE)
ADIF_TAG_RE = re.compile(r'<(?:EOH|[A-Z][A-Z0-9_]*:\d+(?::[^>]*)?)>', re.IGNORECASE)


def decode_form_value(value):
    return urllib.parse.unquote_plus(value)


def normalize_adif_text(adif):
    """Decode transport escaping until ADIF tags are visible to downstream parsers."""
    text = str(adif or '').lstrip('\ufeff')
    for _ in range(3):
        next_text = text
        if '<' not in next_text and '%' in next_text:
            next_text = decode_form_value(next_text)
        if '<' not in next_text and re.search(r'&lt;', next_text, re.IGNORECASE):
            next_text = html.unescape(next_text)
        if next_text == text:
            break
        text = next_text
    return text


def fetched_qso_count(adif):
    normalized = normalize_adif_text(adif)
    return len(re.findall(r'<CALL:\d+(?::[A-Z])?>', normalized, re.IGNORECASE))


def parse_response(body):
    text = body.decode('utf-8', errors='replace')
    adif = ''
    fields_text = text

    adif_match = re.search(r'(?:^|[&;])ADIF=', text, flags=re.IGNORECASE)
    if adif_match:
        value_start = adif_match.end()
        fields_text = text[:adif_match.start()]
        adif = normalize_adif_text(decode_form_value(text[value_start:]))
    else:
        tag_match = ADIF_TAG_RE.search(text)
        if tag_match:
            fields_text = text[:tag_match.start()].rstrip('&;\r\n')
            adif = normalize_adif_text(text[tag_match.start():])

    parsed = urllib.parse.parse_qs(
        fields_text.replace(';', '&'),
        keep_blank_values=True,
        strict_parsing=False,
        separator='&',
    )
    fields = {key.upper(): values[-1] if values else '' for key, values in parsed.items()}
    if adif:
        fields['ADIF'] = normalize_adif_text(adif)
    return fields, text


def option_parts(option):
    return [part.strip() for part in option.split(',') if part.strip()]


def adif_fetch_option(option):
    parts = option_parts(option)
    if not parts:
        parts = option_parts(DEFAULT_FETCH_OPTION)
    if not any(part.upper().startswith('TYPE:') for part in parts):
        parts.append('TYPE:ADIF')
    return ','.join(parts)


def post_qrz_logbook(key, option=None, action='FETCH'):
    form = {'KEY': key, 'ACTION': action}
    if option is not None:
        form['OPTION'] = adif_fetch_option(option)
    data = urllib.parse.urlencode(form).encode('utf-8')
    request = urllib.request.Request(
        ENDPOINT,
        data=data,
        headers={
            'User-Agent': AGENT,
            'Accept': 'text/plain,*/*;q=0.1',
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        method='POST',
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def parse_book_status(fields):
    status = {}
    for source, (name, cast) in STATUS_FIELDS.items():
        value = str(fields.get(source, '')).strip()
        if not value:
            continue
        if cast is int:
            if value.lstrip('-').isdigit():
                status[name] = int(value)
        else:
            status[name] = value
    return status


def fetch_book_status(key):
    """Book-wide totals, including QRZ's own confirmed count."""
    fields, raw_text = parse_response(post_qrz_logbook(key, action='STATUS'))
    result = fields.get('RESULT', '').upper()
    if result != 'OK':
        reason = fields.get('REASON') or raw_text[:200]
        raise RuntimeError(f'QRZ Logbook status failed: RESULT={result or "(missing)"} REASON={reason}')
    return parse_book_status(fields)


def max_qrz_logid(adif):
    logids = [int(match.group(1)) for match in ADIF_LOGID_RE.finditer(adif)]
    return max(logids) if logids else None


def adif_record_count(adif):
    return len(ADIF_EOR_RE.findall(adif))


def fetch_page(key, option):
    fields, raw_text = parse_response(post_qrz_logbook(key, option))
    result = fields.get('RESULT', '').upper()
    if result != 'OK':
        reason = fields.get('REASON') or raw_text[:500]
        raise RuntimeError(f'QRZ Logbook fetch failed: RESULT={result or "(missing)"} REASON={reason}')
    return fields


def should_page(option):
    parts = option_parts(option)
    upper_parts = [part.upper() for part in parts]
    return (
        any(part.startswith('MAX:') for part in upper_parts)
        and any(part.startswith('AFTERLOGID:') for part in upper_parts)
        and not any(part.startswith('LOGIDS:') for part in upper_parts)
    )


def replace_option_part(parts, name, value):
    prefix = f'{name.upper()}:'
    replaced = False
    next_parts = []
    for part in parts:
        if part.upper().startswith(prefix):
            next_parts.append(f'{name}:{value}')
            replaced = True
        else:
            next_parts.append(part)
    if not replaced:
        next_parts.append(f'{name}:{value}')
    return next_parts


def fetch_adif(key, option):
    option = adif_fetch_option(option)
    if not should_page(option):
        fields = fetch_page(key, option)
        return fields.get('ADIF', ''), fields.get('COUNT', 'unknown')

    parts = option_parts(option)
    max_part = next((part for part in parts if part.upper().startswith('MAX:')), 'MAX:250')
    page_size = int(max_part.split(':', 1)[1])
    after_logid = 0
    pages = []
    total_count = 'unknown'

    while True:
        page_parts = replace_option_part(parts, 'AFTERLOGID', after_logid)
        fields = fetch_page(key, ','.join(page_parts))
        adif = fields.get('ADIF', '')
        count = fields.get('COUNT', total_count)
        if total_count == 'unknown' and count:
            total_count = count
        if not adif.strip():
            break

        pages.append(adif.strip())
        next_after_logid = max_qrz_logid(adif)
        if next_after_logid is None or next_after_logid <= after_logid:
            break
        after_logid = next_after_logid + 1

        if adif_record_count(adif) < page_size:
            break

    return '\n'.join(pages), total_count


def main():
    key = os.environ.get('QRZ_LOGBOOK_KEY', '').strip()
    if not key:
        print('QRZ_LOGBOOK_KEY is not set; cannot fetch QRZ Logbook ADIF.', file=sys.stderr)
        return 2

    output_path = Path(os.environ.get('QRZ_LOGBOOK_ADIF_PATH', DEFAULT_OUTPUT)).resolve()
    option = os.environ.get('QRZ_LOGBOOK_FETCH_OPTION', DEFAULT_FETCH_OPTION).strip() or DEFAULT_FETCH_OPTION

    try:
        adif, count = fetch_adif(key, option)
    except RuntimeError as exc:
        print(exc, file=sys.stderr)
        return 1

    parsed_count = fetched_qso_count(adif)

    if not adif.strip():
        if str(count).strip() in ('', '0', 'unknown'):
            adif = 'Generated by N6CBL.radio QRZ log fetch\n<EOH>\n'
            print(f'QRZ Logbook fetch returned OK with {count if count != "unknown" else 0} records; writing empty ADIF -> {output_path}')
        else:
            print(
                f'QRZ Logbook fetch returned OK with COUNT={count} but no ADIF data. '
                'Check QRZ_LOGBOOK_FETCH_OPTION; do not use MAX:0 unless only a count is needed.',
                file=sys.stderr,
            )
            return 1

    if str(count).strip() not in ('', '0', 'unknown') and parsed_count == 0:
        print(
            f'QRZ Logbook fetch returned COUNT={count} but no parseable ADIF QSO records. '
            'Refusing to overwrite data/qso-log.json with an empty derived log.',
            file=sys.stderr,
        )
        return 1

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(adif, encoding='utf-8')
    print(f'Fetched QRZ Logbook ADIF: {count} record(s) -> {output_path}')

    # The book status is a secondary read: the log itself is already written, so
    # a failure here is reported and survived rather than losing the fetch.
    status_path = Path(os.environ.get('QRZ_LOGBOOK_STATUS_PATH', DEFAULT_STATUS_OUTPUT)).resolve()
    try:
        status = fetch_book_status(key)
    except (RuntimeError, OSError) as exc:
        print(f'QRZ Logbook status unavailable ({exc}); continuing without book totals.', file=sys.stderr)
        return 0

    status['fetched'] = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
    status_path.parent.mkdir(parents=True, exist_ok=True)
    status_path.write_text(json.dumps(status, indent=2), encoding='utf-8')
    confirmed = status.get('confirmed')
    print(
        f'QRZ Logbook status: {status.get("count", "unknown")} record(s), '
        f'{confirmed if confirmed is not None else "no"} confirmed -> {status_path}'
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
