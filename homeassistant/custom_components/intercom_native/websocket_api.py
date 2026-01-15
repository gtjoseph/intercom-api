"""WebSocket API for Intercom Native integration."""
# VERSION: 4.0.3 - Enhanced debug logging

import asyncio
import base64
import logging
from typing import Any, Callable, Dict, Optional

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import (
    DOMAIN,
    INTERCOM_PORT,
)
from .tcp_client import IntercomTcpClient

_LOGGER = logging.getLogger(__name__)

# WebSocket command types
WS_TYPE_START = f"{DOMAIN}/start"
WS_TYPE_STOP = f"{DOMAIN}/stop"
WS_TYPE_AUDIO = f"{DOMAIN}/audio"
WS_TYPE_LIST = f"{DOMAIN}/list_devices"

# Active sessions: device_id -> IntercomSession
_sessions: Dict[str, "IntercomSession"] = {}


class IntercomSession:
    """Manages a single intercom session between browser and ESP."""

    def __init__(
        self,
        hass: HomeAssistant,
        device_id: str,
        host: str,
    ):
        """Initialize session."""
        self.hass = hass
        self.device_id = device_id
        self.host = host

        self._tcp_client: Optional[IntercomTcpClient] = None
        self._active = False
        self._audio_sent_count = 0
        self._audio_recv_count = 0

        _LOGGER.debug("[Session %s] Created for host %s", device_id, host)

    async def start(self) -> bool:
        """Start the intercom session."""
        _LOGGER.info("[Session %s] Starting... host=%s", self.device_id, self.host)

        if self._active:
            _LOGGER.warning("[Session %s] Already active!", self.device_id)
            return True

        session = self

        def on_audio(data: bytes) -> None:
            """Handle audio from ESP - fire event to browser."""
            session._audio_recv_count += 1

            # Log EVERY 50 packets to track flow
            if session._audio_recv_count <= 5 or session._audio_recv_count % 50 == 0:
                _LOGGER.warning(
                    "[Session %s] ESP->Browser #%d: %d bytes, active=%s",
                    session.device_id, session._audio_recv_count, len(data), session._active
                )

            if not session._active:
                _LOGGER.warning("[Session %s] Dropping audio #%d - session not active!",
                               session.device_id, session._audio_recv_count)
                return

            try:
                session.hass.bus.async_fire(
                    "intercom_audio",
                    {
                        "device_id": session.device_id,
                        "audio": base64.b64encode(data).decode("ascii"),
                    }
                )
            except Exception as err:
                _LOGGER.error("[Session %s] Error firing event #%d: %s",
                             session.device_id, session._audio_recv_count, err)

        def on_connected() -> None:
            _LOGGER.info("[Session %s] TCP connected to %s", session.device_id, session.host)

        def on_disconnected() -> None:
            _LOGGER.info("[Session %s] TCP disconnected", session.device_id)
            session._active = False

        _LOGGER.info("[Session %s] Creating TCP client...", self.device_id)
        self._tcp_client = IntercomTcpClient(
            host=self.host,
            port=INTERCOM_PORT,
            on_audio=on_audio,
            on_connected=on_connected,
            on_disconnected=on_disconnected,
        )

        _LOGGER.info("[Session %s] Calling connect()...", self.device_id)
        if await self._tcp_client.connect():
            _LOGGER.info("[Session %s] Connect OK, calling start_stream()...", self.device_id)
            if await self._tcp_client.start_stream():
                self._active = True
                _LOGGER.info("[Session %s] Started successfully!", self.device_id)
                return True
            else:
                _LOGGER.error("[Session %s] Failed to start stream", self.device_id)
                await self._tcp_client.disconnect()
        else:
            _LOGGER.error("[Session %s] Failed to connect TCP", self.device_id)

        return False

    async def stop(self) -> None:
        """Stop the intercom session."""
        _LOGGER.info(
            "[Session %s] Stopping... sent=%d recv=%d",
            self.device_id, self._audio_sent_count, self._audio_recv_count
        )
        self._active = False

        if self._tcp_client:
            await self._tcp_client.stop_stream()
            await self._tcp_client.disconnect()
            self._tcp_client = None

    async def handle_audio(self, data: bytes) -> None:
        """Handle audio from browser (base64 decoded)."""
        self._audio_sent_count += 1
        if self._audio_sent_count <= 5 or self._audio_sent_count % 100 == 0:
            _LOGGER.info(
                "[Session %s] Browser->ESP audio #%d: %d bytes, active=%s, tcp=%s",
                self.device_id, self._audio_sent_count, len(data),
                self._active, self._tcp_client is not None
            )

        if self._active and self._tcp_client:
            result = await self._tcp_client.send_audio(data)
            if self._audio_sent_count <= 5:
                _LOGGER.info("[Session %s] send_audio result: %s", self.device_id, result)


def async_register_websocket_api(hass: HomeAssistant) -> None:
    """Register WebSocket API commands."""
    _LOGGER.info("Registering Intercom Native WebSocket API v4.0.0 (JSON audio)")
    websocket_api.async_register_command(hass, websocket_start)
    websocket_api.async_register_command(hass, websocket_stop)
    websocket_api.async_register_command(hass, websocket_audio)
    websocket_api.async_register_command(hass, websocket_list_devices)


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TYPE_START,
        vol.Required("device_id"): str,
        vol.Required("host"): str,
    }
)
@websocket_api.async_response
async def websocket_start(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: Dict[str, Any],
) -> None:
    """Start intercom session."""
    device_id = msg["device_id"]
    host = msg["host"]
    msg_id = msg["id"]

    _LOGGER.info("=== START REQUEST === device=%s host=%s msg_id=%s", device_id, host, msg_id)

    try:
        # Stop existing session if any
        if device_id in _sessions:
            _LOGGER.info("Stopping existing session for %s", device_id)
            old_session = _sessions.pop(device_id)
            await old_session.stop()
            _LOGGER.info("Old session stopped")

        # Create new session
        _LOGGER.info("Creating new session...")
        session = IntercomSession(hass=hass, device_id=device_id, host=host)

        _LOGGER.info("Calling session.start()...")
        if await session.start():
            _sessions[device_id] = session
            _LOGGER.info("=== SESSION STARTED === device=%s - sending result", device_id)
            connection.send_result(msg_id, {"success": True})
            _LOGGER.info("Result sent to browser")
        else:
            _LOGGER.error("=== SESSION FAILED === device=%s - sending error", device_id)
            connection.send_error(msg_id, "connection_failed", f"Failed to connect to {host}")
            _LOGGER.info("Error sent to browser")
    except Exception as err:
        _LOGGER.exception("=== EXCEPTION in websocket_start === %s", err)
        connection.send_error(msg_id, "exception", str(err))


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TYPE_STOP,
        vol.Required("device_id"): str,
    }
)
@websocket_api.async_response
async def websocket_stop(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: Dict[str, Any],
) -> None:
    """Stop intercom session."""
    device_id = msg["device_id"]
    msg_id = msg["id"]

    _LOGGER.info("=== STOP === device=%s", device_id)

    session = _sessions.pop(device_id, None)
    if session:
        await session.stop()
        _LOGGER.info("Session stopped for %s", device_id)
    else:
        _LOGGER.warning("No session found for %s", device_id)

    connection.send_result(msg_id, {"success": True})


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TYPE_AUDIO,
        vol.Required("device_id"): str,
        vol.Required("audio"): str,  # base64 encoded audio
    }
)
@callback
def websocket_audio(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: Dict[str, Any],
) -> None:
    """Handle audio from browser (JSON with base64) - non-blocking."""
    device_id = msg["device_id"]
    audio_b64 = msg["audio"]

    session = _sessions.get(device_id)
    if not session:
        _LOGGER.warning("[Audio] No session for device %s", device_id)
        return
    if not session._active:
        _LOGGER.warning("[Audio] Session not active for device %s", device_id)
        return

    try:
        audio_data = base64.b64decode(audio_b64)
        # Fire and forget - don't block
        hass.async_create_task(session.handle_audio(audio_data))
    except Exception as err:
        _LOGGER.error("Error decoding audio: %s", err)


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TYPE_LIST,
    }
)
@callback
def websocket_list_devices(
    hass: HomeAssistant,
    connection: websocket_api.ActiveConnection,
    msg: Dict[str, Any],
) -> None:
    """List devices with intercom capability."""
    from homeassistant.helpers import entity_registry as er
    from homeassistant.helpers import device_registry as dr

    devices = []
    entity_registry = er.async_get(hass)
    device_registry = dr.async_get(hass)

    for entity in entity_registry.entities.values():
        if entity.domain == "switch" and entity.entity_id.endswith("_intercom"):
            device = device_registry.async_get(entity.device_id)
            if device:
                devices.append(
                    {
                        "device_id": entity.device_id,
                        "name": device.name,
                        "entity_id": entity.entity_id,
                    }
                )

    connection.send_result(msg["id"], {"devices": devices})
