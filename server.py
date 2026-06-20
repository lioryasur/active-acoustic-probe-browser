"""Static file and polling-signaling server for the browser probe prototype."""

from __future__ import annotations

import argparse
import json
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse


ROOT = Path(__file__).resolve().parent
ROOMS: dict[str, dict[str, Any]] = {}
ROOM_LOCK = threading.Lock()


def json_bytes(payload: Any) -> bytes:
    return json.dumps(payload, indent=2).encode("utf-8")


def room_state(room: str) -> dict[str, Any]:
    with ROOM_LOCK:
        return ROOMS.setdefault(room, {"next_id": 1, "messages": []})


class ProbeRequestHandler(SimpleHTTPRequestHandler):
    server_version = "BrowserProbeServer/0.1"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, status: int, payload: Any) -> None:
        body = json_bytes(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> Any:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def parse_room_api(self) -> tuple[str, str] | None:
        parsed = urlparse(self.path)
        parts = [unquote(part) for part in parsed.path.split("/") if part]
        if len(parts) < 3 or parts[0] != "api" or parts[1] != "rooms":
            return None
        room = parts[2].strip()
        action = parts[3] if len(parts) > 3 else ""
        if not room:
            return None
        return room, action

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            self.send_json(200, {"ok": True, "time": time.time()})
            return

        route = self.parse_room_api()
        if route and route[1] == "messages":
            room, _ = route
            query = parse_qs(parsed.query)
            after = int(query.get("after", ["0"])[0] or "0")
            current = room_state(room)
            with ROOM_LOCK:
                messages = [msg for msg in current["messages"] if int(msg["id"]) > after]
                next_id = current["next_id"]
            self.send_json(200, {"room": room, "nextId": next_id, "messages": messages})
            return

        super().do_GET()

    def do_POST(self) -> None:  # noqa: N802
        route = self.parse_room_api()
        if not route:
            self.send_json(404, {"error": "unknown API endpoint"})
            return

        room, action = route
        if action == "reset":
            with ROOM_LOCK:
                ROOMS[room] = {"next_id": 1, "messages": []}
            self.send_json(200, {"room": room, "reset": True})
            return

        if action == "messages":
            try:
                body = self.read_json()
                sender = str(body.get("from") or "").strip()
                payload = body.get("payload")
                if not sender or not isinstance(payload, dict):
                    self.send_json(400, {"error": "expected JSON with 'from' and object 'payload'"})
                    return
                with ROOM_LOCK:
                    current = ROOMS.setdefault(room, {"next_id": 1, "messages": []})
                    message = {
                        "id": current["next_id"],
                        "from": sender,
                        "payload": payload,
                        "time": time.time(),
                    }
                    current["next_id"] += 1
                    current["messages"].append(message)
                    current["messages"] = current["messages"][-500:]
                self.send_json(200, {"room": room, "message": message})
            except json.JSONDecodeError as exc:
                self.send_json(400, {"error": f"invalid JSON: {exc}"})
            return

        self.send_json(404, {"error": "unknown room action"})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), ProbeRequestHandler)
    print(f"Serving browser acoustic probe call at http://127.0.0.1:{args.port}/")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
