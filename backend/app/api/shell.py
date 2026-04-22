"""WebSocket SSH terminal proxy.

Accepts a WebSocket connection, negotiates credentials, then bridges
the connection to an SSH PTY on the target worker.

Protocol:
  1. Client sends JSON text frame: {"username": "cltbld", "password": "...", "cols": 120, "rows": 30}
  2. Server attempts SSH connection and sends back {"ok": true} or {"ok": false, "error": "..."}
  3. After ok=true: binary frames carry raw terminal I/O in both directions
  4. Resize: client sends JSON text frame {"type": "resize", "cols": N, "rows": N} at any time
"""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

import asyncssh
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..config import settings
from ..hosts import worker_fqdn

log = logging.getLogger(__name__)

router = APIRouter(prefix="/workers", tags=["shell"])


def _resolve_known_hosts() -> str | None:
    """Return a known_hosts source for asyncssh, or raise if misconfigured."""
    path = Path(settings.ssh_known_hosts_path)
    if path.exists():
        return str(path)
    if settings.ssh_insecure_skip_host_check:
        log.warning(
            "SSH host key checking disabled (SSH_INSECURE_SKIP_HOST_CHECK=true). "
            "Set SSH_KNOWN_HOSTS_PATH for production."
        )
        return None
    raise RuntimeError(
        f"No SSH known_hosts file found at {settings.ssh_known_hosts_path!r}. "
        "Populate the secret or set SSH_INSECURE_SKIP_HOST_CHECK=true for local dev."
    )


@router.websocket("/{hostname:path}/shell")
async def worker_shell(websocket: WebSocket, hostname: str) -> None:
    await websocket.accept()
    fqdn = worker_fqdn(hostname)

    # Step 1: receive credentials
    try:
        raw = await asyncio.wait_for(websocket.receive_text(), timeout=30)
        creds = json.loads(raw)
    except Exception:
        await websocket.close(1008, "Expected credential JSON")
        return

    username = creds.get("username") or "cltbld"
    password = creds.get("password") or None
    cols = int(creds.get("cols") or 120)
    rows = int(creds.get("rows") or 30)

    # Step 2: attempt SSH connection
    try:
        known_hosts = _resolve_known_hosts()
    except RuntimeError as e:
        await websocket.send_text(json.dumps({"ok": False, "error": str(e)}))
        await websocket.close()
        return

    try:
        conn = await asyncio.wait_for(
            asyncssh.connect(
                fqdn,
                username=username,
                password=password,
                known_hosts=known_hosts,
                connect_timeout=15,
            ),
            timeout=20,
        )
    except asyncssh.PermissionDenied:
        await websocket.send_text(json.dumps({"ok": False, "error": "Permission denied"}))
        await websocket.close()
        return
    except asyncssh.DisconnectError as e:
        await websocket.send_text(json.dumps({"ok": False, "error": f"SSH disconnect: {e}"}))
        await websocket.close()
        return
    except (OSError, asyncio.TimeoutError) as e:
        await websocket.send_text(json.dumps({"ok": False, "error": f"Cannot reach host: {e}"}))
        await websocket.close()
        return
    except Exception as e:
        await websocket.send_text(json.dumps({"ok": False, "error": str(e)}))
        await websocket.close()
        return

    await websocket.send_text(json.dumps({"ok": True}))

    # Step 3: open interactive shell with PTY
    async with conn:
        process = await conn.create_process(
            term_type="xterm-256color",
            term_size=(cols, rows),
        )

        stop = asyncio.Event()

        async def ws_to_ssh() -> None:
            try:
                while not stop.is_set():
                    msg = await websocket.receive()
                    if msg["type"] == "websocket.disconnect":
                        break
                    if "text" in msg and msg["text"]:
                        # Resize event or stray JSON
                        try:
                            data = json.loads(msg["text"])
                            if data.get("type") == "resize":
                                process.change_terminal_size(int(data["cols"]), int(data["rows"]))
                        except (json.JSONDecodeError, KeyError):
                            process.stdin.write(msg["text"])
                    elif "bytes" in msg and msg["bytes"]:
                        process.stdin.write(msg["bytes"].decode("utf-8", errors="replace"))
            except WebSocketDisconnect:
                pass
            finally:
                stop.set()
                try:
                    process.stdin.write_eof()
                except Exception:
                    pass

        async def ssh_to_ws() -> None:
            try:
                while not stop.is_set():
                    chunk = await process.stdout.read(4096)
                    if not chunk:
                        break
                    payload = chunk if isinstance(chunk, bytes) else chunk.encode("utf-8", errors="replace")
                    await websocket.send_bytes(payload)
            except (WebSocketDisconnect, ConnectionResetError):
                pass
            except Exception as e:
                log.debug("ssh_to_ws ended: %s", e)
            finally:
                stop.set()

        await asyncio.gather(ws_to_ssh(), ssh_to_ws(), return_exceptions=True)
        log.info("Shell session closed: %s@%s", username, fqdn)


@router.websocket("/{hostname:path}/vnc")
async def worker_vnc(websocket: WebSocket, hostname: str) -> None:
    """WebSocket → TCP proxy for VNC (port 5900).

    noVNC speaks the RFB protocol directly; we just forward bytes.
    The 'binary' subprotocol header is required by noVNC.
    """
    await websocket.accept(subprotocol="binary")
    fqdn = worker_fqdn(hostname)

    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(fqdn, 5900),
            timeout=10,
        )
    except (OSError, asyncio.TimeoutError) as e:
        log.warning("VNC connect failed for %s: %s", fqdn, e)
        await websocket.close(1011, f"Cannot reach {fqdn}:5900")
        return

    log.info("VNC session opened: %s", fqdn)
    stop = asyncio.Event()

    async def ws_to_tcp() -> None:
        try:
            async for data in websocket.iter_bytes():
                writer.write(data)
                await writer.drain()
        except (WebSocketDisconnect, ConnectionResetError):
            pass
        finally:
            stop.set()
            try:
                writer.close()
            except Exception:
                pass

    async def tcp_to_ws() -> None:
        try:
            while not stop.is_set():
                data = await reader.read(32768)
                if not data:
                    break
                await websocket.send_bytes(data)
        except (WebSocketDisconnect, ConnectionResetError):
            pass
        except Exception as e:
            log.debug("VNC tcp_to_ws ended: %s", e)
        finally:
            stop.set()

    await asyncio.gather(ws_to_tcp(), tcp_to_ws(), return_exceptions=True)
    log.info("VNC session closed: %s", fqdn)
