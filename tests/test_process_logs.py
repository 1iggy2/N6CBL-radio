import importlib.util
from pathlib import Path
import unittest

MODULE_PATH = Path(__file__).resolve().parents[1] / 'scripts' / 'process-logs.py'
spec = importlib.util.spec_from_file_location('process_logs', MODULE_PATH)
process_logs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(process_logs)


class QsoGroupKeyTests(unittest.TestCase):
    def test_groups_own_activation_by_my_park_ref(self):
        qso = {'QSO_DATE': '20260801', 'MY_SIG': 'POTA', 'MY_SIG_INFO': 'US-3425'}

        self.assertEqual(process_logs.qso_group_key(qso, 'fallback'), '2026-08-01-us-3425')

    def test_does_not_group_hunted_qso_by_the_other_stations_park(self):
        qso = {'QSO_DATE': '20260801', 'SIG': 'POTA', 'SIG_INFO': 'US-1001', 'POTA_REF': 'US-1001'}

        self.assertEqual(process_logs.qso_group_key(qso, 'fallback'), '2026-08-01')

    def test_groups_hunted_qsos_from_same_outing_by_my_gridsquare(self):
        first = {'QSO_DATE': '20260801', 'SIG': 'POTA', 'SIG_INFO': 'US-1001', 'MY_GRIDSQUARE': 'EN73'}
        second = {'QSO_DATE': '20260801', 'SIG': 'POTA', 'SIG_INFO': 'US-1721', 'MY_GRIDSQUARE': 'EN73'}

        self.assertEqual(
            process_logs.qso_group_key(first, 'fallback'),
            process_logs.qso_group_key(second, 'fallback'),
        )


if __name__ == '__main__':
    unittest.main()
