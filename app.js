let audioCtx = null;
let workletLoaded = false;
let dspNode = null;
let playerGainNode = null;
let masterGainNode = null;
let masterAnalyser = null;
let mediaElSource = null;

let micStream = null;
let micSource = null;
let micGainNode = null;
let micActive = false;

let recStream = null;
let recSource = null;
let recNode = null;
let recSilentSink = null;
let recAnalyser = null;
let isRecording = false;
let recChunks = [];
let recTimerId = null;
let recStartTime = 0;
let stopRecResolve = null;

let vuAnimId = null;
let smoothedDb = -60;
let isSeeking = false;
let currentSourceUrl = null;
let loadedSignal = null;

const COMB_DELAY_MS = [29.7, 37.1, 41.1, 43.7];

const PRESETS = {
    dry: {
        name: 'Giọng Mộc',
        echoGain: 0.0,
        echoDelayMs: 300,
        reverbGain: 0.0,
        reverbMix: 0.0,
        flangerGain: 0.0,
        flangerRate: 0.25,
        flangerDepthMs: 2.0
    },
    karaoke: {
        name: 'Karaoke KTV',
        echoGain: 0.35,
        echoDelayMs: 220,
        reverbGain: 0.72,
        reverbMix: 0.45,
        flangerGain: 0.0,
        flangerRate: 0.25,
        flangerDepthMs: 2.0
    },
    studio: {
        name: 'Podcast / MC',
        echoGain: 0.0,
        echoDelayMs: 180,
        reverbGain: 0.45,
        reverbMix: 0.22,
        flangerGain: 0.0,
        flangerRate: 0.25,
        flangerDepthMs: 2.0
    },
    hall: {
        name: 'Hội trường',
        echoGain: 0.15,
        echoDelayMs: 300,
        reverbGain: 0.90,
        reverbMix: 0.65,
        flangerGain: 0.0,
        flangerRate: 0.25,
        flangerDepthMs: 2.0
    },
    cave: {
        name: 'Hang động',
        echoGain: 0.65,
        echoDelayMs: 320,
        reverbGain: 0.80,
        reverbMix: 0.50,
        flangerGain: 0.0,
        flangerRate: 0.25,
        flangerDepthMs: 2.0
    },
    robot: {
        name: 'Robot / Flanger',
        echoGain: 0.30,
        echoDelayMs: 45,
        reverbGain: 0.30,
        reverbMix: 0.20,
        flangerGain: 0.90,
        flangerRate: 2.2,
        flangerDepthMs: 1.8
    }
};

let currentPreset = 'karaoke';
let dspState = { ...PRESETS.karaoke };

const btnMic = document.getElementById('btnMic');
const btnRec = document.getElementById('btnRec');
const recTimer = document.getElementById('recTimer');
const vuLeds = document.getElementById('vuLeds');
const vuDb = document.getElementById('vuDb');
const vuSourceLabel = document.getElementById('vuSourceLabel');

const wavFileInput = document.getElementById('wavFileInput');
const sourceInfo = document.getElementById('sourceInfo');
const playerAudio = document.getElementById('playerAudio');
const seekBar = document.getElementById('seekBar');
const curTimeEl = document.getElementById('curTime');
const durTimeEl = document.getElementById('durTime');
const btnBack = document.getElementById('btnBack');
const btnPlayPause = document.getElementById('btnPlayPause');
const btnForward = document.getElementById('btnForward');

const presetBtns = document.querySelectorAll('.preset-btn');
const echoSlider = document.getElementById('echoSlider');
const echoVal = document.getElementById('echoVal');
const reverbSlider = document.getElementById('reverbSlider');
const reverbVal = document.getElementById('reverbVal');
const flangerSlider = document.getElementById('flangerSlider');
const flangerVal = document.getElementById('flangerVal');

const micVolSlider = document.getElementById('micVolSlider');
const micVolVal = document.getElementById('micVolVal');
const playerVolSlider = document.getElementById('playerVolSlider');
const playerVolVal = document.getElementById('playerVolVal');
const masterVolSlider = document.getElementById('masterVolSlider');
const masterVolVal = document.getElementById('masterVolVal');

const btnExportEcho = document.getElementById('btnExportEcho');
const btnExportReverb = document.getElementById('btnExportReverb');
const btnExportFlanger = document.getElementById('btnExportFlanger');
const exportStatus = document.getElementById('exportStatus');

const statusText = document.getElementById('statusText');
const metricsText = document.getElementById('metricsText');

const LED_COUNT = 20;
const ledElements = [];

function initVuMeter() {
    vuLeds.innerHTML = '';
    for (let i = 0; i < LED_COUNT; i++) {
        const seg = document.createElement('div');
        seg.className = 'vu-seg';
        if (i < 12) seg.dataset.zone = 'green';
        else if (i < 17) seg.dataset.zone = 'yellow';
        else seg.dataset.zone = 'red';
        vuLeds.appendChild(seg);
        ledElements.push(seg);
    }
}

function renderVuLevel(db) {
    const clamped = Math.max(-55, Math.min(0, db));
    const ratio = (clamped + 55) / 55;
    const activeCount = Math.round(ratio * LED_COUNT);
    for (let i = 0; i < LED_COUNT; i++) {
        ledElements[i].classList.toggle('on', i < activeCount);
    }
    vuDb.textContent = db <= -54 ? '-∞ dB' : `${db.toFixed(1)} dB`;
}

function updateVuLoop() {
    const activeAnalyser = isRecording ? recAnalyser : masterAnalyser;
    vuSourceLabel.textContent = isRecording
        ? 'VU Meter (Đang thu giọng nói mộc)'
        : 'VU Meter (Đầu ra DSP)';

    if (activeAnalyser) {
        const buf = new Float32Array(activeAnalyser.fftSize);
        activeAnalyser.getFloatTimeDomainData(buf);
        let sumSq = 0;
        for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
        const rms = Math.sqrt(sumSq / buf.length);
        const db = 20 * Math.log10(rms + 1e-6);
        smoothedDb = db > smoothedDb ? db : smoothedDb * 0.82 + db * 0.18;
        renderVuLevel(smoothedDb);
    } else {
        renderVuLevel(-60);
    }
    vuAnimId = requestAnimationFrame(updateVuLoop);
}

async function ensureAudioGraph() {
    if (!audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContextClass({ latencyHint: 'interactive' });
    }
    if (!workletLoaded) {
        await audioCtx.audioWorklet.addModule('dsp-processor.js');
        workletLoaded = true;
    }
    if (!dspNode) {
        dspNode = new AudioWorkletNode(audioCtx, 'realtime-dsp-processor', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2]
        });

        masterGainNode = audioCtx.createGain();
        masterGainNode.gain.value = parseFloat(masterVolSlider.value);

        masterAnalyser = audioCtx.createAnalyser();
        masterAnalyser.fftSize = 512;

        dspNode.connect(masterGainNode);
        masterGainNode.connect(masterAnalyser);
        masterAnalyser.connect(audioCtx.destination);

        mediaElSource = audioCtx.createMediaElementSource(playerAudio);
        playerGainNode = audioCtx.createGain();
        playerGainNode.gain.value = parseFloat(playerVolSlider.value);

        mediaElSource.connect(playerGainNode);
        playerGainNode.connect(dspNode);

        sendDspParams(true);

        const fs = audioCtx.sampleRate;
        const frameMs = ((128 / fs) * 1000).toFixed(2);
        const baseLat = audioCtx.baseLatency ? (audioCtx.baseLatency * 1000).toFixed(1) : 'N/A';
        metricsText.textContent = `Fs: ${fs} Hz | Frame: 128 samples (${frameMs} ms) | Base Latency: ${baseLat} ms`;

        if (!vuAnimId) updateVuLoop();
    }
    if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
    }
}

function sendDspParams(reset = false) {
    if (!dspNode) return;
    dspNode.port.postMessage({
        reset,
        echoGain: dspState.echoGain,
        echoDelayMs: dspState.echoDelayMs,
        reverbGain: dspState.reverbGain,
        reverbMix: dspState.reverbMix,
        flangerGain: dspState.flangerGain,
        flangerRate: dspState.flangerRate,
        flangerDepthMs: dspState.flangerDepthMs
    });
}

function applyPreset(key) {
    const p = PRESETS[key];
    if (!p) return;
    currentPreset = key;
    dspState = { ...p };

    presetBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.preset === key);
    });

    echoSlider.value = dspState.echoGain.toFixed(2);
    echoVal.textContent = dspState.echoGain.toFixed(2);
    reverbSlider.value = dspState.reverbGain.toFixed(2);
    reverbVal.textContent = dspState.reverbGain.toFixed(2);
    flangerSlider.value = dspState.flangerGain.toFixed(2);
    flangerVal.textContent = dspState.flangerGain.toFixed(2);

    sendDspParams(key === 'dry');
}

presetBtns.forEach(btn => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
});

echoSlider.addEventListener('input', () => {
    dspState.echoGain = parseFloat(echoSlider.value);
    dspState.echoDelayMs = 300;
    echoVal.textContent = dspState.echoGain.toFixed(2);
    sendDspParams(false);
});

reverbSlider.addEventListener('input', () => {
    dspState.reverbGain = parseFloat(reverbSlider.value);
    dspState.reverbMix = dspState.reverbGain > 0.01 ? Math.max(0.35, dspState.reverbGain * 0.65) : 0.0;
    reverbVal.textContent = dspState.reverbGain.toFixed(2);
    sendDspParams(false);
});

flangerSlider.addEventListener('input', () => {
    dspState.flangerGain = parseFloat(flangerSlider.value);
    dspState.flangerRate = 0.25;
    dspState.flangerDepthMs = 2.0;
    flangerVal.textContent = dspState.flangerGain.toFixed(2);
    sendDspParams(false);
});

micVolSlider.addEventListener('input', () => {
    const v = parseFloat(micVolSlider.value);
    micVolVal.textContent = `${Math.round(v * 100)}%`;
    if (micGainNode) micGainNode.gain.value = v;
});

playerVolSlider.addEventListener('input', () => {
    const v = parseFloat(playerVolSlider.value);
    playerVolVal.textContent = `${Math.round(v * 100)}%`;
    if (playerGainNode) playerGainNode.gain.value = v;
});

masterVolSlider.addEventListener('input', () => {
    const v = parseFloat(masterVolSlider.value);
    masterVolVal.textContent = `${Math.round(v * 100)}%`;
    if (masterGainNode) masterGainNode.gain.value = v;
});

async function startMic() {
    if (isRecording) await stopDryRecording();
    try {
        statusText.textContent = 'Đang xin quyền Micro...';
        await ensureAudioGraph();

        micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            }
        });

        micSource = audioCtx.createMediaStreamSource(micStream);
        micGainNode = audioCtx.createGain();
        micGainNode.gain.value = parseFloat(micVolSlider.value);

        micSource.connect(micGainNode);
        micGainNode.connect(dspNode);

        sendDspParams(true);
        micActive = true;
        btnMic.textContent = 'Tắt Micro Karaoke';
        btnMic.classList.add('active');
        statusText.textContent = `Micro Live đang chạy (${PRESETS[currentPreset].name})`;
    } catch (err) {
        statusText.textContent = 'Lỗi Micro: ' + err.message;
        stopMic();
    }
}

function stopMic() {
    if (micSource) {
        try { micSource.disconnect(); } catch (e) {}
        micSource = null;
    }
    if (micGainNode) {
        try { micGainNode.disconnect(); } catch (e) {}
        micGainNode = null;
    }
    if (micStream) {
        micStream.getTracks().forEach(t => t.stop());
        micStream = null;
    }
    micActive = false;
    btnMic.textContent = 'Bật Micro Karaoke';
    btnMic.classList.remove('active');
    if (!statusText.textContent.startsWith('Lỗi')) {
        statusText.textContent = 'Micro Live đã tắt';
    }
}

btnMic.addEventListener('click', () => {
    if (micActive) stopMic();
    else startMic();
});

function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function encodeWav(samples, sampleRate) {
    const numSamples = samples.length;
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);
    const writeStr = (offset, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, numSamples * 2, true);

    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        offset += 2;
    }
    return new Blob([buffer], { type: 'audio/wav' });
}

function loadSignalIntoPlayer(samples, sampleRate, displayName, autoPlay = false) {
    loadedSignal = { samples, sampleRate, name: displayName };

    const wavBlob = encodeWav(samples, sampleRate);
    if (currentSourceUrl) URL.revokeObjectURL(currentSourceUrl);
    currentSourceUrl = URL.createObjectURL(wavBlob);

    playerAudio.pause();
    playerAudio.src = currentSourceUrl;
    playerAudio.load();

    seekBar.value = 0;
    curTimeEl.textContent = '00:00';
    durTimeEl.textContent = formatTime(samples.length / sampleRate);
    sourceInfo.textContent = `Đang nạp: ${displayName} (${sampleRate} Hz, ${(samples.length / sampleRate).toFixed(1)}s)`;
    exportStatus.textContent = 'Sẵn sàng xuất 3 hiệu ứng (.wav)';

    if (autoPlay) {
        playerAudio.play().catch(() => {});
    }
}

async function startDryRecording() {
    if (micActive) stopMic();
    if (!playerAudio.paused) playerAudio.pause();

    try {
        statusText.textContent = 'Đang mở Micro thu giọng nói...';
        await ensureAudioGraph();

        recStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            }
        });

        recSource = audioCtx.createMediaStreamSource(recStream);
        recNode = new AudioWorkletNode(audioCtx, 'dry-recorder-processor');
        recSilentSink = audioCtx.createGain();
        recSilentSink.gain.value = 0;

        recAnalyser = audioCtx.createAnalyser();
        recAnalyser.fftSize = 512;

        recChunks = [];
        recNode.port.onmessage = (e) => {
            if (e.data.chunk) recChunks.push(e.data.chunk);
            if (e.data.done && stopRecResolve) {
                stopRecResolve();
                stopRecResolve = null;
            }
        };

        recSource.connect(recNode);
        recSource.connect(recAnalyser);
        recNode.connect(recSilentSink);
        recSilentSink.connect(audioCtx.destination);

        recNode.port.postMessage({ cmd: 'start' });
        isRecording = true;
        recStartTime = Date.now();
        recTimer.textContent = '00:00';
        btnRec.textContent = 'Dừng thu & Xử lý';
        btnRec.classList.add('recording');
        statusText.textContent = 'Đang thu giọng nói (tự ngắt loa chống hú)...';

        recTimerId = setInterval(() => {
            recTimer.textContent = formatTime((Date.now() - recStartTime) / 1000);
        }, 200);
    } catch (err) {
        statusText.textContent = 'Lỗi thu âm: ' + err.message;
        cleanupRecNodes();
    }
}

function cleanupRecNodes() {
    if (recTimerId) {
        clearInterval(recTimerId);
        recTimerId = null;
    }
    if (recSource) {
        try { recSource.disconnect(); } catch (e) {}
        recSource = null;
    }
    if (recNode) {
        try { recNode.disconnect(); } catch (e) {}
        recNode = null;
    }
    if (recSilentSink) {
        try { recSilentSink.disconnect(); } catch (e) {}
        recSilentSink = null;
    }
    if (recStream) {
        recStream.getTracks().forEach(t => t.stop());
        recStream = null;
    }
    recAnalyser = null;
    isRecording = false;
    btnRec.textContent = 'Thu giọng nói';
    btnRec.classList.remove('recording');
}

async function stopDryRecording() {
    if (!isRecording) return;

    await new Promise((resolve) => {
        stopRecResolve = resolve;
        recNode.port.postMessage({ cmd: 'stop' });
        setTimeout(resolve, 250);
    });

    const sr = audioCtx.sampleRate;
    cleanupRecNodes();

    let totalLen = 0;
    for (const c of recChunks) totalLen += c.length;
    if (totalLen === 0) {
        statusText.textContent = 'Không có dữ liệu âm thanh được ghi lại.';
        return;
    }

    const merged = new Float32Array(totalLen);
    let offset = 0;
    for (const c of recChunks) {
        merged.set(c, offset);
        offset += c.length;
    }

    let peak = 0;
    for (let i = 0; i < merged.length; i++) {
        const a = Math.abs(merged[i]);
        if (a > peak) peak = a;
    }
    if (peak > 0.01) {
        const scale = 0.9 / peak;
        for (let i = 0; i < merged.length; i++) merged[i] *= scale;
    }

    sendDspParams(true);
    loadSignalIntoPlayer(merged, sr, 'Giong_thu_am.wav', true);
    statusText.textContent = `Đã thu xong — Đang phát qua DSP (${PRESETS[currentPreset].name})`;
}

btnRec.addEventListener('click', () => {
    if (isRecording) stopDryRecording();
    else startDryRecording();
});

wavFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
        statusText.textContent = `Đang giải mã ${file.name}...`;
        await ensureAudioGraph();
        const arrayBuf = await file.arrayBuffer();
        const audioBuf = await audioCtx.decodeAudioData(arrayBuf);

        const len = audioBuf.length;
        const mono = new Float32Array(len);
        const ch0 = audioBuf.getChannelData(0);
        if (audioBuf.numberOfChannels > 1) {
            const ch1 = audioBuf.getChannelData(1);
            for (let i = 0; i < len; i++) mono[i] = 0.5 * (ch0[i] + ch1[i]);
        } else {
            mono.set(ch0);
        }

        loadSignalIntoPlayer(mono, audioBuf.sampleRate, file.name, false);
        statusText.textContent = `Đã nạp ${file.name} — Bấm Phát để nghe hiệu ứng hoặc Xuất 3 file .wav`;
    } catch (err) {
        statusText.textContent = 'Không đọc được file âm thanh: ' + err.message;
    }
});

btnPlayPause.addEventListener('click', async () => {
    if (!loadedSignal) {
        statusText.textContent = 'Hãy nạp file .wav hoặc thu giọng nói trước!';
        return;
    }
    await ensureAudioGraph();
    if (playerAudio.paused) {
        await playerAudio.play();
    } else {
        playerAudio.pause();
    }
});

btnBack.addEventListener('click', () => {
    if (!isFinite(playerAudio.duration)) return;
    playerAudio.currentTime = Math.max(0, playerAudio.currentTime - 5);
});

btnForward.addEventListener('click', () => {
    if (!isFinite(playerAudio.duration)) return;
    playerAudio.currentTime = Math.min(playerAudio.duration, playerAudio.currentTime + 5);
});

seekBar.addEventListener('input', () => {
    isSeeking = true;
    if (isFinite(playerAudio.duration)) {
        curTimeEl.textContent = formatTime((parseFloat(seekBar.value) / 100) * playerAudio.duration);
    }
});

seekBar.addEventListener('change', () => {
    if (isFinite(playerAudio.duration)) {
        playerAudio.currentTime = (parseFloat(seekBar.value) / 100) * playerAudio.duration;
    }
    isSeeking = false;
});

playerAudio.addEventListener('loadedmetadata', () => {
    durTimeEl.textContent = formatTime(playerAudio.duration);
});

playerAudio.addEventListener('timeupdate', () => {
    if (!isSeeking && isFinite(playerAudio.duration) && playerAudio.duration > 0) {
        seekBar.value = (playerAudio.currentTime / playerAudio.duration) * 100;
        curTimeEl.textContent = formatTime(playerAudio.currentTime);
    }
});

playerAudio.addEventListener('play', () => {
    btnPlayPause.textContent = '⏸ Tạm dừng';
});

playerAudio.addEventListener('pause', () => {
    btnPlayPause.textContent = '▶ Phát';
});

playerAudio.addEventListener('ended', () => {
    btnPlayPause.textContent = '▶ Phát';
    seekBar.value = 0;
});

function normalizeSignal(y) {
    let peak = 0;
    for (let i = 0; i < y.length; i++) {
        const a = Math.abs(y[i]);
        if (a > peak) peak = a;
    }
    if (peak > 1) {
        for (let i = 0; i < y.length; i++) y[i] /= peak;
    }
    return y;
}

function runEchoOffline(x, Fs, g) {
    const D = Math.round(0.3 * Fs);
    const N = x.length + Math.round(1.0 * Fs);
    const y = new Float32Array(N);
    for (let n = 0; n < N; n++) {
        const xn = n < x.length ? x[n] : 0;
        const xDel = (n >= D && (n - D) < x.length) ? x[n - D] : 0;
        y[n] = xn + g * xDel;
    }
    return normalizeSignal(y);
}

function runReverbOffline(x, Fs, g) {
    const gSafe = Math.min(g, 0.95);
    const delays = COMB_DELAY_MS.map(ms => Math.max(1, Math.round((ms / 1000) * Fs)));
    const N = x.length + Math.round(2.0 * Fs);
    const y = new Float32Array(N);
    const combs = delays.map(() => new Float32Array(N));

    for (let k = 0; k < delays.length; k++) {
        const D = delays[k];
        const c = combs[k];
        for (let n = 0; n < N; n++) {
            const xDel = (n >= D && (n - D) < x.length) ? x[n - D] : 0;
            const cDel = n >= D ? c[n - D] : 0;
            c[n] = xDel + gSafe * cDel;
        }
    }

    for (let n = 0; n < N; n++) {
        const xn = n < x.length ? x[n] : 0;
        const sum = combs[0][n] + combs[1][n] + combs[2][n] + combs[3][n];
        y[n] = xn + 0.25 * sum;
    }
    return normalizeSignal(y);
}

function runFlangerOffline(x, Fs, g) {
    const N = x.length;
    const y = new Float32Array(N);
    for (let n = 0; n < N; n++) {
        const d = (Fs / 1000) * (3.0 + 2.0 * Math.sin(2 * Math.PI * 0.25 * n / Fs));
        const idx = n - d;
        const i1 = Math.floor(idx);
        if (i1 >= 0 && i1 + 1 < N) {
            const frac = idx - i1;
            const xDel = (1 - frac) * x[i1] + frac * x[i1 + 1];
            y[n] = x[n] + g * xDel;
        } else {
            y[n] = x[n];
        }
    }
    return normalizeSignal(y);
}

function triggerDownload(samples, sampleRate, suffix) {
    const baseName = loadedSignal.name.replace(/\.[^/.]+$/, '');
    const blob = encodeWav(samples, sampleRate);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${baseName}_${suffix}.wav`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportEffect(type) {
    if (!loadedSignal) {
        exportStatus.textContent = 'Chưa có tín hiệu — Hãy nạp file .wav hoặc thu giọng nói trước!';
        return;
    }

    const { samples, sampleRate } = loadedSignal;
    let y;
    let label;

    if (type === 'echo') {
        const g = parseFloat(echoSlider.value) > 0 ? parseFloat(echoSlider.value) : 0.5;
        y = runEchoOffline(samples, sampleRate, g);
        label = `echo_g${g.toFixed(2)}`;
        exportStatus.textContent = `Đã xuất Echo (FIR, g = ${g.toFixed(2)})`;
    } else if (type === 'reverb') {
        const g = parseFloat(reverbSlider.value) > 0 ? parseFloat(reverbSlider.value) : 0.85;
        y = runReverbOffline(samples, sampleRate, g);
        label = `reverb_g${g.toFixed(2)}`;
        exportStatus.textContent = `Đã xuất Reverb (4-Comb IIR, g = ${g.toFixed(2)})`;
    } else if (type === 'flanger') {
        const g = parseFloat(flangerSlider.value) > 0 ? parseFloat(flangerSlider.value) : 0.7;
        y = runFlangerOffline(samples, sampleRate, g);
        label = `flanger_g${g.toFixed(2)}`;
        exportStatus.textContent = `Đã xuất Flanger (FIR LTV, g = ${g.toFixed(2)})`;
    }

    triggerDownload(y, sampleRate, label);
}

btnExportEcho.addEventListener('click', () => exportEffect('echo'));
btnExportReverb.addEventListener('click', () => exportEffect('reverb'));
btnExportFlanger.addEventListener('click', () => exportEffect('flanger'));

initVuMeter();
applyPreset('karaoke');