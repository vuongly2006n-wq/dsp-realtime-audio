let audioCtx = null;
let workletLoaded = false;
let dspNode = null;
let masterAnalyser = null;
let mediaElSource = null;

let micStream = null;
let micSource = null;
let micLiveGain = null;
let recNode = null;
let recSilentSink = null;
let recAnalyser = null;

let micRecActive = false;
let recChunks = [];
let recTimerId = null;
let recStartTime = 0;
let stopRecResolve = null;

let vuAnimId = null;
let smoothedDb = -60;
let currentSourceUrl = null;
let loadedSignal = null;

const COMB_DELAY_MS = [29.7, 37.1, 41.1, 43.7];
const DEFAULT_GAINS = {
    dry: 0.0,
    echo: 0.5,
    reverb: 0.85,
    flanger: 0.7
};

let currentEffect = 'echo';
let currentGain = 0.5;

const btnMicRec = document.getElementById('btnMicRec');
const chkMonitor = document.getElementById('chkMonitor');
const recTimer = document.getElementById('recTimer');
const vuLeds = document.getElementById('vuLeds');
const vuDb = document.getElementById('vuDb');
const vuSourceLabel = document.getElementById('vuSourceLabel');

const wavFileInput = document.getElementById('wavFileInput');
const sourceInfo = document.getElementById('sourceInfo');
const playerAudio = document.getElementById('playerAudio');
const btnPlayPause = document.getElementById('btnPlayPause');
const timeDisplay = document.getElementById('timeDisplay');

const effectBtns = document.querySelectorAll('.effect-btn');
const gainSlider = document.getElementById('gainSlider');
const gainVal = document.getElementById('gainVal');

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
    ledElements.length = 0;
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
    const activeAnalyser = (micRecActive && !chkMonitor.checked) ? recAnalyser : masterAnalyser;
    vuSourceLabel.textContent = micRecActive ? 'VU Meter (Micro)' : 'VU Meter (Đầu ra DSP)';

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
        await audioCtx.audioWorklet.addModule('dsp-processor.js?v=3');
        workletLoaded = true;
    }
    if (!dspNode) {
        dspNode = new AudioWorkletNode(audioCtx, 'realtime-dsp-processor', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2]
        });

        masterAnalyser = audioCtx.createAnalyser();
        masterAnalyser.fftSize = 512;

        dspNode.connect(masterAnalyser);
        masterAnalyser.connect(audioCtx.destination);

        mediaElSource = audioCtx.createMediaElementSource(playerAudio);
        mediaElSource.connect(dspNode);

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
        effect: currentEffect,
        gain: currentGain
    });
}

function selectEffect(eff) {
    currentEffect = eff;
    effectBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.effect === eff);
    });

    if (eff === 'reverb') {
        gainSlider.max = '0.95';
    } else {
        gainSlider.max = '1.00';
    }

    currentGain = DEFAULT_GAINS[eff];
    gainSlider.value = currentGain.toFixed(2);
    gainVal.textContent = currentGain.toFixed(2);
    gainSlider.disabled = (eff === 'dry');

    sendDspParams(true);
}

effectBtns.forEach(btn => {
    btn.addEventListener('click', () => selectEffect(btn.dataset.effect));
});

gainSlider.addEventListener('input', () => {
    currentGain = parseFloat(gainSlider.value);
    gainVal.textContent = currentGain.toFixed(2);
    sendDspParams(false);
});

chkMonitor.addEventListener('change', () => {
    if (micLiveGain) {
        micLiveGain.gain.value = chkMonitor.checked ? 1.0 : 0.0;
    }
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

    const durSec = samples.length / sampleRate;
    timeDisplay.textContent = `00:00 / ${formatTime(durSec)}`;
    sourceInfo.textContent = `Đang nạp: ${displayName} (${sampleRate} Hz, ${durSec.toFixed(1)}s)`;
    exportStatus.textContent = 'Sẵn sàng xuất 3 hiệu ứng (.wav)';

    if (autoPlay) {
        playerAudio.play().catch(() => {});
    }
}

async function startMicAndRec() {
    if (!playerAudio.paused) playerAudio.pause();
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
        micLiveGain = audioCtx.createGain();
        micLiveGain.gain.value = chkMonitor.checked ? 1.0 : 0.0;

        recAnalyser = audioCtx.createAnalyser();
        recAnalyser.fftSize = 512;

        recNode = new AudioWorkletNode(audioCtx, 'dry-recorder-processor');
        recSilentSink = audioCtx.createGain();
        recSilentSink.gain.value = 0;

        recChunks = [];
        recNode.port.onmessage = (e) => {
            if (e.data.chunk) recChunks.push(e.data.chunk);
            if (e.data.done && stopRecResolve) {
                stopRecResolve();
                stopRecResolve = null;
            }
        };

        micSource.connect(micLiveGain);
        micLiveGain.connect(dspNode);

        micSource.connect(recAnalyser);
        micSource.connect(recNode);
        recNode.connect(recSilentSink);
        recSilentSink.connect(audioCtx.destination);

        sendDspParams(true);
        recNode.port.postMessage({ cmd: 'start' });

        micRecActive = true;
        recStartTime = Date.now();
        recTimer.textContent = '00:00';
        btnMicRec.textContent = 'Dừng Micro & Lưu giọng';
        btnMicRec.classList.add('active');
        statusText.textContent = chkMonitor.checked
            ? 'Đang chạy Micro Karaoke + Thu giọng...'
            : 'Đang thu giọng nói (tắt loa chống hú)...';

        recTimerId = setInterval(() => {
            recTimer.textContent = formatTime((Date.now() - recStartTime) / 1000);
        }, 200);
    } catch (err) {
        statusText.textContent = 'Lỗi Micro: ' + err.message;
        cleanupMicNodes();
    }
}

function cleanupMicNodes() {
    if (recTimerId) {
        clearInterval(recTimerId);
        recTimerId = null;
    }
    [micSource, micLiveGain, recNode, recSilentSink].forEach(node => {
        if (node) {
            try { node.disconnect(); } catch (e) {}
        }
    });
    micSource = null;
    micLiveGain = null;
    recNode = null;
    recSilentSink = null;
    recAnalyser = null;

    if (micStream) {
        micStream.getTracks().forEach(t => t.stop());
        micStream = null;
    }

    micRecActive = false;
    btnMicRec.textContent = 'Bật Micro & Thu giọng';
    btnMicRec.classList.remove('active');
}

async function stopMicAndRec() {
    if (!micRecActive) return;

    await new Promise((resolve) => {
        stopRecResolve = resolve;
        recNode.port.postMessage({ cmd: 'stop' });
        setTimeout(resolve, 250);
    });

    const sr = audioCtx.sampleRate;
    cleanupMicNodes();

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
    statusText.textContent = `Đã lưu giọng thu — Đang phát trực tiếp qua hiệu ứng ${currentEffect.toUpperCase()}`;
}

btnMicRec.addEventListener('click', () => {
    if (micRecActive) stopMicAndRec();
    else startMicAndRec();
});

wavFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
        statusText.textContent = `Đang nạp ${file.name}...`;
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
        statusText.textContent = `Đã nạp ${file.name} — Bấm Phát hoặc Xuất 3 file .wav`;
    } catch (err) {
        statusText.textContent = 'Không đọc được file: ' + err.message;
    } finally {
        wavFileInput.value = '';
    }
});

btnPlayPause.addEventListener('click', async () => {
    if (!loadedSignal) {
        statusText.textContent = 'Hãy nạp file .wav hoặc bấm Bật Micro & Thu giọng trước!';
        return;
    }
    try {
        await ensureAudioGraph();
        if (playerAudio.paused) {
            await playerAudio.play();
        } else {
            playerAudio.pause();
        }
    } catch (err) {
        statusText.textContent = 'Lỗi phát âm thanh: ' + err.message;
    }
});

playerAudio.addEventListener('timeupdate', () => {
    if (isFinite(playerAudio.duration)) {
        timeDisplay.textContent = `${formatTime(playerAudio.currentTime)} / ${formatTime(playerAudio.duration)}`;
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
        exportStatus.textContent = 'Chưa có tín hiệu — Hãy nạp file .wav hoặc thu giọng trước!';
        return;
    }

    const { samples, sampleRate } = loadedSignal;
    const g = (currentEffect === type && currentGain > 0) ? currentGain : DEFAULT_GAINS[type];
    let y;

    if (type === 'echo') {
        y = runEchoOffline(samples, sampleRate, g);
        exportStatus.textContent = `Đã xuất Echo (FIR, g = ${g.toFixed(2)})`;
    } else if (type === 'reverb') {
        y = runReverbOffline(samples, sampleRate, g);
        exportStatus.textContent = `Đã xuất Reverb (4-Comb IIR, g = ${g.toFixed(2)})`;
    } else if (type === 'flanger') {
        y = runFlangerOffline(samples, sampleRate, g);
        exportStatus.textContent = `Đã xuất Flanger (FIR LTV, g = ${g.toFixed(2)})`;
    }

    triggerDownload(y, sampleRate, `${type}_g${g.toFixed(2)}`);
}

btnExportEcho.addEventListener('click', () => exportEffect('echo'));
btnExportReverb.addEventListener('click', () => exportEffect('reverb'));
btnExportFlanger.addEventListener('click', () => exportEffect('flanger'));

initVuMeter();
selectEffect('echo');