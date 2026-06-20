# Browser Acoustic Probe Call

Minimal two-device WebRTC prototype for testing whether a controlled browser
audio path can carry an active high-band acoustic probe.

The verifier browser sends a short multi-tone probe through a WebRTC call. The
phone endpoint plays that audio, captures the acoustic return with its
microphone, sends the microphone stream back over WebRTC, and the verifier
records/scores the returned audio.

This is a controlled prototype. It does not claim that production Zoom, Teams,
WhatsApp, PSTN, or cellular paths preserve the probe by default.

## Signal Path

```text
Verifier PC browser
  -> Web Audio probe generator
  -> outgoing WebRTC audio track
  -> phone browser playback
  -> phone speaker
  -> air / device acoustics
  -> phone microphone
  -> returned WebRTC audio track
  -> verifier PC browser recorder
  -> peak-to-sideband detector
```

## Files

- `server.py`: static file server plus simple HTTP polling for WebRTC signaling.
- `index.html`, `call.js`, `styles.css`: browser app.
- `analyze_browser_probe_wav.py`: offline scorer for exported WAV/JSON files.
- `requirements.txt`: Python dependencies for offline scoring.

## Local Run

```powershell
python server.py --port 8765
```

Open on the verifier PC:

```text
http://127.0.0.1:8765/
```

The server binds to `127.0.0.1` by default. That is safest for localhost and
HTTPS tunnel testing.

## Same-LAN Phone Test

Plain `http://PC_IP:8765/` usually cannot use the phone microphone because phone
browsers require a secure context. For Android, the easiest local test is USB
debugging plus `adb reverse`:

```powershell
adb reverse tcp:8765 tcp:8765
```

Then open on the phone:

```text
http://127.0.0.1:8765/
```

## Outside-LAN Test

Use a temporary HTTPS tunnel to localhost. Do not open router ports.

```powershell
cloudflared tunnel --url http://127.0.0.1:8765
```

Open the generated `https://...trycloudflare.com` URL on the phone. Keep the
Cloudflare terminal open while testing; press `Ctrl+C` when done.

Safety notes:

- The tunnel is temporary.
- The server remains localhost-only.
- Anyone with the tunnel URL can open the prototype while it is running, so do
  not share the URL.
- Browser microphone access still requires explicit permission.

## Test Procedure

Use the same `Room ID` on both devices.

On the phone:

1. Select `Phone endpoint`.
2. Tap `Start phone microphone`.
3. Allow microphone permission.
4. Tap `Connect`.
5. Turn the phone volume up and keep the speaker/mic unobstructed.

On the verifier PC:

1. Select `Verifier PC`.
2. Click `Reset room` if reusing the same room after a failed or old run.
3. Click `Connect`.
4. Wait for the call state to become connected.
5. Click `Record return + send probe`.
6. Download the WAV and JSON.

The verifier PC microphone is optional. It is not needed for the basic
probe-return test.

## Offline Scoring

Install scorer dependencies:

```powershell
python -m pip install -r requirements.txt
```

Score an exported recording:

```powershell
python analyze_browser_probe_wav.py path\to\browser_call_probe.wav --metadata path\to\browser_call_probe.json
```

The scorer reports:

- sample rate and duration;
- per-set best one-second analysis window;
- per-tone peak-to-sideband scores;
- timed two-set pass/fail result.

## Default Probe

The default probe uses two one-second high-band tone sets:

- Set A: `6050, 6200, 6890 Hz`
- Set B: `5560, 5780, 6580 Hz`

Default amplitude is `0.08`. If the returned scores are weak and the phone
audio is not clipping or painfully loud, try `0.10`, `0.15`, or `0.20`.

Prior useful physical-route amplitudes from the larger research repo:

| Device / route | Amplitude |
| --- | ---: |
| Lenovo Yoga7 | `0.20` |
| Corsair Void Pro | `0.10` |
| Mi TW 2S | `0.50` |
| Samsung S23 AudioRelay | `0.20` |
| Sennheiser PXC 550-II | `0.15` |

## Metadata Export

The JSON sidecar records:

- timestamp, role, room, browser user agent;
- requested audio constraints;
- local microphone track settings;
- remote track state when exposed by the browser;
- WebRTC connection state and selected ICE candidate details when available;
- probe frequencies, amplitude, timing, and sample rate;
- browser-side peak-to-sideband analysis.

## Interpretation

Use cautious language:

- Good: controlled browser audio path.
- Good: custom no-suppression browser prototype.
- Good: feasibility test for a vendor-controlled client path.
- Avoid: claim that production meeting apps preserve the probe by default.
- Avoid: claim that this proves robustness across arbitrary codecs and devices.

If the JSON shows a selected ICE candidate type of `relay`, the media used TURN.
This prototype currently uses public STUN only, so most successful outside-LAN
runs will be peer-to-peer (`srflx`) rather than TURN-relayed.
