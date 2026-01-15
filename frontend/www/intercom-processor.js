/**
 * Intercom AudioWorklet Processor
 * Based on Home Assistant's recorder-worklet.js
 * VERSION: 2.2.0 - Larger chunks (1024 samples = 64ms) to reduce WS flood
 *
 * This processor runs in a separate audio thread and converts
 * Float32 audio samples to Int16 PCM format.
 */

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this._targetSamples = 1024; // 64ms chunks @ 16kHz = ~15 msg/sec (was 256 = 62 msg/sec)
    this._frameCount = 0;
    this._chunksSent = 0;
    this._totalSamplesProcessed = 0;

    // Log initialization
    console.log("[IntercomProcessor] === INITIALIZED v2.1.0 ===");
    console.log("[IntercomProcessor] sampleRate:", sampleRate);
    console.log("[IntercomProcessor] targetSamples:", this._targetSamples);

    // Send init message to main thread
    this.port.postMessage({
      type: "debug",
      message: `Worklet initialized: sampleRate=${sampleRate}, target=${this._targetSamples}`
    });
  }

  process(inputList, _outputList, _parameters) {
    this._frameCount++;

    // Check input validity
    if (!inputList || inputList.length === 0) {
      if (this._frameCount % 500 === 0) {
        console.log("[IntercomProcessor] Frame", this._frameCount, "- no inputList");
      }
      return true;
    }

    if (!inputList[0] || inputList[0].length === 0) {
      if (this._frameCount % 500 === 0) {
        console.log("[IntercomProcessor] Frame", this._frameCount, "- no channels in inputList[0]");
      }
      return true;
    }

    const float32Data = inputList[0][0]; // First channel of first input
    if (!float32Data || float32Data.length === 0) {
      if (this._frameCount % 500 === 0) {
        console.log("[IntercomProcessor] Frame", this._frameCount, "- no data in channel 0");
      }
      return true;
    }

    // Log periodically
    if (this._frameCount % 200 === 1) {
      console.log("[IntercomProcessor] Frame", this._frameCount,
                  "- samples:", float32Data.length,
                  "bufferLen:", this._buffer.length,
                  "chunksSent:", this._chunksSent);
    }

    // Downsample if needed (48kHz -> 16kHz = take every 3rd sample)
    // sampleRate is a global in AudioWorklet scope
    const downsampleFactor = sampleRate > 40000 ? 3 : 1;

    // Accumulate samples
    for (let i = 0; i < float32Data.length; i += downsampleFactor) {
      this._buffer.push(float32Data[i]);
    }
    this._totalSamplesProcessed += float32Data.length;

    // When we have enough samples, convert and send
    while (this._buffer.length >= this._targetSamples) {
      const chunk = this._buffer.splice(0, this._targetSamples);

      // Convert Float32 (-1.0 to 1.0) to Int16 (-32768 to 32767)
      // Following HA's exact pattern from recorder-worklet.js
      const int16Data = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }

      this._chunksSent++;

      // Log chunk send
      if (this._chunksSent <= 5 || this._chunksSent % 50 === 0) {
        console.log("[IntercomProcessor] Sending chunk", this._chunksSent,
                    "- samples:", int16Data.length,
                    "- bytes:", int16Data.buffer.byteLength);
      }

      // Send to main thread (transferable for performance)
      try {
        this.port.postMessage({
          type: "audio",
          buffer: int16Data.buffer
        }, [int16Data.buffer]);
      } catch (err) {
        console.error("[IntercomProcessor] postMessage error:", err);
      }
    }

    return true; // Keep processor alive
  }
}

registerProcessor("intercom-processor", RecorderProcessor);
console.log("[IntercomProcessor] Processor registered");
