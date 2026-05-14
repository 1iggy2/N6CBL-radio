#!/usr/bin/env python3
"""
Fetch the N6CBL QRZ Logbook as ADIF for downstream static-log generation.

QRZ's Logbook API uses a per-logbook access key, not the XML username/password
session used by callsign lookups. The key must be supplied as QRZ_LOGBOOK_KEY and
must never be committed. The fetched ADIF is written to an ignored working file so
only the public-safe derived JSON is committed.
"""
import os
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ENDPOINT = 'https://logbook.qrz.com/api'
AGENT = 'N6CBL.radio QRZ log fetch/1.0 (N6CBL)'
DEFAULT_OUTPUT = '.cache/qrz-logbook.adi'
DEFAULT_FETCH_OPTION = 'ALL'
ADIF_LOGID_RE = re.compile(r'<APP_QRZLOG_LOGID:\d+[^>]*>(\d+)', re.IGNORECASE)
ADIF_EOR_RE = re.compile(r'<EOR>', re.IGNORECASE)
ADIF_TAG_RE = re.compile(r'<(?:EOH|[A-Z][A-Z0-9_]*:\d+(?::[^>]*)?)>', re.IGNORECASE)


def decode_form_value(value):
    return urllib.parse.unquote_plus(value)


def parse_response(body):
    text = body.decode('utf-8', errors='replace')
    adif = ''
    fields_text = text

    adif_match = re.search(r'(?:^|[&;])ADIF=', text, flags=re.IGNORECASE)
    if adif_match:
        value_start = adif_match.end()
        fields_text = text[:adif_match.start()]
        adif = decode_form_value(text[value_start:])
    else:
        tag_match = ADIF_TAG_RE.search(text)
        if tag_match:
            fields_text = text[:tag_match.start()].rstrip('&;\r\n')
            adif = text[tag_match.start():]

    parsed = urllib.parse.parse_qs(
        fields_text.replace(';', '&'),
        keep_blank_values=True,
        strict_parsing=False,
        separator='&',
    )
    fields = {key.upper(): values[-1] if values else '' for key, values in parsed.items()}
    if adif:
        fields['ADIF'] = adif
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


def post_qrz_logbook(key, option):
    data = urllib.parse.urlencode({
        'KEY': key,
        'ACTION': 'FETCH',
        'OPTION': adif_fetch_option(option),
    }).encode('utf-8')
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

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(adif, encoding='utf-8')
    print(f'Fetched QRZ Logbook ADIF: {count} record(s) -> {output_path}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
