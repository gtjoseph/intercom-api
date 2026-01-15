/**
 * Intercom Card - Lovelace custom card for intercom_native integration
 *
 * Provides bidirectional audio streaming between browser and ESP32
 * via Home Assistant WebSocket API.
 */

class IntercomCard extends HTMLElement {
  static get properties() {
    return {
      hass: {},
      config: {},
    };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._active = false;
    this._binaryHandlerId = null;
    this._audioContext = null;
    this._mediaStream = null;
    this._workletNode = null;
    this._gainNode = null;
  }

  setConfig(config) {
    if (!config.device_id) {
      throw new Error("You need to define a device_id");
    }
    if (!config.host) {
      throw new Error("You need to define a host (ESP IP address)");
    }
    this.config = config;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
  }

  _render() {
    const name = this.config.name || "Intercom";

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
        }
        .card {
          background: var(--ha-card-background, var(--card-background-color, white));
          border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, 0 2px 6px rgba(0,0,0,0.1));
          padding: 16px;
        }
        .header {
          font-size: 1.2em;
          font-weight: 500;
          margin-bottom: 16px;
          color: var(--primary-text-color);
        }
        .button-container {
          display: flex;
          justify-content: center;
          margin-bottom: 16px;
        }
        .intercom-button {
          width: 100px;
          height: 100px;
          border-radius: 50%;
          border: none;
          cursor: pointer;
          font-size: 1em;
          font-weight: bold;
          transition: all 0.2s ease;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .intercom-button.off {
          background: var(--primary-color, #03a9f4);
          color: white;
        }
        .intercom-button.off:hover {
          background: var(--primary-color-light, #4fc3f7);
          transform: scale(1.05);
        }
        .intercom-button.on {
          background: #f44336;
          color: white;
          animation: pulse 1.5s infinite;
        }
        .intercom-button.on:hover {
          background: #d32f2f;
        }
        @keyframes pulse {
          0% { box-shadow: 0 0 0 0 rgba(244, 67, 54, 0.4); }
          70% { box-shadow: 0 0 0 15px rgba(244, 67, 54, 0); }
          100% { box-shadow: 0 0 0 0 rgba(244, 67, 54, 0); }
        }
        .volume-container {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 12px;
        }
        .volume-label {
          color: var(--secondary-text-color);
          font-size: 0.9em;
          min-width: 60px;
        }
        .volume-slider {
          flex: 1;
          -webkit-appearance: none;
          height: 6px;
          border-radius: 3px;
          background: var(--divider-color, #e0e0e0);
          outline: none;
        }
        .volume-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: var(--primary-color, #03a9f4);
          cursor: pointer;
        }
        .status {
          text-align: center;
          color: var(--secondary-text-color);
          font-size: 0.9em;
        }
        .status-indicator {
          display: inline-block;
          width: 10px;
          height: 10px;
          border-radius: 50%;
          margin-right: 6px;
        }
        .status-indicator.connected {
          background: #4caf50;
        }
        .status-indicator.disconnected {
          background: #9e9e9e;
        }
        .error {
          color: #f44336;
          font-size: 0.85em;
          text-align: center;
          margin-top: 8px;
        }
      </style>
      <div class="card">
        <div class="header">${name}</div>
        <div class="button-container">
          <button class="intercom-button ${this._active ? "on" : "off"}" id="toggleBtn">
            ${this._active ? "STOP" : "START"}
          </button>
        </div>
        <div class="volume-container">
          <span class="volume-label">Volume</span>
          <input type="range" class="volume-slider" id="volumeSlider"
                 min="0" max="100" value="${this.config.volume || 80}">
        </div>
        <div class="status">
          <span class="status-indicator ${this._active ? "connected" : "disconnected"}"></span>
          ${this._active ? "Streaming" : "Ready"}
        </div>
        <div class="error" id="errorMsg"></div>
      </div>
    `;

    // Bind events
    this.shadowRoot.getElementById("toggleBtn").addEventListener("click", () => this._toggle());
    this.shadowRoot.getElementById("volumeSlider").addEventListener("input", (e) => this._setVolume(e.target.value));
  }

  async _toggle() {
    if (this._active) {
      await this._stop();
    } else {
      await this._start();
    }
  }

  async _start() {
    try {
      this._showError("");

      // Request microphone permission (requires HTTPS or localhost)
      this._mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      // Create AudioContext
      this._audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 16000,
      });

      // Load AudioWorklet processor
      await this._audioContext.audioWorklet.addModule(
        "/local/intercom-processor.js"
      );

      // Create nodes
      const source = this._audioContext.createMediaStreamSource(this._mediaStream);
      this._workletNode = new AudioWorkletNode(this._audioContext, "intercom-processor");
      this._gainNode = this._audioContext.createGain();

      // Connect: source -> worklet -> gain -> destination (for monitoring)
      source.connect(this._workletNode);
      this._workletNode.connect(this._gainNode);
      // Don't connect to destination to avoid feedback

      // Handle audio from worklet (to send to ESP)
      this._workletNode.port.onmessage = (event) => {
        if (event.data.type === "audio") {
          this._sendAudio(event.data.buffer);
        }
      };

      // Start WebSocket session
      const result = await this._hass.connection.sendMessagePromise({
        type: "intercom_native/start",
        device_id: this.config.device_id,
        host: this.config.host,
      });

      if (result.success) {
        this._binaryHandlerId = result.binary_handler_id;

        // Subscribe to binary messages (audio from ESP)
        this._hass.connection.socket.addEventListener("message", this._handleBinaryMessage.bind(this));

        this._active = true;
        this._render();
      } else {
        throw new Error("Failed to start intercom session");
      }
    } catch (err) {
      console.error("Intercom start error:", err);
      this._showError(err.message);
      await this._cleanup();
    }
  }

  async _stop() {
    try {
      // Stop WebSocket session
      await this._hass.connection.sendMessagePromise({
        type: "intercom_native/stop",
        device_id: this.config.device_id,
      });
    } catch (err) {
      console.error("Intercom stop error:", err);
    }

    await this._cleanup();
    this._active = false;
    this._render();
  }

  async _cleanup() {
    // Stop media stream
    if (this._mediaStream) {
      this._mediaStream.getTracks().forEach((track) => track.stop());
      this._mediaStream = null;
    }

    // Close AudioContext
    if (this._audioContext) {
      await this._audioContext.close();
      this._audioContext = null;
    }

    this._workletNode = null;
    this._gainNode = null;
    this._binaryHandlerId = null;
  }

  _sendAudio(buffer) {
    if (!this._active || !this._binaryHandlerId) return;

    // Send binary data to HA
    // The binary handler ID tells HA which session this belongs to
    const data = new Uint8Array(buffer);
    this._hass.connection.socket.send(data);
  }

  _handleBinaryMessage(event) {
    if (!(event.data instanceof ArrayBuffer)) return;
    if (!this._active || !this._audioContext) return;

    // Play received audio
    const audioData = new Int16Array(event.data);

    // Convert Int16 to Float32
    const float32 = new Float32Array(audioData.length);
    for (let i = 0; i < audioData.length; i++) {
      float32[i] = audioData[i] / 32768.0;
    }

    // Create and play buffer
    const audioBuffer = this._audioContext.createBuffer(1, float32.length, 16000);
    audioBuffer.getChannelData(0).set(float32);

    const bufferSource = this._audioContext.createBufferSource();
    bufferSource.buffer = audioBuffer;
    bufferSource.connect(this._gainNode);
    this._gainNode.connect(this._audioContext.destination);
    bufferSource.start();
  }

  _setVolume(value) {
    const volume = value / 100;
    if (this._gainNode) {
      this._gainNode.gain.value = volume;
    }
    // Also set ESP volume via service call
    if (this._hass && this.config.volume_entity) {
      this._hass.callService("number", "set_value", {
        entity_id: this.config.volume_entity,
        value: value,
      });
    }
  }

  _showError(message) {
    const errorEl = this.shadowRoot.getElementById("errorMsg");
    if (errorEl) {
      errorEl.textContent = message;
    }
  }

  getCardSize() {
    return 3;
  }

  static getConfigElement() {
    return document.createElement("intercom-card-editor");
  }

  static getStubConfig() {
    return {
      device_id: "",
      host: "",
      name: "Intercom",
    };
  }
}

customElements.define("intercom-card", IntercomCard);

// Register card
window.customCards = window.customCards || [];
window.customCards.push({
  type: "intercom-card",
  name: "Intercom Card",
  description: "Bidirectional audio intercom with ESP32",
});
