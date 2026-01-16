# Piano: Sistema Telefonico ESP con HA Broker

## Obiettivo
Creare un framework stile telefono dove gli ESP possono:
- Comunicare con Home Assistant (browser)
- Comunicare tra di loro (ESP↔ESP) con HA come broker
- Echo cancellation opzionale
- Card unificata che gestisce entrambi i flussi

---

## Fase 1: Echo Cancellation (Componente Opzionale)

### 1.1 Riportare `esp_aec` nel nuovo repo

```
esphome/components/
├── intercom_api/
│   ├── __init__.py
│   ├── intercom_api.h
│   ├── intercom_api.cpp
│   └── ...
└── esp_aec/              ← NUOVO (copiare da esphome-intercom)
    ├── __init__.py
    ├── esp_aec.h
    └── esp_aec.cpp
```

### 1.2 Modifiche a `intercom_api`

```cpp
// intercom_api.h - aggiungere
#ifdef USE_ESP_AEC
#include "esphome/components/esp_aec/esp_aec.h"
#endif

class IntercomApi {
  // ...
#ifdef USE_ESP_AEC
  void set_aec(esp_aec::EspAec *aec) { this->aec_ = aec; }
  esp_aec::EspAec *aec_{nullptr};
#endif
  bool aec_enabled_{false};
  void set_aec_enabled(bool enabled);
};
```

### 1.3 Applicare AEC in `on_microphone_data_()`

```cpp
void IntercomApi::on_microphone_data_(const uint8_t *data, size_t len) {
  // ... conversione 32→16 bit esistente ...

#ifdef USE_ESP_AEC
  if (this->aec_enabled_ && this->aec_ && this->aec_->is_initialized()) {
    // speaker_ref = ultimo buffer inviato allo speaker
    this->aec_->process(converted, speaker_ref, output, num_samples);
    // usa output invece di converted
  }
#endif

  // ... resto del codice ...
}
```

### 1.4 Switch per abilitare AEC

```yaml
# intercom-mini.yaml
esp_aec:
  id: aec_component
  sample_rate: 16000
  filter_length: 4

intercom_api:
  id: intercom
  microphone: mic_component
  speaker: spk_component
  aec_id: aec_component  # opzionale

switch:
  - platform: intercom_api
    intercom_api_id: intercom
    aec:
      name: "Echo Cancellation"
      icon: "mdi:ear-hearing"
```

### 1.5 Deliverable Fase 1
- [ ] Copiare `esp_aec` da esphome-intercom
- [ ] Modificare `__init__.py` per supportare `aec_id` opzionale
- [ ] Aggiungere `set_aec()` e buffer speaker reference
- [ ] Applicare AEC in `on_microphone_data_()`
- [ ] Creare switch platform per AEC
- [ ] Test: verificare che AEC riduca eco

---

## Fase 2: Entità per Sistema Telefonico

### 2.1 Nuove Entità ESP

```yaml
# Stato chiamata (text_sensor)
text_sensor:
  - platform: intercom_api
    call_state:
      name: "Call State"
      # IDLE | CALLING | RINGING | IN_CALL

    caller:
      name: "Caller"
      # Nome di chi sta chiamando (quando RINGING)

    target:
      name: "Target"
      # Nome di chi stiamo chiamando (quando CALLING)

# Selezione target (gestito da HA, non dall'ESP)
# L'ESP espone solo il nome corrente del target selezionato

# Buttons
button:
  - platform: intercom_api
    call:
      name: "Call"
      icon: "mdi:phone"
    answer:
      name: "Answer"
      icon: "mdi:phone-in-talk"
    hangup:
      name: "Hangup"
      icon: "mdi:phone-hangup"
    next_contact:
      name: "Next Contact"
      icon: "mdi:account-arrow-right"
```

### 2.2 Servizi ESPHome (chiamati da HA)

```cpp
// Nuovi metodi in IntercomApi
void incoming_call(const std::string &caller_name, const std::string &caller_ip, uint16_t caller_port);
void set_target(const std::string &target_name, const std::string &target_ip, uint16_t target_port);
void answer_call();
void hangup_call();
void initiate_call();  // chiama il target corrente
```

```yaml
# In __init__.py - registrare servizi
api:
  services:
    - service: incoming_call
      variables:
        caller_name: string
        caller_ip: string
        caller_port: int
      then:
        - lambda: 'id(intercom).incoming_call(caller_name, caller_ip, caller_port);'

    - service: set_target
      variables:
        target_name: string
        target_ip: string
        target_port: int
      then:
        - lambda: 'id(intercom).set_target(target_name, target_ip, target_port);'
```

### 2.3 Stati Chiamata (State Machine)

```
                    ┌──────────────────────────────────────┐
                    │                                      │
                    ▼                                      │
              ┌──────────┐                                 │
              │   IDLE   │◄────────────────────────────────┤
              └────┬─────┘                                 │
                   │                                       │
      ┌────────────┼────────────┐                         │
      │            │            │                         │
      ▼            ▼            │                         │
┌──────────┐ ┌──────────┐       │                         │
│ CALLING  │ │ RINGING  │       │                         │
│(outgoing)│ │(incoming)│       │                         │
└────┬─────┘ └────┬─────┘       │                         │
     │            │             │                         │
     │   answer   │             │                         │
     │      ┌─────┘             │                         │
     │      │                   │                         │
     ▼      ▼                   │  hangup/timeout         │
┌────────────────┐              │                         │
│    IN_CALL     │──────────────┴─────────────────────────┘
│  (streaming)   │
└────────────────┘
```

### 2.4 Deliverable Fase 2
- [ ] Aggiungere call_state_, caller_, target_ a IntercomApi
- [ ] Implementare state machine
- [ ] Creare text_sensor platform per stati
- [ ] Creare button platform per call/answer/hangup
- [ ] Registrare servizi ESPHome (incoming_call, set_target)
- [ ] Test: verificare transizioni stato

---

## Fase 3: HA Broker Automations

### 3.1 Script: Inizia Chiamata

```yaml
# In HA - scripts.yaml
intercom_call:
  alias: "Intercom: Initiate Call"
  mode: single
  fields:
    caller_device:
      description: "Device che chiama"
      selector:
        device:
          integration: esphome
    target_device:
      description: "Device da chiamare"
      selector:
        device:
          integration: esphome
  sequence:
    # Ottieni IP del target
    - variables:
        target_ip: >
          {{ device_attr(target_device, 'connections') | selectattr(0, 'eq', 'ip') | map(attribute=1) | first }}
        target_name: >
          {{ device_attr(target_device, 'name') }}
        caller_ip: >
          {{ device_attr(caller_device, 'connections') | selectattr(0, 'eq', 'ip') | map(attribute=1) | first }}
        caller_name: >
          {{ device_attr(caller_device, 'name') }}

    # Notifica il target: chiamata in arrivo
    - service: esphome.{{ target_device }}_incoming_call
      data:
        caller_name: "{{ caller_name }}"
        caller_ip: "{{ caller_ip }}"
        caller_port: 6054

    # Imposta il caller in stato CALLING
    - service: esphome.{{ caller_device }}_set_target
      data:
        target_name: "{{ target_name }}"
        target_ip: "{{ target_ip }}"
        target_port: 6054
```

### 3.2 Automation: Gestione Risposta

```yaml
# In HA - automations.yaml
- alias: "Intercom: Handle Answer"
  trigger:
    - platform: state
      entity_id:
        - sensor.intercom_mini_call_state
        - sensor.intercom_mini_2_call_state
        # ... altri dispositivi
      to: "ANSWERING"
  action:
    # Trova chi stava chiamando questo device
    - variables:
        answering_device: "{{ trigger.entity_id | replace('sensor.', '') | replace('_call_state', '') }}"
        caller_ip: "{{ states('sensor.' ~ answering_device ~ '_caller_ip') }}"

    # Trova il caller device
    - variables:
        caller_device: >
          {% for device in integration_entities('esphome') %}
            {% if state_attr(device, 'ip') == caller_ip %}
              {{ device | replace('sensor.', '') | replace('_call_state', '') }}
            {% endif %}
          {% endfor %}

    # Dì al caller di connettersi al target
    - service: esphome.{{ caller_device }}_connect_to
      data:
        host: "{{ states('sensor.' ~ answering_device ~ '_ip') }}"
        port: 6054
```

### 3.3 Automation: Gestione Hangup

```yaml
- alias: "Intercom: Handle Hangup"
  trigger:
    - platform: state
      entity_id:
        - sensor.intercom_mini_call_state
        - sensor.intercom_mini_2_call_state
      from: "IN_CALL"
      to: "IDLE"
  action:
    # Trova il peer e mandagli hangup
    - service: esphome.{{ peer_device }}_hangup
```

### 3.4 Deliverable Fase 3
- [ ] Script HA: intercom_call
- [ ] Script HA: intercom_answer
- [ ] Script HA: intercom_hangup
- [ ] Automation: gestione stati
- [ ] Automation: timeout chiamata
- [ ] Test: chiamata completa ESP-A → ESP-B

---

## Fase 4: Lista Contatti Dinamica

### 4.1 Template Sensor per Lista Dispositivi

```yaml
# In HA - configuration.yaml
template:
  - sensor:
      - name: "Intercom Devices"
        state: "{{ this.attributes.devices | length }}"
        attributes:
          devices: >
            {% set ns = namespace(devices=[]) %}
            {% for entity in states.sensor %}
              {% if '_call_state' in entity.entity_id and 'intercom' in entity.entity_id %}
                {% set device_id = entity.entity_id | replace('sensor.', '') | replace('_call_state', '') %}
                {% set ns.devices = ns.devices + [{
                  'id': device_id,
                  'name': state_attr(entity.entity_id, 'friendly_name') | replace(' Call State', ''),
                  'state': entity.state
                }] %}
              {% endif %}
            {% endfor %}
            {{ ns.devices }}
```

### 4.2 Aggiornamento Card

La card legge `sensor.intercom_devices` per popolare il dropdown.

---

## Fase 5: Card Unificata

### 5.1 Nuova Struttura Card

```javascript
// intercom-card.js
class IntercomCard extends HTMLElement {
  // Stati
  _mode = 'ha';  // 'ha' | 'esp'
  _selectedDevice = 'Home Assistant';
  _callState = 'IDLE';

  // Config
  setConfig(config) {
    this.config = {
      device_id: config.device_id,      // questo ESP
      host: config.host,                 // IP di questo ESP (per modo HA)
      ...config
    };
  }

  _render() {
    const isHA = this._selectedDevice === 'Home Assistant';
    const buttonText = this._getButtonText();
    const statusText = this._getStatusText();

    this.shadowRoot.innerHTML = `
      <div class="card">
        <div class="header">${this.config.name || 'Intercom'}</div>

        <!-- Dropdown selezione destinazione -->
        <select id="target">
          <option value="ha">Home Assistant</option>
          ${this._renderDeviceOptions()}
        </select>

        <!-- Stato chiamata -->
        <div class="status">${statusText}</div>

        <!-- Caller info (se RINGING) -->
        ${this._callState === 'RINGING' ? `
          <div class="caller">
            Call from: ${this._callerName}
          </div>
        ` : ''}

        <!-- Bottone principale -->
        <button class="call-button ${this._getButtonClass()}" id="btn">
          ${buttonText}
        </button>
      </div>
    `;
  }

  _getButtonText() {
    switch(this._callState) {
      case 'IDLE': return 'Call';
      case 'CALLING': return 'Cancel';
      case 'RINGING': return 'Answer';
      case 'IN_CALL': return 'Hangup';
    }
  }

  _getStatusText() {
    switch(this._callState) {
      case 'IDLE': return 'Ready';
      case 'CALLING': return `Calling ${this._selectedDevice}...`;
      case 'RINGING': return 'Incoming call';
      case 'IN_CALL': return 'In call';
    }
  }

  async _handleButton() {
    const isHA = this._selectedDevice === 'Home Assistant';

    switch(this._callState) {
      case 'IDLE':
        if (isHA) {
          // Modo attuale: TCP diretto verso HA
          await this._startHAStream();
        } else {
          // Modo ESP: chiama servizio HA broker
          await this._initiateESPCall();
        }
        break;

      case 'RINGING':
        await this._answerCall();
        break;

      case 'CALLING':
      case 'IN_CALL':
        await this._hangup();
        break;
    }
  }

  async _startHAStream() {
    // Codice esistente per streaming HA
  }

  async _initiateESPCall() {
    // Chiama script HA
    await this._hass.callService('script', 'intercom_call', {
      caller_device: this.config.device_id,
      target_device: this._selectedDeviceId
    });
  }
}
```

### 5.2 Sottoscrizione Stati

```javascript
set hass(hass) {
  this._hass = hass;

  // Sottoscrivi a cambiamenti stato
  const callStateEntity = `sensor.${this.config.device_id}_call_state`;
  const newState = hass.states[callStateEntity]?.state;

  if (newState !== this._callState) {
    this._callState = newState;
    this._render();
  }

  // Aggiorna lista dispositivi
  const devicesEntity = 'sensor.intercom_devices';
  this._availableDevices = hass.states[devicesEntity]?.attributes?.devices || [];
}
```

### 5.3 Deliverable Fase 5
- [ ] Refactor card per supportare due modi
- [ ] Dropdown selezione dispositivo
- [ ] Stati visuali (Ready, Calling, Ringing, In Call)
- [ ] Sottoscrizione a entity states
- [ ] Test: flusso completo da card

---

## Riepilogo Modifiche File

### Nuovi File
```
esphome/components/esp_aec/
├── __init__.py
├── esp_aec.h
└── esp_aec.cpp

homeassistant/
├── scripts/
│   └── intercom_scripts.yaml
└── automations/
    └── intercom_automations.yaml
```

### File Modificati
```
esphome/components/intercom_api/
├── __init__.py          # + aec_id, servizi
├── intercom_api.h       # + call state, AEC
├── intercom_api.cpp     # + state machine, AEC processing
├── switch.py            # + AEC switch (nuovo)
├── text_sensor.py       # call_state, caller, target (nuovo)
└── button.py            # call, answer, hangup (nuovo)

frontend/www/
└── intercom-card.js     # refactor completo

intercom-mini.yaml       # + esp_aec, nuove entità
```

---

## Timeline Suggerita

| Giorno | Fase | Ore Stimate |
|--------|------|-------------|
| 1 | Fase 1: Echo Cancellation | 3-4h |
| 2 | Fase 2: Entità + State Machine | 3-4h |
| 3 | Fase 3: HA Automations | 2-3h |
| 4 | Fase 4-5: Lista Contatti + Card | 3-4h |
| 5 | Testing + Bug Fixing | 2-3h |

---

## Note Tecniche

### Buffer Speaker Reference per AEC
L'AEC ha bisogno di sapere cosa sta uscendo dallo speaker per cancellarlo dal mic.
Serve un ring buffer che tiene gli ultimi N ms di audio inviato allo speaker.

```cpp
// In handle_message_ quando riceve AUDIO
if (this->aec_) {
  // Salva in speaker_ref_buffer_ prima di inviare allo speaker
  this->speaker_ref_buffer_.write(data, len);
}
```

### Sincronizzazione Timing AEC
Il frame AEC deve essere allineato temporalmente. L'ESP-SR AEC gestisce internamente
il delay estimation, ma serve che i buffer siano della dimensione corretta (frame_size).

### TCP Client Mode
Il metodo `connect_to()` già esiste ma potrebbe aver bisogno di modifiche per:
- Gestire riconnessione automatica
- Notificare stato connessione
- Gestire timeout
