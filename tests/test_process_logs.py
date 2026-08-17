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


class QsoQrzUrlTests(unittest.TestCase):
    def test_links_the_worked_call_not_a_later_vanity(self):
        """QRZ's profile for KI5OWP now lives at K5WPI; the QSO is still KI5OWP."""
        self.assertEqual(
            process_logs.qso_qrz_url('KI5OWP'),
            'https://www.qrz.com/db/KI5OWP',
        )

    def test_ignores_a_cached_profile_url_for_a_different_call(self):
        self.assertNotEqual(
            process_logs.qso_qrz_url('KI5OWP'),
            'https://www.qrz.com/db/K5WPI',
        )


class ConfirmationTests(unittest.TestCase):
    def test_reads_qrz_confirmation_from_app_qrzlog_status(self):
        self.assertEqual(process_logs.qso_confirmed_by({'APP_QRZLOG_STATUS': 'C'}), ['qrz'])
        self.assertEqual(process_logs.qso_confirmed_by({'APP_QRZLOG_STATUS': 'N'}), [])

    def test_ignores_qrzcom_qso_download_status(self):
        """It reads as a confirmation flag and is not one.

        It is Y on every exported record — it records that the QSO came from
        QRZ, not that anyone confirmed it. Honouring it marked all 163 QSOs
        confirmed against QRZ's own count of 99.
        """
        qso = {'CALL': 'W1AW', 'QRZCOM_QSO_DOWNLOAD_STATUS': 'Y', 'QRZCOM_QSO_UPLOAD_STATUS': 'Y'}

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

    def test_book_mismatch_note_does_not_pick_a_winner(self):
        note = process_logs.qrz_book_mismatch_note(100, 99)

        self.assertIn('APP_QRZLOG_STATUS=C', note)
        self.assertIn('100', note)
        self.assertIn('99', note)
        self.assertEqual(process_logs.qrz_book_mismatch_note(99, 99), '')
        self.assertEqual(process_logs.qrz_book_mismatch_note(99, None), '')

    def test_field_report_counts_every_value_of_a_confirmation_shaped_field(self):
        raw = [
            {'CALL': 'W1AW', 'QRZCOM_QSO_DOWNLOAD_STATUS': 'Y', 'LOTW_QSL_RCVD': 'Y'},
            {'CALL': 'K1ZZ', 'QRZCOM_QSO_DOWNLOAD_STATUS': 'Y', 'LOTW_QSL_RCVD': 'N'},
            {'CALL': 'N0AA', 'QRZCOM_QSO_DOWNLOAD_STATUS': 'Y'},
        ]

        report = process_logs.confirmation_field_report(raw)

        # One value across every record is the signature of a field that is not
        # a confirmation; the run prints this so it is caught before the site.
        self.assertEqual(report['QRZCOM_QSO_DOWNLOAD_STATUS'], {'Y': 3})
        self.assertEqual(report['LOTW_QSL_RCVD'], {'Y': 1, 'N': 1})
        self.assertNotIn('CALL', report)


class AtlasSeasonTests(unittest.TestCase):
    def test_empty_book_says_so(self):
        atlas = process_logs.build_atlas_season([], [], {})
        self.assertEqual(atlas['plotted'], 0)
        self.assertIn('empty', atlas['paragraphs'][0].lower())

    def test_season_uses_parks_bands_and_skips_ungridded_hops(self):
        qsos = [
            {
                'date': '2026-03-17', 'call': 'W1AW', 'band': '20m', 'mode': 'SSB',
                'country': 'United States', 'gridsquare': 'FN31', 'lat': 41.5, 'lon': -72.7,
                'my_gridsquare': 'DM03SW', 'my_location': 'DM03SW, CA',
            },
            {
                'date': '2026-03-17', 'call': 'K7PGL/P', 'band': '20m', 'mode': 'SSB',
                'country': 'United States', 'my_gridsquare': 'DM03SW', 'my_location': 'DM03SW, CA',
            },
        ]
        sessions = [{'reference': 'US-3425', 'date': '2026-03-17'}]
        atlas = process_logs.build_atlas_season(qsos, sessions, {
            'bands': {'20m': 2}, 'modes': {'SSB': 2}, 'unique_calls': 2,
        })
        text = ' '.join(atlas['paragraphs'])
        self.assertEqual(atlas['plotted'], 1)
        self.assertEqual(atlas['unplotted'], 1)
        self.assertIn('US-3425', text)
        self.assertIn('20m', text)
        self.assertIn('not drawn', text)


if __name__ == '__main__':
    unittest.main()
