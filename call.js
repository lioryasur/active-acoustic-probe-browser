"use strict";

const REQUESTED_AUDIO_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: { ideal: 1 },
  sampleRate: { ideal: 48000 },
};

const PROBE_PROFILE = {
  name: "random_count_rule_trial_01_two_set_call",
  source: "chirp_app.chirp.RANDOM_COUNT_RULE_CHIRP_SETS[0:2]",
  frequencyRangeHz: [5500, 7000],
  setDurationS: 1.0,
  fadeS: 0.01,
};

const ANALYSIS_DEFAULTS = {
  peakSearchHz: 5,
  sidebandMinHz: 100,
  sidebandMaxHz: 500,
  sidebandStepHz: 25,
  windowS: 1.0,
  hopS: 0.25,
};

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

const dom = {
  status: document.querySelector("#status"),
  roomInput: document.querySelector("#roomInput"),
  roleSelect: document.querySelector("#roleSelect"),
  startMicButton: document.querySelector("#startMicButton"),
  resetRoomButton: document.querySelector("#resetRoomButton"),
  connectButton: document.querySelector("#connectButton"),
  resyncButton: document.querySelector("#resyncButton"),
  hangupButton: document.querySelector("#hangupButton"),
  recordRemoteProbeButton: document.querySelector("#recordRemoteProbeButton"),
  downloadWavButton: document.querySelector("#downloadWavButton"),
  downloadMetadataButton: document.querySelector("#downloadMetadataButton"),
  amplitudeInput: document.querySelector("#amplitudeInput"),
  recordDurationInput: document.querySelector("#recordDurationInput"),
  autoplayOffsetInput: document.querySelector("#autoplayOffsetInput"),
  thresholdInput: document.querySelector("#thresholdInput"),
  setAInput: document.querySelector("#setAInput"),
  setBInput: document.querySelector("#setBInput"),
  constraintsOutput: document.querySelector("#constraintsOutput"),
  settingsOutput: document.querySelector("#settingsOutput"),
  callStateOutput: document.querySelector("#callStateOutput"),
  remoteAudio: document.querySelector("#remoteAudio"),
  evidenceCanvas: document.querySelector("#evidenceCanvas"),
  evidenceOutput: document.querySelector("#evidenceOutput"),
  metadataOutput: document.querySelector("#metadataOutput"),
};

const state = {
  peerId: `peer-${Math.random().toString(36).slice(2, 10)}`,
  room: "probe-room",
  role: "verifier",
  audioContext: null,
  micStream: null,
  micSource: null,
  peerConnection: null,
  polling: false,
  pollAfterId: 0,
  remoteStream: null,
  callDestination: null,
  callProbeGain: null,
  outgoingStream: null,
  probeEvents: [],
  recordedSamples: null,
  recordedSampleRate: null,
  wavBlob: null,
  metadataBlob: null,
  metadata: null,
  analysis: null,
  signalCounts: {},
};

function safeJson(value) {
  return JSON.stringify(value, null, 2);
}

function cloneForJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function setStatus(message, kind = "") {
  dom.status.textContent = message;
  dom.status.className = `status ${kind}`.trim();
  publishDebugState();
}

function getNumberInput(input, fallback) {
  const value = Number(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function parseToneInput(value) {
  const tones = value
    .split(/[,\s]+/)
    .map((part) => Number(part.trim()))
    .filter((freq) => Number.isFinite(freq));
  if (tones.length !== 3) {
    throw new Error("Each set must contain exactly three tone frequencies.");
  }
  return tones;
}

function getToneSetsFromUi() {
  return [
    { name: "Set A", startS: 0.0, durationS: PROBE_PROFILE.setDurationS, frequenciesHz: parseToneInput(dom.setAInput.value) },
    {
      name: "Set B",
      startS: PROBE_PROFILE.setDurationS,
      durationS: PROBE_PROFILE.setDurationS,
      frequenciesHz: parseToneInput(dom.setBInput.value),
    },
  ];
}

function getProbeDurationS(toneSets) {
  return Math.max(...toneSets.map((set) => set.startS + set.durationS));
}

function ensureAudioContext() {
  if (!state.audioContext) {
    const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) {
      throw new Error("This browser does not expose the Web Audio API AudioContext.");
    }
    state.audioContext = new AudioContextConstructor();
  }
  return state.audioContext;
}

async function apiGet(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function apiPost(path, body = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

function cleanRoomName() {
  const room = dom.roomInput.value.trim() || "probe-room";
  return room.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

async function sendSignal(payload) {
  state.signalCounts[`sent_${payload.type || "unknown"}`] = (state.signalCounts[`sent_${payload.type || "unknown"}`] || 0) + 1;
  await apiPost(`/api/rooms/${encodeURIComponent(state.room)}/messages`, {
    from: state.peerId,
    payload,
  });
}

async function startPolling() {
  if (state.polling) {
    return;
  }
  state.polling = true;
  while (state.polling) {
    try {
      const data = await apiGet(`/api/rooms/${encodeURIComponent(state.room)}/messages?after=${state.pollAfterId}`);
      for (const message of data.messages || []) {
        state.pollAfterId = Math.max(state.pollAfterId, Number(message.id));
        if (message.from !== state.peerId) {
          const type = message.payload?.type || "unknown";
          state.signalCounts[`received_${type}`] = (state.signalCounts[`received_${type}`] || 0) + 1;
          await handleSignal(message.payload, message.from);
        }
      }
      updateCallState();
      await sleep(350);
    } catch (error) {
      setStatus(`Signaling poll failed: ${error.message}`, "warn");
      await sleep(1000);
    }
  }
}

async function handleSignal(payload, fromPeer) {
  if (!state.peerConnection) {
    return;
  }
  if (payload.type === "offer" && state.role === "endpoint") {
    await state.peerConnection.setRemoteDescription(payload.description);
    const answer = await state.peerConnection.createAnswer();
    await state.peerConnection.setLocalDescription(answer);
    await sendSignal({ type: "answer", description: state.peerConnection.localDescription });
    setStatus(`Answered verifier ${fromPeer}.`, "ok");
  } else if (payload.type === "answer" && state.role === "verifier") {
    if (state.peerConnection.signalingState === "stable") {
      setStatus(`Already applied answer from ${fromPeer}; waiting for media connection.`, "ok");
      return;
    }
    await state.peerConnection.setRemoteDescription(payload.description);
    setStatus(`Applied answer from ${fromPeer}; waiting for media connection.`, "ok");
  } else if (payload.type === "candidate" && payload.candidate) {
    try {
      await state.peerConnection.addIceCandidate(payload.candidate);
    } catch (error) {
      console.warn("Could not add ICE candidate", error);
    }
  } else if (payload.type === "probe-event") {
    setStatus(`Remote probe event: ${payload.timestamp || "received"}.`, "ok");
  }
}

async function startMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not expose navigator.mediaDevices.getUserMedia.");
  }
  const audioContext = ensureAudioContext();
  await audioContext.resume();
  state.micStream = await navigator.mediaDevices.getUserMedia({
    audio: cloneForJson(REQUESTED_AUDIO_CONSTRAINTS),
    video: false,
  });
  state.micSource = audioContext.createMediaStreamSource(state.micStream);
  dom.connectButton.disabled = false;
  updateTrackSettings();
  setStatus("Microphone active with requested no-suppression constraints.", "ok");
}

function updateTrackSettings() {
  const track = state.micStream?.getAudioTracks()[0] || null;
  dom.settingsOutput.textContent = safeJson({
    peerId: state.peerId,
    label: track?.label || null,
    enabled: track?.enabled || false,
    readyState: track?.readyState || null,
    settings: track?.getSettings ? track.getSettings() : null,
    appliedConstraints: track?.getConstraints ? track.getConstraints() : null,
  });
}

function createProbeBuffer(audioContext, toneSets, amplitude) {
  const sampleRate = audioContext.sampleRate;
  const durationS = getProbeDurationS(toneSets);
  const frameCount = Math.ceil(durationS * sampleRate);
  const buffer = audioContext.createBuffer(1, frameCount, sampleRate);
  const samples = buffer.getChannelData(0);
  const fadeSamples = Math.max(1, Math.round(PROBE_PROFILE.fadeS * sampleRate));

  for (const toneSet of toneSets) {
    const startSample = Math.round(toneSet.startS * sampleRate);
    const durationSamples = Math.round(toneSet.durationS * sampleRate);
    const componentAmplitude = amplitude / toneSet.frequenciesHz.length;
    for (let i = 0; i < durationSamples && startSample + i < samples.length; i += 1) {
      const t = i / sampleRate;
      let fade = 1;
      if (i < fadeSamples) {
        fade = i / fadeSamples;
      } else if (durationSamples - i < fadeSamples) {
        fade = Math.max(0, (durationSamples - i) / fadeSamples);
      }
      for (const freq of toneSet.frequenciesHz) {
        samples[startSample + i] += componentAmplitude * fade * Math.sin(2 * Math.PI * freq * t);
      }
    }
  }

  return buffer;
}

function makeVerifierOutgoingStream() {
  const audioContext = ensureAudioContext();
  state.callDestination = audioContext.createMediaStreamDestination();
  state.callProbeGain = audioContext.createGain();
  state.callProbeGain.gain.value = 1;
  state.callProbeGain.connect(state.callDestination);

  if (state.micSource) {
    const micGain = audioContext.createGain();
    micGain.gain.value = 1;
    state.micSource.connect(micGain);
    micGain.connect(state.callDestination);
  }

  state.outgoingStream = state.callDestination.stream;
  return state.outgoingStream;
}

async function connectRole() {
  state.room = cleanRoomName();
  state.role = dom.roleSelect.value;

  if (state.role === "endpoint" && !state.micStream) {
    await startMicrophone();
  }
  state.pollAfterId = 0;

  const pc = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    iceTransportPolicy: "all",
  });
  state.peerConnection = pc;
  state.remoteStream = new MediaStream();
  dom.remoteAudio.srcObject = state.remoteStream;
  dom.remoteAudio.muted = state.role === "verifier";

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      sendSignal({ type: "candidate", candidate: event.candidate }).catch(console.error);
    }
  };
  pc.onconnectionstatechange = () => {
    updateCallState();
    if (pc.connectionState === "connected") {
      setStatus("WebRTC connected.", "ok");
    } else if (["failed", "disconnected"].includes(pc.connectionState)) {
      setStatus(`WebRTC ${pc.connectionState}.`, "warn");
    }
  };
  pc.oniceconnectionstatechange = () => {
    updateCallState();
    if (["connected", "completed"].includes(pc.iceConnectionState)) {
      setStatus("ICE connected; media path is ready.", "ok");
    } else if (["failed", "disconnected"].includes(pc.iceConnectionState)) {
      setStatus(`ICE ${pc.iceConnectionState}.`, "warn");
    }
  };
  pc.ontrack = (event) => {
    for (const track of event.streams[0].getAudioTracks()) {
      state.remoteStream.addTrack(track);
    }
    dom.recordRemoteProbeButton.disabled = state.role !== "verifier";
    dom.remoteAudio.play().catch(() => {
      setStatus("Remote audio is ready; tap play if the browser blocked autoplay.", "warn");
    });
    updateCallState();
  };

  const outgoingStream = state.role === "verifier" ? makeVerifierOutgoingStream() : state.micStream;
  for (const track of outgoingStream.getAudioTracks()) {
    pc.addTrack(track, outgoingStream);
  }

  state.polling = false;
  await sleep(50);
  startPolling();

  if (state.role === "verifier") {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await sendSignal({ type: "offer", description: pc.localDescription });
    setStatus(`Verifier offer sent in room ${state.room}.`, "ok");
  } else {
    setStatus(`Phone endpoint waiting in room ${state.room}.`, "ok");
  }

  dom.connectButton.disabled = true;
  dom.resyncButton.disabled = false;
  dom.hangupButton.disabled = false;
  updateCallState();
}

async function resyncSignaling() {
  if (!state.peerConnection) {
    throw new Error("Connect first, then resync.");
  }
  state.pollAfterId = 0;
  await startPolling();
  setStatus(`Resyncing room ${state.room} from the beginning.`, "ok");
}

async function resetRoom() {
  state.room = cleanRoomName();
  await apiPost(`/api/rooms/${encodeURIComponent(state.room)}/reset`, {});
  state.pollAfterId = 0;
  setStatus(`Room ${state.room} reset.`, "ok");
}

function hangUp() {
  state.polling = false;
  state.peerConnection?.close();
  state.peerConnection = null;
  state.remoteStream = null;
  dom.remoteAudio.srcObject = null;
  dom.connectButton.disabled = false;
  dom.resyncButton.disabled = true;
  dom.hangupButton.disabled = true;
  dom.recordRemoteProbeButton.disabled = true;
  setStatus("Call ended.", "warn");
  updateCallState();
}

async function sendProbeOverCall() {
  if (state.role !== "verifier") {
    throw new Error("Only the verifier sends the probe.");
  }
  if (!state.callProbeGain) {
    throw new Error("Connect as verifier before sending a probe.");
  }
  const audioContext = ensureAudioContext();
  await audioContext.resume();
  const toneSets = getToneSetsFromUi();
  const amplitude = getNumberInput(dom.amplitudeInput, 0.08);
  const source = audioContext.createBufferSource();
  source.buffer = createProbeBuffer(audioContext, toneSets, amplitude);
  source.connect(state.callProbeGain);
  const event = {
    timestamp: new Date().toISOString(),
    audioContextTimeS: audioContext.currentTime,
    performanceTimeMs: performance.now(),
    toneSets,
    amplitude,
    durationS: source.buffer.duration,
    transport: "webrtc_outgoing_mix",
  };
  state.probeEvents.push(event);
  source.start();
  await sendSignal({ type: "probe-event", timestamp: event.timestamp, durationS: event.durationS });
  setStatus(`Sent ${event.durationS.toFixed(2)} s probe over call.`, "ok");
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function mergeFloat32Chunks(chunks, totalLength) {
  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function floatTo16BitPcm(view, offset, samples) {
  for (let i = 0; i < samples.length; i += 1, offset += 2) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
}

function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  floatTo16BitPcm(view, 44, samples);
  return new Blob([view], { type: "audio/wav" });
}

async function recordRemote({ alsoSendProbe = false } = {}) {
  if (state.role !== "verifier") {
    throw new Error("Record the returned phone audio on the verifier PC.");
  }
  if (!state.remoteStream || state.remoteStream.getAudioTracks().length === 0) {
    throw new Error("No remote phone audio stream is available yet.");
  }

  const audioContext = ensureAudioContext();
  await audioContext.resume();
  const durationS = Math.max(1, getNumberInput(dom.recordDurationInput, 3.5));
  const offsetS = Math.max(0, getNumberInput(dom.autoplayOffsetInput, 0.75));
  const source = audioContext.createMediaStreamSource(state.remoteStream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const silent = audioContext.createGain();
  silent.gain.value = 0;
  const chunks = [];
  let totalLength = 0;
  const recordStart = {
    timestamp: new Date().toISOString(),
    audioContextTimeS: audioContext.currentTime,
    performanceTimeMs: performance.now(),
  };

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
    totalLength += input.length;
  };
  source.connect(processor);
  processor.connect(silent);
  silent.connect(audioContext.destination);

  setStatus(`Recording remote phone audio for ${durationS.toFixed(2)} s...`, "warn");
  let probePromise = Promise.resolve();
  if (alsoSendProbe) {
    probePromise = sleep(offsetS * 1000).then(() => sendProbeOverCall());
  }
  await Promise.all([sleep(durationS * 1000), probePromise]);

  processor.disconnect();
  source.disconnect();
  silent.disconnect();
  processor.onaudioprocess = null;

  state.recordedSampleRate = audioContext.sampleRate;
  state.recordedSamples = mergeFloat32Chunks(chunks, totalLength);
  state.wavBlob = encodeWav(state.recordedSamples, state.recordedSampleRate);
  state.analysis = analyzeRecording(
    state.recordedSamples,
    state.recordedSampleRate,
    getToneSetsFromUi(),
    getNumberInput(dom.thresholdInput, 10),
  );
  const webRtcStats = await collectSelectedCandidateStats();
  state.metadata = buildMetadata(recordStart, durationS, webRtcStats);
  state.metadataBlob = new Blob([safeJson(state.metadata)], { type: "application/json" });
  dom.downloadWavButton.disabled = false;
  dom.downloadMetadataButton.disabled = false;
  renderEvidence(state.analysis);
  renderMetadata();
  setStatus(`Recorded remote stream: ${state.recordedSamples.length} samples at ${state.recordedSampleRate} Hz.`, "ok");
}

async function collectSelectedCandidateStats() {
  if (!state.peerConnection?.getStats) {
    return null;
  }
  const stats = await state.peerConnection.getStats();
  let selectedPair = null;
  let localCandidate = null;
  let remoteCandidate = null;

  for (const report of stats.values()) {
    if (report.type === "transport" && report.selectedCandidatePairId) {
      selectedPair = stats.get(report.selectedCandidatePairId);
      break;
    }
  }
  if (!selectedPair) {
    for (const report of stats.values()) {
      if (report.type === "candidate-pair" && report.state === "succeeded" && report.nominated) {
        selectedPair = report;
        break;
      }
    }
  }
  if (selectedPair) {
    localCandidate = stats.get(selectedPair.localCandidateId) || null;
    remoteCandidate = stats.get(selectedPair.remoteCandidateId) || null;
  }

  const candidateProjection = (candidate) =>
    candidate
      ? {
          id: candidate.id,
          candidateType: candidate.candidateType,
          protocol: candidate.protocol,
          address: candidate.address || candidate.ip || null,
          port: candidate.port || null,
          networkType: candidate.networkType || null,
          relayProtocol: candidate.relayProtocol || null,
        }
      : null;

  return {
    selectedPair: selectedPair
      ? {
          id: selectedPair.id,
          state: selectedPair.state,
          nominated: Boolean(selectedPair.nominated),
          currentRoundTripTime: selectedPair.currentRoundTripTime ?? null,
          availableOutgoingBitrate: selectedPair.availableOutgoingBitrate ?? null,
          bytesSent: selectedPair.bytesSent ?? null,
          bytesReceived: selectedPair.bytesReceived ?? null,
        }
      : null,
    localCandidate: candidateProjection(localCandidate),
    remoteCandidate: candidateProjection(remoteCandidate),
  };
}

function buildMetadata(recordStart, requestedDurationS, webRtcStats) {
  const localTrack = state.micStream?.getAudioTracks()[0] || null;
  const remoteTrack = state.remoteStream?.getAudioTracks()[0] || null;
  const timestamp = recordStart.timestamp.replace(/[:.]/g, "-");
  const probeEventsDuringRecording = state.probeEvents
    .filter((event) => event.performanceTimeMs >= recordStart.performanceTimeMs)
    .map((event) => ({
      ...event,
      offsetFromRecordStartS: (event.performanceTimeMs - recordStart.performanceTimeMs) / 1000,
    }));

  return {
    prototype: "two-device custom no-suppression browser call",
    paperFrame: "controlled browser audio path; not equivalent to production Zoom/Teams/WhatsApp",
    exportId: `browser_call_probe_${timestamp}`,
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent,
    peerId: state.peerId,
    role: state.role,
    room: state.room,
    requestedAudioConstraints: { audio: cloneForJson(REQUESTED_AUDIO_CONSTRAINTS), video: false },
    supportedAudioConstraints: navigator.mediaDevices?.getSupportedConstraints?.() || {},
    localTrack: {
      label: localTrack?.label || null,
      readyState: localTrack?.readyState || null,
      settings: localTrack?.getSettings ? localTrack.getSettings() : null,
      appliedConstraints: localTrack?.getConstraints ? localTrack.getConstraints() : null,
    },
    remoteTrack: {
      label: remoteTrack?.label || null,
      readyState: remoteTrack?.readyState || null,
      settings: remoteTrack?.getSettings ? remoteTrack.getSettings() : null,
    },
    peerConnection: {
      connectionState: state.peerConnection?.connectionState || null,
      iceConnectionState: state.peerConnection?.iceConnectionState || null,
      signalingState: state.peerConnection?.signalingState || null,
      iceServers: cloneForJson(ICE_SERVERS),
      iceTransportPolicy: "all",
      selectedCandidateStats: webRtcStats,
    },
    audioContext: {
      sampleRate: state.audioContext?.sampleRate || null,
      baseLatency: state.audioContext?.baseLatency ?? null,
      outputLatency: state.audioContext?.outputLatency ?? null,
    },
    probe: {
      profile: PROBE_PROFILE.name,
      source: PROBE_PROFILE.source,
      frequencyRangeHz: PROBE_PROFILE.frequencyRangeHz,
      toneSets: getToneSetsFromUi(),
      amplitude: getNumberInput(dom.amplitudeInput, 0.08),
      setDurationS: PROBE_PROFILE.setDurationS,
      totalDurationS: getProbeDurationS(getToneSetsFromUi()),
      fadeS: PROBE_PROFILE.fadeS,
      transport: "verifier Web Audio mix into outgoing WebRTC audio track",
      probeEventsDuringRecording,
    },
    recording: {
      source: "remote phone microphone stream received by verifier",
      requestedDurationS,
      sampleRate: state.recordedSampleRate,
      channelCount: 1,
      sampleCount: state.recordedSamples?.length || 0,
      durationS: state.recordedSamples ? state.recordedSamples.length / state.recordedSampleRate : 0,
      wavEncoding: "PCM_16LE_mono",
      recordStart,
    },
    analysis: state.analysis,
  };
}

function goertzelPower(samples, start, length, sampleRate, frequencyHz) {
  const omega = (2 * Math.PI * frequencyHz) / sampleRate;
  const coeff = 2 * Math.cos(omega);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < length; i += 1) {
    const windowValue = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, length - 1));
    s0 = samples[start + i] * windowValue + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.max(1e-24, s1 * s1 + s2 * s2 - coeff * s1 * s2);
}

function dbFromPower(power) {
  return 10 * Math.log10(Math.max(1e-24, power));
}

function median(values) {
  if (!values.length) {
    return Number.NEGATIVE_INFINITY;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function secondHighest(values) {
  const sorted = [...values].sort((a, b) => b - a);
  return sorted.length > 1 ? sorted[1] : sorted[0] ?? Number.NEGATIVE_INFINITY;
}

function scoreTone(samples, start, length, sampleRate, targetHz) {
  const peakCandidates = [];
  for (let offset = -ANALYSIS_DEFAULTS.peakSearchHz; offset <= ANALYSIS_DEFAULTS.peakSearchHz; offset += 1) {
    const freq = targetHz + offset;
    if (freq > 0 && freq < sampleRate / 2) {
      peakCandidates.push({
        freq,
        db: dbFromPower(goertzelPower(samples, start, length, sampleRate, freq)),
      });
    }
  }
  const sideDb = [];
  for (
    let distance = ANALYSIS_DEFAULTS.sidebandMinHz;
    distance <= ANALYSIS_DEFAULTS.sidebandMaxHz;
    distance += ANALYSIS_DEFAULTS.sidebandStepHz
  ) {
    for (const sign of [-1, 1]) {
      const freq = targetHz + sign * distance;
      if (freq > 0 && freq < sampleRate / 2) {
        sideDb.push(dbFromPower(goertzelPower(samples, start, length, sampleRate, freq)));
      }
    }
  }
  const peak = peakCandidates.reduce((best, row) => (row.db > best.db ? row : best), {
    freq: targetHz,
    db: Number.NEGATIVE_INFINITY,
  });
  const sideMedianDb = median(sideDb);
  return {
    targetHz,
    peakHz: peak.freq,
    peakDb: peak.db,
    sideMedianDb,
    scoreDb: peak.db - sideMedianDb,
  };
}

function analyzeRecording(samples, sampleRate, toneSets, thresholdDb) {
  const windowLength = Math.round(ANALYSIS_DEFAULTS.windowS * sampleRate);
  const hopLength = Math.round(ANALYSIS_DEFAULTS.hopS * sampleRate);
  if (samples.length < Math.max(256, windowLength)) {
    return { error: "Recording is shorter than the analysis window." };
  }
  const windows = [];
  for (let start = 0; start + windowLength <= samples.length; start += hopLength) {
    windows.push({ start, startS: start / sampleRate });
  }
  const setResults = toneSets.map((toneSet) => {
    const scoredWindows = windows.map((window) => {
      const tones = toneSet.frequenciesHz.map((freq) => scoreTone(samples, window.start, windowLength, sampleRate, freq));
      const scores = tones.map((tone) => tone.scoreDb);
      const passingToneCount = scores.filter((score) => score >= thresholdDb).length;
      return {
        startS: window.startS,
        endS: window.startS + ANALYSIS_DEFAULTS.windowS,
        tones,
        setScoreDb: secondHighest(scores),
        passingToneCount,
        pass: passingToneCount >= 2,
      };
    });
    const bestWindow = scoredWindows.reduce((best, row) => (row.setScoreDb > best.setScoreDb ? row : best), scoredWindows[0]);
    return {
      name: toneSet.name,
      frequenciesHz: toneSet.frequenciesHz,
      bestWindow,
      passingWindows: scoredWindows.filter((window) => window.pass).map((window) => ({
        startS: window.startS,
        endS: window.endS,
        setScoreDb: window.setScoreDb,
        passingToneCount: window.passingToneCount,
      })),
    };
  });
  const firstSetPasses = setResults[0]?.passingWindows || [];
  const secondSetPasses = setResults[1]?.passingWindows || [];
  const timedTwoSetPass = firstSetPasses.some((aWindow) =>
    secondSetPasses.some((bWindow) => bWindow.startS > aWindow.startS),
  );
  return {
    thresholdDb,
    parameters: cloneForJson(ANALYSIS_DEFAULTS),
    sampleRate,
    durationS: samples.length / sampleRate,
    setResults,
    timedTwoSetPass,
  };
}

function renderEvidence(analysis) {
  if (!analysis || analysis.error) {
    dom.evidenceOutput.textContent = analysis?.error || "No evidence available.";
    return;
  }
  const rows = [];
  for (const result of analysis.setResults) {
    for (const tone of result.bestWindow.tones) {
      const pass = tone.scoreDb >= analysis.thresholdDb;
      rows.push(`
        <tr>
          <td>${result.name}</td>
          <td>${tone.targetHz.toFixed(0)}</td>
          <td>${tone.peakHz.toFixed(1)}</td>
          <td>${tone.scoreDb.toFixed(1)}</td>
          <td>${result.bestWindow.startS.toFixed(2)}-${result.bestWindow.endS.toFixed(2)}</td>
          <td class="${pass ? "pass" : "fail"}">${pass ? "pass" : "fail"}</td>
        </tr>
      `);
    }
  }
  const setSummary = analysis.setResults
    .map((result) => {
      const best = result.bestWindow;
      return `${result.name}: ${best.passingToneCount}/3 tones, score ${best.setScoreDb.toFixed(1)} dB`;
    })
    .join(" | ");
  dom.evidenceOutput.innerHTML = `
    <p><strong>Timed two-set result:</strong>
      <span class="${analysis.timedTwoSetPass ? "pass" : "fail"}">${analysis.timedTwoSetPass ? "pass" : "fail"}</span>
      at ${analysis.thresholdDb.toFixed(1)} dB. ${setSummary}
    </p>
    <table>
      <thead>
        <tr>
          <th>Set</th>
          <th>Target Hz</th>
          <th>Peak Hz</th>
          <th>Score dB</th>
          <th>Best window s</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>${rows.join("")}</tbody>
    </table>
  `;
  drawEvidenceChart(analysis);
}

function drawEvidenceChart(analysis) {
  const canvas = dom.evidenceCanvas;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fbfcfd";
  ctx.fillRect(0, 0, width, height);
  const tones = (analysis?.setResults || []).flatMap((result) =>
    result.bestWindow.tones.map((tone) => ({ label: `${result.name} ${tone.targetHz.toFixed(0)}`, score: tone.scoreDb })),
  );
  if (!tones.length) {
    ctx.fillStyle = "#5c6877";
    ctx.fillText("Record remote phone audio to see peak-to-sideband evidence.", 24, 36);
    return;
  }
  const maxScore = Math.max(analysis.thresholdDb + 5, ...tones.map((tone) => tone.score), 20);
  const minScore = Math.min(0, ...tones.map((tone) => tone.score));
  const top = 24;
  const bottom = height - 44;
  const left = 42;
  const right = width - 16;
  const chartHeight = bottom - top;
  const chartWidth = right - left;
  const yFor = (score) => bottom - ((score - minScore) / Math.max(1, maxScore - minScore)) * chartHeight;
  ctx.strokeStyle = "#d8e0e8";
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(left, bottom);
  ctx.lineTo(right, bottom);
  ctx.stroke();
  const thresholdY = yFor(analysis.thresholdDb);
  ctx.strokeStyle = "#9b5b00";
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(left, thresholdY);
  ctx.lineTo(right, thresholdY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#9b5b00";
  ctx.fillText(`threshold ${analysis.thresholdDb.toFixed(1)} dB`, left + 6, thresholdY - 6);
  const gap = 12;
  const barWidth = Math.max(18, (chartWidth - gap * (tones.length - 1)) / tones.length);
  tones.forEach((tone, index) => {
    const x = left + index * (barWidth + gap);
    const y = yFor(tone.score);
    ctx.fillStyle = tone.score >= analysis.thresholdDb ? "#1f6f3a" : "#a33131";
    ctx.fillRect(x, y, barWidth, bottom - y);
    ctx.save();
    ctx.translate(x + barWidth / 2, bottom + 8);
    ctx.rotate(-Math.PI / 6);
    ctx.fillStyle = "#334155";
    ctx.textAlign = "right";
    ctx.fillText(tone.label, 0, 0);
    ctx.restore();
  });
}

function updateCallState() {
  dom.callStateOutput.textContent = safeJson({
    peerId: state.peerId,
    role: state.role,
    room: state.room,
    polling: state.polling,
    pollAfterId: state.pollAfterId,
    signalCounts: state.signalCounts,
    iceServers: ICE_SERVERS,
    connectionState: state.peerConnection?.connectionState || null,
    iceConnectionState: state.peerConnection?.iceConnectionState || null,
    signalingState: state.peerConnection?.signalingState || null,
    localTracks: state.micStream?.getAudioTracks().map((track) => ({
      label: track.label,
      readyState: track.readyState,
      enabled: track.enabled,
    })) || [],
    remoteTracks: state.remoteStream?.getAudioTracks().map((track) => ({
      label: track.label,
      readyState: track.readyState,
      enabled: track.enabled,
      muted: track.muted,
    })) || [],
  });
  publishDebugState();
}

function renderMetadata() {
  dom.metadataOutput.textContent = state.metadata ? safeJson(state.metadata) : "No recording yet.";
  publishDebugState();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportBaseName() {
  return state.metadata?.exportId || `browser_call_probe_${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

function publishDebugState() {
  window.__callProbeDebug = {
    status: dom.status.textContent,
    peerId: state.peerId,
    room: state.room,
    role: state.role,
    micActive: Boolean(state.micStream),
    remoteTrackCount: state.remoteStream?.getAudioTracks().length || 0,
    connectionState: state.peerConnection?.connectionState || null,
    iceConnectionState: state.peerConnection?.iceConnectionState || null,
    probeEvents: state.probeEvents.length,
    wavReady: Boolean(state.wavBlob),
    metadataReady: Boolean(state.metadataBlob),
  };
}

function initialize() {
  dom.constraintsOutput.textContent = safeJson({ audio: REQUESTED_AUDIO_CONSTRAINTS, video: false });
  dom.startMicButton.textContent = dom.roleSelect.value === "endpoint" ? "Start phone microphone" : "Start optional PC microphone";
  drawEvidenceChart(null);
  updateCallState();
  dom.roleSelect.addEventListener("change", () => {
    state.role = dom.roleSelect.value;
    dom.startMicButton.textContent = state.role === "endpoint" ? "Start phone microphone" : "Start optional PC microphone";
    updateCallState();
  });
  dom.startMicButton.addEventListener("click", () => {
    startMicrophone().catch((error) => setStatus(`Microphone failed: ${error.message}`, "warn"));
  });
  dom.resetRoomButton.addEventListener("click", () => {
    resetRoom().catch((error) => setStatus(`Room reset failed: ${error.message}`, "warn"));
  });
  dom.connectButton.addEventListener("click", () => {
    connectRole().catch((error) => setStatus(`Connect failed: ${error.message}`, "warn"));
  });
  dom.resyncButton.addEventListener("click", () => {
    resyncSignaling().catch((error) => setStatus(`Resync failed: ${error.message}`, "warn"));
  });
  dom.hangupButton.addEventListener("click", hangUp);
  dom.recordRemoteProbeButton.addEventListener("click", () => {
    recordRemote({ alsoSendProbe: true }).catch((error) => setStatus(`Remote recording failed: ${error.message}`, "warn"));
  });
  dom.downloadWavButton.addEventListener("click", () => {
    if (state.wavBlob) {
      downloadBlob(state.wavBlob, `${exportBaseName()}.wav`);
    }
  });
  dom.downloadMetadataButton.addEventListener("click", () => {
    if (state.metadataBlob) {
      downloadBlob(state.metadataBlob, `${exportBaseName()}.json`);
    }
  });
  publishDebugState();
}

initialize();
