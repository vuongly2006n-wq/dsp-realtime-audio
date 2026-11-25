class RealtimeDspProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.effect = 'echo';
        this.gain = 0.5;

        this.xLen = Math.ceil(sampleRate * 1.0);
        this.xBuf = new Float32Array(this.xLen);
        this.xIdx = 0;

        const delayMs = [29.7, 37.1, 41.1, 43.7];
        this.combDelays = delayMs.map(ms => Math.max(1, Math.round((ms / 1000) * sampleRate)));
        this.combBufs = this.combDelays.map(len => new Float32Array(len));
        this.combPtrs = new Int32Array(this.combDelays.length);

        this.lfoPhase = 0;
        this.lfoInc = (2 * Math.PI * 0.25) / sampleRate;

        this.port.onmessage = (event) => {
            const d = event.data;
            if (d.reset) this.resetBuffers();
            if (d.effect !== undefined) {
                if (d.effect !== this.effect) this.resetBuffers();
                this.effect = d.effect;
            }
            if (d.gain !== undefined) this.gain = d.gain;
        };
    }

    resetBuffers() {
        this.xBuf.fill(0);
        this.xIdx = 0;
        for (let k = 0; k < this.combBufs.length; k++) {
            this.combBufs[k].fill(0);
            this.combPtrs[k] = 0;
        }
        this.lfoPhase = 0;
    }

    process(inputs, outputs) {
        const input = inputs[0];
        const output = outputs[0];
        if (!output || !output[0]) return true;

        const outL = output[0];
        const outR = output[1];
        const blockSize = outL.length;

        const hasInput = input && input[0];
        const inL = hasInput ? input[0] : null;
        const inR = hasInput ? input[1] : null;

        const echoDelay = Math.round(0.3 * sampleRate);
        const gRev = Math.min(this.gain, 0.95);
        const wet = 0.4;

        for (let i = 0; i < blockSize; i++) {
            const x = inL ? (inR ? 0.5 * (inL[i] + inR[i]) : inL[i]) : 0;
            this.xBuf[this.xIdx] = x;
            let y = x;

            if (this.effect === 'echo') {
                const readIdx = (this.xIdx - echoDelay + this.xLen) % this.xLen;
                y = x + this.gain * this.xBuf[readIdx];
            } else if (this.effect === 'reverb') {
                let v = 0;
                for (let k = 0; k < this.combBufs.length; k++) {
                    const Dk = this.combDelays[k];
                    const ptr = this.combPtrs[k];
                    const cPrev = this.combBufs[k][ptr];
                    const xDelIdx = (this.xIdx - Dk + this.xLen) % this.xLen;
                    const cOut = this.xBuf[xDelIdx] + gRev * cPrev;
                    this.combBufs[k][ptr] = cOut;
                    this.combPtrs[k] = (ptr + 1) % Dk;
                    v += cOut / 4;
                }
                y = (1 - wet) * x + wet * v;
            } else if (this.effect === 'flanger') {
                const d = Math.round((sampleRate / 1000) * (3 + 2 * Math.sin(this.lfoPhase)));
                const readIdx = (this.xIdx - d + this.xLen) % this.xLen;
                y = x + this.gain * this.xBuf[readIdx];

                this.lfoPhase += this.lfoInc;
                if (this.lfoPhase >= 2 * Math.PI) this.lfoPhase -= 2 * Math.PI;
            }

            outL[i] = y;
            if (outR) outR[i] = y;

            this.xIdx = (this.xIdx + 1) % this.xLen;
        }

        return true;
    }
}

class DryRecorderProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.recording = false;
        this.chunkSize = 4096;
        this.buffer = new Float32Array(this.chunkSize);
        this.offset = 0;

        this.port.onmessage = (event) => {
            if (event.data.cmd === 'start') {
                this.offset = 0;
                this.recording = true;
            } else if (event.data.cmd === 'stop') {
                this.recording = false;
                if (this.offset > 0) {
                    this.port.postMessage({ chunk: this.buffer.slice(0, this.offset) });
                    this.offset = 0;
                }
                this.port.postMessage({ done: true });
            }
        };
    }

    process(inputs) {
        if (!this.recording) return true;
        const input = inputs[0];
        if (!input || !input[0]) return true;

        const ch = input[0];
        for (let i = 0; i < ch.length; i++) {
            this.buffer[this.offset++] = ch[i];
            if (this.offset >= this.chunkSize) {
                this.port.postMessage({ chunk: this.buffer.slice() });
                this.offset = 0;
            }
        }
        return true;
    }
}

registerProcessor('realtime-dsp-processor', RealtimeDspProcessor);
registerProcessor('dry-recorder-processor', DryRecorderProcessor);
