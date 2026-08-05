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


class OperatorPositionTests(unittest.TestCase):
    def test_uses_my_gridsquare_not_the_worked_stations_grid(self):
        qso = {'GRIDSQUARE': 'EN51UX', 'MY_GRIDSQUARE': 'EN66'}

        grid, lat, lon, source = process_logs.operator_position(qso)

        self.assertEqual(grid, 'EN66')
        self.assertEqual(source, 'adif')
        self.assertEqual((lat, lon), process_logs.maidenhead_to_latlon('EN66'))

    def test_falls_back_to_home_qth_when_no_operator_grid_logged(self):
        qso = {'GRIDSQUARE': 'EN51UX'}

        grid, lat, lon, source = process_logs.operator_position(qso)

        self.assertEqual(grid, process_logs.HOME_GRID)
        self.assertEqual(source, 'home')
        self.assertEqual((lat, lon), process_logs.maidenhead_to_latlon(process_logs.HOME_GRID))

    def test_falls_back_to_home_qth_when_operator_grid_is_unparseable(self):
        qso = {'MY_GRIDSQUARE': 'XX'}

        grid, _, _, source = process_logs.operator_position(qso)

        self.assertEqual(grid, process_logs.HOME_GRID)
        self.assertEqual(source, 'home')


class OperatorLocationTests(unittest.TestCase):
    def test_does_not_name_the_home_town_for_a_qso_made_elsewhere(self):
        """QRZ stamps the profile city on every QSO, including Michigan ones."""
        qso = {'MY_CITY': 'Hermosa Beach', 'MY_STATE': 'MI', 'MY_GRIDSQUARE': 'EN86AA'}

        state, label = process_logs.operator_location(qso)

        self.assertEqual(state, 'MI')
        self.assertEqual(label, 'EN86AA, MI')
        self.assertNotIn(process_logs.HOME_CITY, label)

    def test_names_the_town_for_a_grid_we_can_vouch_for(self):
        qso = {'MY_CITY': 'Hermosa Beach', 'MY_STATE': 'CA', 'MY_GRIDSQUARE': process_logs.HOME_GRID}

        _, label = process_logs.operator_location(qso)

        self.assertEqual(label, f'{process_logs.HOME_CITY}, {process_logs.HOME_STATE}')

    def test_falls_back_to_the_grid_square_for_an_unknown_grid(self):
        _, label = process_logs.operator_location({'MY_GRIDSQUARE': 'EN66'})

        self.assertEqual(label, 'EN66')

    def test_ignores_the_worked_stations_city_and_state(self):
        qso = {'CITY': 'Chicago', 'STATE': 'IL', 'MY_GRIDSQUARE': 'EN66'}

        state, label = process_logs.operator_location(qso)

        self.assertEqual(state, '')
        self.assertEqual(label, 'EN66')

    def test_names_the_home_qth_only_when_nothing_operator_side_is_logged(self):
        _, label = process_logs.operator_location({'GRIDSQUARE': 'FN42'})

        self.assertEqual(label, f'{process_logs.HOME_CITY}, {process_logs.HOME_STATE}')


class ConfirmationTests(unittest.TestCase):
    def test_reads_qrz_logbook_confirmation_status(self):
        qso = {'CALL': 'W1AW', 'APP_QRZLOG_STATUS': 'C'}

        self.assertEqual(process_logs.qso_confirmed_by(qso), ['qrz'])

    def test_unconfirmed_qrz_status_is_not_a_confirmation(self):
        qso = {'CALL': 'W1AW', 'APP_QRZLOG_STATUS': 'N'}

        self.assertEqual(process_logs.qso_confirmed_by(qso), [])

    def test_reads_lotw_eqsl_and_card_confirmations(self):
        qso = {'LOTW_QSL_RCVD': 'Y', 'EQSL_QSL_RCVD': 'V', 'QSL_RCVD': 'Y'}

        self.assertEqual(process_logs.qso_confirmed_by(qso), ['lotw', 'eqsl', 'card'])

    def test_requested_card_is_not_a_received_card(self):
        qso = {'QSL_RCVD': 'R', 'QSL_SENT': 'Y'}

        self.assertEqual(process_logs.qso_confirmed_by(qso), [])

    def test_does_not_infer_confirmation_from_the_stations_qrz_profile(self):
        """A station that uses LoTW has not thereby confirmed the contact."""
        qso = {'CALL': 'W1AW'}

        self.assertEqual(process_logs.qso_confirmed_by(qso), [])
        self.assertTrue(process_logs.qrz_flag({'lotw': '1'}, 'lotw'))

    def test_distinguishes_no_confirmation_from_no_confirmation_data(self):
        self.assertFalse(process_logs.carries_confirmation_fields({'CALL': 'W1AW'}))
        self.assertTrue(process_logs.carries_confirmation_fields({'APP_QRZLOG_STATUS': 'N'}))
        self.assertTrue(process_logs.carries_confirmation_fields({'QSL_RCVD': 'N'}))


if __name__ == '__main__':
    unittest.main()
