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


if __name__ == '__main__':
    unittest.main()
