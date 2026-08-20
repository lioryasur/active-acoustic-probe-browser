# Standalone Repository Checklist

Use this when splitting `browser_probe/` out of the research repository.

## Files To Copy

Copy the contents of `browser_probe/` into the new repository root:

- `.gitignore`
- `CITATION.cff`
- `LICENSE`
- `README.md`
- `requirements.txt`
- `server.py`
- `index.html`
- `call.js`
- `styles.css`
- `analyze_browser_probe_wav.py`
- `tests/test_ordered_scoring.py`

Do not copy generated WAV/JSON exports or `__pycache__/`.

## First Commit

```powershell
git init
git add .
git commit -m "Add browser acoustic probe call prototype"
```

## Smoke Checks

```powershell
python -m py_compile server.py analyze_browser_probe_wav.py
node --check call.js
python -m unittest discover -s tests
python server.py --port 8765
```

Then open:

```text
http://127.0.0.1:8765/
```

## Suggested Repository Description

Minimal two-device WebRTC prototype for testing whether a controlled browser
audio path can preserve high-band active acoustic probes.

## Suggested Caution In Project Summary

This repository demonstrates a custom browser/WebRTC test path. It does not
claim that production VoIP platforms preserve high-band probes by default.
