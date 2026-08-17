import importlib.util
from pathlib import Path
import unittest

MODULE_PATH = Path(__file__).resolve().parents[1] / 'scripts' / 'enrich-qrz.py'
spec = importlib.util.spec_from_file_location('enrich_qrz', MODULE_PATH)
enrich_qrz = importlib.util.module_from_spec(spec)
spec.loader.exec_module(enrich_qrz)


class PublicRecordTests(unittest.TestCase):
    def test_qrz_url_uses_the_looked_up_call_not_the_current_vanity(self):
        record = enrich_qrz.public_record(
            'KI5OWP',
            {'call': 'K5WPI', 'fname': 'Brian', 'name': 'Murphy'},
            '2026-08-17T00:00:00Z',
        )

        self.assertEqual(record['call'], 'K5WPI')
        self.assertEqual(record['qrz_url'], 'https://www.qrz.com/db/KI5OWP')


if __name__ == '__main__':
    unittest.main()
