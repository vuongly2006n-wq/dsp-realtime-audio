let audioCtx = null;
let micStream = null;
let dspNode = null;
let analyser = null;
let animId = null;

const defaultGains = {
    dry: 0.0,
    echo: 0.5,
    reverb: 0.85,
    flanger: 0.7
};

const btnToggle = document.getElementById('btnToggle');
const effectSelect = document.getElementById('effectSelect');
const gainSlider = document.getElementById('gainSlider');
const gainVal = document.getElementById('gainVal');
const statusText = document.getElementById('statusText');
const metricsText = document.getElementById('metricsText');
const canvas = document.getElementById('scopeCanvas');
const ctx = canvas.getContext('2d');

function sendParams() {
    if (!dspNode) return;
    dspNode.port.postMessage({
        effect: effectSelect.value,
        gain: parseFloat(gainSlider.value)
    });
}

function updateGainLimits() {
    const eff = effectSelect.value;
    if (eff === 'reverb') {
        gainSlider.max = '0.95';
    } else {
        gainSlider.max = '1.00';
    }
    const def = defaultGains[eff];
    gainSlider.value = def.toFixed(2);
    gainVal.textContent = def.toFixed(2);
    gainSlider.disabled = (eff === 'dry');
    sendParams();
}

effectSelect.addEventListener('change', updateGainLimits);

gainSlider.addEventListener('input', () => {
    gainVal.textContent = parseFloat(gainSlider.value).toFixed(2);
    sendParams();
});

function drawScope() {
    if (!analyser) return;
    const bufferLength = analyser.fftSize;
    const dataArray = new Float32Array(bufferLength);
    analyser.getFloatTimeDomainData(dataArray);

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, canvas.height / 2);
    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();

    ctx.strokeStyle = effectSelect.value === 'dry' ? '#38bdf8' : '#f43f5e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const sliceWidth = canvas.width / bufferLength;
    let x = 0;
    for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i];
        const y = (0.5 - v * 0.45) * canvas.height;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
    }
    ctx.stroke();
    animId = requestAnimationFrame(drawScope);
}

async function startAudio() {
    try {
        statusText.textContent = 'Requesting microphone...';
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        audioCtx = new AudioContextClass({ latencyHint: 'interactive' });

        await audioCtx.audioWorklet.addModule('dsp-processor.js');

        micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            }
        });

        const source = audioCtx.createMediaStreamSource(micStream);
        dspNode = new AudioWorkletNode(audioCtx, 'realtime-dsp-processor', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2]
        });

        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024;

        source.connect(dspNode);
        dspNode.connect(analyser);
        analyser.connect(audioCtx.destination);

        if (audioCtx.state === 'suspended') {
            await audioCtx.resume();
        }

        sendParams();

        const fs = audioCtx.sampleRate;
        const frameMs = ((128 / fs) * 1000).toFixed(2);
        const baseLat = audioCtx.baseLatency ? (audioCtx.baseLatency * 1000).toFixed(1) : 'N/A';

        statusText.textContent = 'Running (Real-Time Active)';
        metricsText.textContent = `Fs: ${fs} Hz | Frame: 128 samples (${frameMs} ms) | Base Latency: ${baseLat} ms`;
        btnToggle.textContent = 'Stop Real-Time Audio';
        btnToggle.classList.add('active');

        drawScope();
    } catch (err) {
        statusText.textContent = 'Error: ' + err.message;
        stopAudio();
    }
}

function stopAudio() {
    if (animId) {
        cancelAnimationFrame(animId);
        animId = null;
    }
    if (micStream) {
        micStream.getTracks().forEach(track => track.stop());
        micStream = null;
    }
    if (audioCtx) {
        audioCtx.close();
        audioCtx = null;
    }
    dspNode = null;
    analyser = null;
    btnToggle.textContent = 'Start Real-Time Audio';
    btnToggle.classList.remove('active');
    if (!statusText.textContent.startsWith('Error')) {
        statusText.textContent = 'Stopped';
    }
}

btnToggle.addEventListener('click', () => {
    if (!audioCtx) {
        startAudio();
    } else {
        stopAudio();
    }
});

updateGainLimits();