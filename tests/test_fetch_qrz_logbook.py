import importlib.util
from pathlib import Path
import unittest

MODULE_PATH = Path(__file__).resolve().parents[1] / 'scripts' / 'fetch-qrz-logbook.py'
spec = importlib.util.spec_from_file_location('fetch_qrz_logbook', MODULE_PATH)
fetch_qrz_logbook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch_qrz_logbook)


class FetchQrzLogbookTests(unittest.TestCase):
    def test_parse_response_preserves_unescaped_adif_body(self):
        body = (
            b'RESULT=OK&COUNT=1&ADIF=<EOH>\n'
            b'<CALL:4>W1AW<APP_QRZLOG_LOGID:3>123<COMMENT:12>A&B portable<EOR>'
        )

        fields, _ = fetch_qrz_logbook.parse_response(body)

        self.assertEqual(fields['RESULT'], 'OK')
        self.assertEqual(fields['COUNT'], '1')
        self.assertIn('<CALL:4>W1AW', fields['ADIF'])
        self.assertIn('A&B portable', fields['ADIF'])

    def test_parse_response_accepts_raw_adif_after_status_fields(self):
        body = b'RESULT=OK&COUNT=1\n<EOH>\n<CALL:4>W1AW<APP_QRZLOG_LOGID:3>123<EOR>'

        fields, _ = fetch_qrz_logbook.parse_response(body)

        self.assertEqual(fields['RESULT'], 'OK')
        self.assertEqual(fields['COUNT'], '1')
        self.assertIn('<CALL:4>W1AW', fields['ADIF'])

    def test_parse_response_decodes_double_encoded_adif(self):
        encoded = '%253CEOH%253E%250A%253CCALL%253A4%253EW1AW%253CEOR%253E'
        body = f'RESULT=OK&COUNT=1&ADIF={encoded}'.encode()

        fields, _ = fetch_qrz_logbook.parse_response(body)

        self.assertIn('<CALL:4>W1AW', fields['ADIF'])
        self.assertEqual(fetch_qrz_logbook.fetched_qso_count(fields['ADIF']), 1)

    def test_parse_response_decodes_html_escaped_adif(self):
        body = b'RESULT=OK&COUNT=1&ADIF=&lt;EOH&gt;%0A&lt;CALL:4&gt;W1AW&lt;EOR&gt;'

        fields, _ = fetch_qrz_logbook.parse_response(body)

        self.assertIn('<CALL:4>W1AW', fields['ADIF'])
        self.assertEqual(fetch_qrz_logbook.fetched_qso_count(fields['ADIF']), 1)

    def test_default_fetch_option_uses_all_export(self):
        self.assertEqual(fetch_qrz_logbook.DEFAULT_FETCH_OPTION, 'ALL')
        self.assertEqual(fetch_qrz_logbook.adif_fetch_option(''), 'ALL,TYPE:ADIF')

    def test_fetch_option_pages_by_qrz_logid(self):
        responses = []

        def fake_post(_key, option):
            responses.append(option)
            if 'AFTERLOGID:0' in option:
                return b'RESULT=OK&COUNT=3&ADIF=<EOH>\n<CALL:4>W1AW<APP_QRZLOG_LOGID:3>100<EOR><CALL:4>K1ZZ<APP_QRZLOG_LOGID:3>101<EOR>'
            if 'AFTERLOGID:102' in option:
                return b'RESULT=OK&COUNT=1&ADIF=<EOH>\n<CALL:4>N6CB<APP_QRZLOG_LOGID:3>105<EOR>'
            return b'RESULT=OK&COUNT=0&ADIF='

        original_post = fetch_qrz_logbook.post_qrz_logbook
        fetch_qrz_logbook.post_qrz_logbook = fake_post
        try:
            adif, count = fetch_qrz_logbook.fetch_adif('key', 'TYPE:ADIF,MAX:2,AFTERLOGID:0')
        finally:
            fetch_qrz_logbook.post_qrz_logbook = original_post

        self.assertEqual(count, '3')
        self.assertIn('<CALL:4>W1AW', adif)
        self.assertIn('<CALL:4>N6CB', adif)
        self.assertEqual(responses[0], 'TYPE:ADIF,MAX:2,AFTERLOGID:0')
        self.assertEqual(responses[1], 'TYPE:ADIF,MAX:2,AFTERLOGID:102')


class BookStatusTests(unittest.TestCase):
    def test_parses_book_totals_including_confirmed_count(self):
        fields, _ = fetch_qrz_logbook.parse_response(
            b'RESULT=OK&COUNT=163&CONFIRMED=97&DXCC_COUNT=3&BOOKNAME=N6CBL'
        )

        status = fetch_qrz_logbook.parse_book_status(fields)

        self.assertEqual(status, {
            'count': 163, 'confirmed': 97, 'dxcc_count': 3, 'book_name': 'N6CBL',
        })

    def test_omits_counts_qrz_did_not_report_rather_than_guessing_zero(self):
        fields, _ = fetch_qrz_logbook.parse_response(b'RESULT=OK&COUNT=163&CONFIRMED=')

        status = fetch_qrz_logbook.parse_book_status(fields)

        self.assertEqual(status, {'count': 163})
        self.assertNotIn('confirmed', status)

    def test_status_call_sends_no_fetch_option(self):
        sent = {}

        def fake_post(key, option=None, action='FETCH'):
            sent['key'], sent['option'], sent['action'] = key, option, action
            return b'RESULT=OK&COUNT=1&CONFIRMED=1'

        original_post = fetch_qrz_logbook.post_qrz_logbook
        fetch_qrz_logbook.post_qrz_logbook = fake_post
        try:
            status = fetch_qrz_logbook.fetch_book_status('key')
        finally:
            fetch_qrz_logbook.post_qrz_logbook = original_post

        self.assertEqual(sent, {'key': 'key', 'option': None, 'action': 'STATUS'})
        self.assertEqual(status['confirmed'], 1)

    def test_status_failure_is_reported_not_swallowed(self):
        def fake_post(_key, option=None, action='FETCH'):
            return b'RESULT=FAIL&REASON=invalid api key'

        original_post = fetch_qrz_logbook.post_qrz_logbook
        fetch_qrz_logbook.post_qrz_logbook = fake_post
        try:
            with self.assertRaises(RuntimeError):
                fetch_qrz_logbook.fetch_book_status('key')
        finally:
            fetch_qrz_logbook.post_qrz_logbook = original_post


if __name__ == '__main__':
    unittest.main()
