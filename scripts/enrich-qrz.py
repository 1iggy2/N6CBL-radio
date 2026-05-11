#!/usr/bin/env python3
"""
Populate a public-safe QRZ XML callsign cache for the N6CBL.radio QSO log.

The script reads callsigns from ADIF-like files in logs/, looks up missing or stale
records through the QRZ XML service, and writes only fields useful for public log
presentation. QRZ credentials are read from environment variables and must never be
committed to this repository.
"""
import importlib.util
import json
import os
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOGS_DIR = ROOT / 'logs'
CACHE_PATH = ROOT / 'data' / 'qrz-callsign-cache.json'
PROCESS_LOGS_PATH = ROOT / 'scripts' / 'process-logs.py'
QRZ_ENDPOINT = 'https://xmldata.qrz.com/xml/current/'
AGENT = 'N6CBL.radio/1.0'
sys.dont_write_bytecode = True
DEFAULT_MAX_AGE_DAYS = 90
DEFAULT_LOOKUP_LIMIT = 250
DEFAULT_SLEEP_SECONDS = 0.2
SAFE_FIELDS = (
    'call', 'fname', 'name', 'nickname', 'name_fmt', 'state', 'country', 'land',
    'county', 'grid', 'dxcc', 'cqzone', 'ituzone', 'lotw', 'eqsl', 'mqsl',
    'image', 'url', 'moddate'
)


def load_process_logs_module():
    spec = importlib.util.spec_from_file_location('process_logs', PROCESS_LOGS_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def adif_paths():
    paths = []
    for suffix in ('*.adi', '*.adif', '*.log', '*.txt'):
        paths.extend(LOGS_DIR.glob(suffix))
    return sorted(paths, key=lambda p: p.stem)


def collect_callsigns():
    process_logs = load_process_logs_module()
    calls = set()
    for path in adif_paths():
        for qso in process_logs.parse_adif_file(path):
            call = normalize_call(qso.get('CALL', ''))
            if call:
                calls.add(call)
    return sorted(calls)


def normalize_call(value):
    call = ''.join(str(value or '').upper().strip().split())
    if not call:
        return ''
    # Portable suffixes are valid, but QRZ lookups normally expect the base call.
    # Keep the original if no plausible base segment exists.
    parts = [part for part in call.split('/') if part]
    if len(parts) > 1:
        candidates = [part for part in parts if any(ch.isdigit() for ch in part)]
        if candidates:
            call = max(candidates, key=len)
    return call


def load_cache():
    if not CACHE_PATH.exists():
        return {'version': 1, 'source': 'QRZ XML', 'calls': {}}
    try:
        data = json.loads(CACHE_PATH.read_text(encoding='utf-8'))
    except json.JSONDecodeError:
        return {'version': 1, 'source': 'QRZ XML', 'calls': {}}
    if not isinstance(data.get('calls'), dict):
        data['calls'] = {}
    data.setdefault('version', 1)
    data.setdefault('source', 'QRZ XML')
    return data


def cache_is_fresh(record, now, max_age_days):
    if not record or not record.get('updated'):
        return False
    try:
        updated = datetime.fromisoformat(record['updated'].replace('Z', '+00:00'))
    except ValueError:
        return False
    return updated >= now - timedelta(days=max_age_days)


def urlopen_xml(params):
    query = urllib.parse.urlencode(params)
    request = urllib.request.Request(
        f'{QRZ_ENDPOINT}?{query}',
        headers={'User-Agent': AGENT, 'Accept': 'application/xml,text/xml;q=0.9,*/*;q=0.1'},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def child_text(parent, name):
    if parent is None:
        return ''
    for child in list(parent):
        if child.tag.rsplit('}', 1)[-1] == name:
            return (child.text or '').strip()
    return ''


def first_child(root, name):
    for child in root.iter():
        if child.tag.rsplit('}', 1)[-1] == name:
            return child
    return None


def parse_xml(raw):
    return ET.fromstring(raw)


def login(username, password):
    root = parse_xml(urlopen_xml({'username': username, 'password': password, 'agent': AGENT}))
    session = first_child(root, 'Session')
    key = child_text(session, 'Key')
    if not key:
        error = child_text(session, 'Error') or 'QRZ login did not return a session key'
        raise RuntimeError(error)
    warning = child_text(session, 'Warning')
    if warning:
        print(f'QRZ warning: {warning}')
    return key


def display_name(fields):
    for key in ('name_fmt', 'nickname'):
        value = compact(fields.get(key, ''))
        if value:
            return value
    fname = compact(fields.get('fname', ''))
    name = compact(fields.get('name', ''))
    return compact(' '.join(part for part in (fname, name) if part))


def compact(value):
    return ' '.join(str(value or '').split())


def public_record(call, fields, now_iso):
    record = {
        'found': True,
        'updated': now_iso,
        'call': normalize_call(fields.get('call') or call),
        'display_name': display_name(fields),
        'qrz_url': f'https://www.qrz.com/db/{urllib.parse.quote(normalize_call(fields.get("call") or call))}',
    }
    for key in SAFE_FIELDS:
        value = compact(fields.get(key, ''))
        if value:
            record[key] = value
    # QRZ uses both country and land in different contexts; publish one stable field.
    if not record.get('country') and record.get('land'):
        record['country'] = record['land']
    if not record.get('grid'):
        record.pop('grid', None)
    return {key: value for key, value in record.items() if value not in ('', None)}


def not_found_record(message, now_iso):
    return {
        'found': False,
        'updated': now_iso,
        'message': compact(message)[:160],
    }


def lookup_call(session_key, call, now_iso):
    root = parse_xml(urlopen_xml({'s': session_key, 'callsign': call}))
    session = first_child(root, 'Session')
    error = child_text(session, 'Error')
    if error:
        return not_found_record(error, now_iso)
    callsign = first_child(root, 'Callsign')
    if callsign is None:
        return not_found_record('No callsign record returned', now_iso)
    fields = {}
    for child in list(callsign):
        fields[child.tag.rsplit('}', 1)[-1]] = child.text or ''
    return public_record(call, fields, now_iso)


def env_int(name, default):
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def env_float(name, default):
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


def main():
    username = os.environ.get('QRZ_USERNAME', '').strip()
    password = os.environ.get('QRZ_PASSWORD', '').strip()
    if not username or not password:
        print('QRZ_USERNAME and QRZ_PASSWORD are not set; leaving QRZ callsign cache unchanged.')
        return 0

    max_age_days = env_int('QRZ_CACHE_MAX_AGE_DAYS', DEFAULT_MAX_AGE_DAYS)
    lookup_limit = max(0, env_int('QRZ_LOOKUP_LIMIT', DEFAULT_LOOKUP_LIMIT))
    sleep_seconds = max(0.0, env_float('QRZ_LOOKUP_SLEEP_SECONDS', DEFAULT_SLEEP_SECONDS))
    now = datetime.now(timezone.utc)
    now_iso = now.strftime('%Y-%m-%dT%H:%M:%SZ')

    calls = collect_callsigns()
    cache = load_cache()
    records = cache.setdefault('calls', {})
    stale_or_missing = [call for call in calls if not cache_is_fresh(records.get(call), now, max_age_days)]
    to_lookup = stale_or_missing[:lookup_limit]

    print(f'QRZ cache: {len(calls)} calls in log, {len(stale_or_missing)} stale/missing, {len(to_lookup)} lookup(s) this run.')
    if not to_lookup:
        return 0

    session_key = login(username, password)
    for index, call in enumerate(to_lookup, start=1):
        try:
            records[call] = lookup_call(session_key, call, now_iso)
            status = 'found' if records[call].get('found') else 'not found'
            print(f'  [{index}/{len(to_lookup)}] {call}: {status}')
        except Exception as exc:
            records[call] = not_found_record(f'lookup failed: {exc}', now_iso)
            print(f'  [{index}/{len(to_lookup)}] {call}: lookup failed ({exc})')
        if sleep_seconds and index < len(to_lookup):
            time.sleep(sleep_seconds)

    cache['generated'] = now_iso
    cache['source'] = 'QRZ XML'
    cache['policy'] = {
        'public_safe_fields_only': True,
        'max_age_days': max_age_days,
        'lookup_limit': lookup_limit,
    }
    CACHE_PATH.parent.mkdir(exist_ok=True)
    CACHE_PATH.write_text(json.dumps(cache, indent=2, sort_keys=True) + '\n', encoding='utf-8')
    print(f'Wrote {CACHE_PATH.relative_to(ROOT)} with {len(records)} cached calls.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
