/**
 * Intercom AudioWorklet Processor
 *
 * Captures audio from microphone and converts it to PCM format
 * suitable for transmission to ESP32.
 */

class IntercomProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(256); // 256 samples = 512 bytes at 16-bit
    this._bufferIndex = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const inputChannel = input[0];

    for (let i = 0; i < inputChannel.length; i++) {
      this._buffer[this._bufferIndex++] = inputChannel[i];

      // When buffer is full, send to main thread
      if (this._bufferIndex >= this._buffer.length) {
        // Convert Float32 to Int16 PCM
        const int16Buffer = new Int16Array(this._buffer.length);
        for (let j = 0; j < this._buffer.length; j++) {
          // Clamp and convert to 16-bit signed integer
          const sample = Math.max(-1, Math.min(1, this._buffer[j]));
          int16Buffer[j] = Math.round(sample * 32767);
        }

        // Send to main thread
        this.port.postMessage({
          type: "audio",
          buffer: int16Buffer.buffer,
        }, [int16Buffer.buffer]);

        this._bufferIndex = 0;
      }
    }

    return true;
  }
}

registerProcessor("intercom-processor", IntercomProcessor);
