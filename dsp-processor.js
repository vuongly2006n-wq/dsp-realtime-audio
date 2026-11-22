class RealtimeDspProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.effect = 'dry';
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
            const data = event.data;
            if (data.effect !== undefined && data.effect !== this.effect) {
                this.effect = data.effect;
                this.resetBuffers();
            }
            if (data.gain !== undefined) {
                this.gain = data.gain;
            }
        };
    }

    resetBuffers() {
        this.xBuf.fill(0);
        for (let k = 0; k < this.combBufs.length; k++) {
            this.combBufs[k].fill(0);
            this.combPtrs[k] = 0;
        }
    }

    process(inputs, outputs) {
        const input = inputs[0];
        const output = outputs[0];
        if (!input || !input[0] || !output || !output[0]) {
            return true;
        }

        const inCh = input[0];
        const outL = output[0];
        const outR = output[1];
        const blockSize = inCh.length;
        const echoDelay = Math.round(0.3 * sampleRate);

        for (let i = 0; i < blockSize; i++) {
            const x = inCh[i];
            this.xBuf[this.xIdx] = x;
            let y = x;

            if (this.effect === 'echo') {
                const readIdx = (this.xIdx - echoDelay + this.xLen) % this.xLen;
                y = x + this.gain * this.xBuf[readIdx];
            } else if (this.effect === 'reverb') {
                const gSafe = Math.min(this.gain, 0.95);
                let sumComb = 0;
                for (let k = 0; k < this.combBufs.length; k++) {
                    const Dk = this.combDelays[k];
                    const ptr = this.combPtrs[k];
                    const cPrev = this.combBufs[k][ptr];
                    const xDelIdx = (this.xIdx - Dk + this.xLen) % this.xLen;
                    const cOut = this.xBuf[xDelIdx] + gSafe * cPrev;
                    this.combBufs[k][ptr] = cOut;
                    this.combPtrs[k] = (ptr + 1) % Dk;
                    sumComb += cOut;
                }
                y = x + 0.25 * sumComb;
            } else if (this.effect === 'flanger') {
                const d = (sampleRate / 1000) * (3 + 2 * Math.sin(this.lfoPhase));
                const dInt = Math.floor(d);
                const frac = d - dInt;
                const idx1 = (this.xIdx - dInt + this.xLen) % this.xLen;
                const idx2 = (this.xIdx - dInt - 1 + this.xLen) % this.xLen;
                const xDel = (1 - frac) * this.xBuf[idx1] + frac * this.xBuf[idx2];
                y = x + this.gain * xDel;

                this.lfoPhase += this.lfoInc;
                if (this.lfoPhase >= 2 * Math.PI) {
                    this.lfoPhase -= 2 * Math.PI;
                }
            }

            const yOut = Math.tanh(y);
            outL[i] = yOut;
            if (outR) {
                outR[i] = yOut;
            }

            this.xIdx = (this.xIdx + 1) % this.xLen;
        }

        return true;
    }
}

registerProcessor('realtime-dsp-processor', RealtimeDspProcessor);