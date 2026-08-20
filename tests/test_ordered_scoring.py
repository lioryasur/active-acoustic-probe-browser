from __future__ import annotations

import unittest

import numpy as np

from analyze_browser_probe_wav import score_recording, spectrum_windows


class OrderedScoringTests(unittest.TestCase):
    def test_selects_best_valid_ordered_pair(self) -> None:
        sample_rate = 8_000
        tone_sets = [
            {"name": "Set A", "frequencies_hz": [1_000, 1_200, 1_400]},
            {"name": "Set B", "frequencies_hz": [1_800, 2_000, 2_200]},
        ]

        def tone_frame(frequencies: list[int], amplitude: float) -> np.ndarray:
            time = np.arange(sample_rate, dtype=np.float64) / sample_rate
            return sum(amplitude * np.sin(2 * np.pi * frequency * time) for frequency in frequencies) / len(frequencies)

        audio = np.concatenate(
            [
                tone_frame(tone_sets[0]["frequencies_hz"], 0.20),
                tone_frame(tone_sets[1]["frequencies_hz"], 0.50),
                tone_frame(tone_sets[0]["frequencies_hz"], 0.80),
                np.zeros(sample_rate, dtype=np.float64),
            ]
        )

        result = score_recording(
            audio,
            sample_rate,
            tone_sets,
            20,
            window_s=1.0,
            hop_s=1.0,
        )

        self.assertTrue(result["timed_two_set_pass"])
        self.assertEqual([row["best_window"]["start_s"] for row in result["set_results"]], [0.0, 1.0])

    def test_spectrum_windows_includes_unaligned_final_window(self) -> None:
        windows = spectrum_windows(np.zeros(2_100), sample_rate=1_000, window_s=1.0, hop_s=0.75)
        self.assertEqual([row["start_s"] for row in windows], [0.0, 0.75, 1.1])


if __name__ == "__main__":
    unittest.main()
