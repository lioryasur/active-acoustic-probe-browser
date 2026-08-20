"""Score browser-prototype WAV exports with paper-style peak-to-sideband evidence.

The browser prototype writes a WAV and a JSON sidecar. This script reads those
artifacts and reports whether the two one-second three-tone sets are visible
under the same local spectral-anomaly shape used in the paper: peak within
+/-5 Hz minus the median of sidebands 100-500 Hz away.
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
from itertools import combinations
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from scipy.io import wavfile


DEFAULT_TONE_SETS = [
    {"name": "Set A", "frequencies_hz": [6050.0, 6200.0, 6890.0]},
    {"name": "Set B", "frequencies_hz": [5560.0, 5780.0, 6580.0]},
]

PEAK_SEARCH_HZ = 5.0
SIDE_BAND_MIN_HZ = 100.0
SIDE_BAND_MAX_HZ = 500.0
WINDOW_S = 1.0
HOP_S = 0.25
EPS = 1e-12


def read_wav(path: Path) -> tuple[int, np.ndarray]:
    sample_rate, data = wavfile.read(str(path))
    audio = np.asarray(data)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if np.issubdtype(audio.dtype, np.integer):
        scale = float(max(abs(np.iinfo(audio.dtype).min), np.iinfo(audio.dtype).max))
        audio = audio.astype(np.float64) / scale
    else:
        audio = audio.astype(np.float64)
    return int(sample_rate), audio


def load_metadata(path: Path | None) -> dict[str, Any] | None:
    if path is None:
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def parse_tone_sets_arg(value: str | None) -> list[dict[str, Any]] | None:
    if not value:
        return None
    sets: list[dict[str, Any]] = []
    for index, group in enumerate(value.split(";"), start=1):
        tones = [float(part.strip()) for part in group.split(",") if part.strip()]
        if len(tones) != 3:
            raise ValueError("--tones expects two semicolon-separated three-tone sets")
        sets.append({"name": f"Set {index}", "frequencies_hz": tones})
    if len(sets) != 2:
        raise ValueError("--tones expects exactly two sets, for example '6050,6200,6890;5560,5780,6580'")
    return sets


def tone_sets_from_metadata(metadata: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not metadata:
        return DEFAULT_TONE_SETS
    raw_sets = metadata.get("probe", {}).get("toneSets") or metadata.get("toneSets")
    if not raw_sets:
        return DEFAULT_TONE_SETS

    tone_sets: list[dict[str, Any]] = []
    for index, raw_set in enumerate(raw_sets, start=1):
        frequencies = raw_set.get("frequenciesHz") or raw_set.get("frequencies_hz") or raw_set.get("frequencies")
        if not frequencies:
            continue
        tone_sets.append(
            {
                "name": str(raw_set.get("name") or f"Set {index}"),
                "frequencies_hz": [float(freq) for freq in frequencies],
            }
        )
    return tone_sets or DEFAULT_TONE_SETS


def threshold_from_metadata(metadata: dict[str, Any] | None, fallback: float) -> float:
    if not metadata:
        return fallback
    threshold = metadata.get("analysis", {}).get("thresholdDb")
    if threshold is None:
        return fallback
    return float(threshold)


def values_between(freqs: np.ndarray, db: np.ndarray, low_hz: float, high_hz: float) -> np.ndarray:
    start = int(np.searchsorted(freqs, low_hz, side="left"))
    stop = int(np.searchsorted(freqs, high_hz, side="right"))
    return db[start:stop]


def tone_score(freqs: np.ndarray, db: np.ndarray, target_hz: float) -> dict[str, float]:
    peak_freqs = freqs[
        int(np.searchsorted(freqs, target_hz - PEAK_SEARCH_HZ, side="left")) : int(
            np.searchsorted(freqs, target_hz + PEAK_SEARCH_HZ, side="right")
        )
    ]
    peak_values = values_between(freqs, db, target_hz - PEAK_SEARCH_HZ, target_hz + PEAK_SEARCH_HZ)
    side_values = np.concatenate(
        [
            values_between(freqs, db, target_hz - SIDE_BAND_MAX_HZ, target_hz - SIDE_BAND_MIN_HZ),
            values_between(freqs, db, target_hz + SIDE_BAND_MIN_HZ, target_hz + SIDE_BAND_MAX_HZ),
        ]
    )
    if not len(peak_values) or not len(side_values):
        return {
            "target_hz": float(target_hz),
            "peak_hz": float("nan"),
            "peak_db": float("-inf"),
            "side_median_db": float("-inf"),
            "score_db": float("-inf"),
        }
    peak_index = int(np.argmax(peak_values))
    peak_db = float(peak_values[peak_index])
    side_median_db = float(np.median(side_values))
    return {
        "target_hz": float(target_hz),
        "peak_hz": float(peak_freqs[peak_index]) if len(peak_freqs) else float(target_hz),
        "peak_db": peak_db,
        "side_median_db": side_median_db,
        "score_db": float(peak_db - side_median_db),
    }


def second_highest(values: Iterable[float]) -> float:
    ordered = sorted((float(value) for value in values), reverse=True)
    return ordered[1] if len(ordered) >= 2 else (ordered[0] if ordered else float("-inf"))


def spectrum_windows(audio: np.ndarray, sample_rate: int, window_s: float, hop_s: float) -> list[dict[str, Any]]:
    window_n = int(round(window_s * sample_rate))
    hop_n = int(round(hop_s * sample_rate))
    if len(audio) < window_n:
        return []

    last_start = len(audio) - window_n
    starts = list(range(0, last_start + 1, hop_n))
    if starts[-1] != last_start:
        starts.append(last_start)
    windows: list[dict[str, Any]] = []
    for start in starts:
        segment = audio[start : start + window_n]
        tapered = segment * np.hanning(len(segment))
        magnitude = np.abs(np.fft.rfft(tapered)) + EPS
        db = 20.0 * np.log10(magnitude)
        freqs = np.fft.rfftfreq(len(segment), 1.0 / sample_rate)
        windows.append(
            {
                "start_sample": start,
                "start_s": start / sample_rate,
                "end_s": (start + window_n) / sample_rate,
                "freqs": freqs,
                "db": db,
            }
        )
    return windows


def score_set(
    windows: list[dict[str, Any]],
    tone_set: dict[str, Any],
    threshold_db: float,
) -> dict[str, Any]:
    scored_windows: list[dict[str, Any]] = []
    tones = [float(freq) for freq in tone_set["frequencies_hz"]]
    for window in windows:
        tone_rows = [tone_score(window["freqs"], window["db"], freq) for freq in tones]
        scores = [row["score_db"] for row in tone_rows]
        passing_tones = sum(score >= threshold_db for score in scores)
        scored_windows.append(
            {
                "start_s": float(window["start_s"]),
                "end_s": float(window["end_s"]),
                "tones": tone_rows,
                "set_score_db": second_highest(scores),
                "passing_tone_count": passing_tones,
                "pass": passing_tones >= 2,
            }
        )

    best = max(scored_windows, key=lambda row: row["set_score_db"])
    return {
        "name": str(tone_set["name"]),
        "frequencies_hz": tones,
        "best_window": best,
        "_scored_windows": scored_windows,
        "passing_windows": [
            {
                "start_s": row["start_s"],
                "end_s": row["end_s"],
                "set_score_db": row["set_score_db"],
                "passing_tone_count": row["passing_tone_count"],
            }
            for row in scored_windows
            if row["pass"]
        ],
    }


def select_best_ordered_windows(set_results: list[dict[str, Any]]) -> list[dict[str, Any]] | None:
    """Select ordered windows that maximize the weakest set score."""

    if not set_results:
        return None
    scored_sets = [result["_scored_windows"] for result in set_results]
    if len(scored_sets) == 1:
        return [max(scored_sets[0], key=lambda row: float(row["set_score_db"]))]
    frame_count = min(len(rows) for rows in scored_sets)
    if frame_count < len(scored_sets):
        return None

    best: list[dict[str, Any]] | None = None
    best_key: tuple[float, float, tuple[int, ...]] | None = None
    for indices in combinations(range(frame_count), len(scored_sets)):
        selected = [scored_sets[set_index][frame_index] for set_index, frame_index in enumerate(indices)]
        scores = [float(row["set_score_db"]) for row in selected]
        key = (min(scores), sum(scores), tuple(-index for index in indices))
        if best_key is None or key > best_key:
            best_key = key
            best = selected
    return best


def score_recording(
    audio: np.ndarray,
    sample_rate: int,
    tone_sets: list[dict[str, Any]],
    threshold_db: float,
    *,
    window_s: float,
    hop_s: float,
) -> dict[str, Any]:
    windows = spectrum_windows(audio, sample_rate, window_s, hop_s)
    if not windows:
        raise ValueError(f"Recording is shorter than the {window_s:g}s analysis window")

    set_results = [score_set(windows, tone_set, threshold_db) for tone_set in tone_sets]
    ordered_windows = select_best_ordered_windows(set_results)
    if ordered_windows is not None:
        for result, selected in zip(set_results, ordered_windows):
            result["best_window"] = selected
    timed_two_set_pass = ordered_windows is not None and all(bool(window["pass"]) for window in ordered_windows)
    timed_two_set_score_db = (
        min(float(window["set_score_db"]) for window in ordered_windows)
        if ordered_windows is not None
        else None
    )
    for result in set_results:
        result.pop("_scored_windows", None)
    all_scores = [
        tone["score_db"]
        for result in set_results
        for tone in result["best_window"]["tones"]
        if math.isfinite(float(tone["score_db"]))
    ]
    return {
        "sample_rate": sample_rate,
        "duration_s": len(audio) / float(sample_rate),
        "threshold_db": threshold_db,
        "parameters": {
            "window_s": window_s,
            "hop_s": hop_s,
            "peak_search_hz": PEAK_SEARCH_HZ,
            "sideband_min_hz": SIDE_BAND_MIN_HZ,
            "sideband_max_hz": SIDE_BAND_MAX_HZ,
        },
        "set_results": set_results,
        "timed_two_set_score_db": timed_two_set_score_db,
        "timed_two_set_pass": timed_two_set_pass,
        "median_best_tone_score_db": statistics.median(all_scores) if all_scores else None,
    }


def print_summary(result: dict[str, Any]) -> None:
    print(f"sample_rate={result['sample_rate']}")
    print(f"duration_s={result['duration_s']:.3f}")
    print(f"threshold_db={result['threshold_db']:.2f}")
    print(f"timed_two_set_pass={str(result['timed_two_set_pass']).lower()}")
    for set_result in result["set_results"]:
        best = set_result["best_window"]
        print(
            f"{set_result['name']}: score_db={best['set_score_db']:.2f} "
            f"passing_tones={best['passing_tone_count']}/3 "
            f"best_window={best['start_s']:.2f}-{best['end_s']:.2f}s"
        )
        for tone in best["tones"]:
            print(
                f"  tone={tone['target_hz']:.1f}Hz "
                f"peak={tone['peak_hz']:.1f}Hz "
                f"score_db={tone['score_db']:.2f} "
                f"side_median_db={tone['side_median_db']:.2f}"
            )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wav", type=Path, help="Browser-exported WAV file.")
    parser.add_argument("--metadata", type=Path, help="JSON sidecar exported by browser_probe.")
    parser.add_argument("--tones", help="Override tones, for example '6050,6200,6890;5560,5780,6580'.")
    parser.add_argument("--threshold-db", type=float, default=10.0)
    parser.add_argument("--window-s", type=float, default=WINDOW_S)
    parser.add_argument("--hop-s", type=float, default=HOP_S)
    parser.add_argument("--out-json", type=Path, help="Optional JSON output path for the full score record.")
    args = parser.parse_args()

    metadata = load_metadata(args.metadata)
    tone_sets = parse_tone_sets_arg(args.tones) or tone_sets_from_metadata(metadata)
    threshold_db = args.threshold_db
    if args.threshold_db == parser.get_default("threshold_db"):
        threshold_db = threshold_from_metadata(metadata, threshold_db)

    sample_rate, audio = read_wav(args.wav)
    result = score_recording(
        audio,
        sample_rate,
        tone_sets,
        threshold_db,
        window_s=args.window_s,
        hop_s=args.hop_s,
    )
    result["wav"] = str(args.wav)
    result["metadata"] = str(args.metadata) if args.metadata else None
    result["tone_sets"] = tone_sets

    print_summary(result)
    if args.out_json:
        args.out_json.parent.mkdir(parents=True, exist_ok=True)
        args.out_json.write_text(json.dumps(result, indent=2), encoding="utf-8")
        print(f"out_json={args.out_json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
