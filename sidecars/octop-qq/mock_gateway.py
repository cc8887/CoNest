"""Loopback-only QQ Open Platform WebSocket and HTTP fixture for real Octop."""

import asyncio
import json
import sys
from typing import Any

from aiohttp import web


FIXTURE_APP_ID = "100200300"
FIXTURE_SECRET = "octop-qq-fixture-only"
FIXTURE_TOKEN = "offline-qq-token"
GROUP_AND_C2C = 1 << 25


class FakeQQ:
    """Expose only the API routes needed by the passive QQ integration."""

    def __init__(self) -> None:
        self.origin = ""
        self.sequence = 1
        self.socket: web.WebSocketResponse | None = None
        self.sent: list[dict[str, Any]] = []
        self.next_failure = ""
        self.resume_count = 0

    async def token(self, request: web.Request) -> web.Response:
        body = await request.json()
        if body != {"appId": FIXTURE_APP_ID, "clientSecret": FIXTURE_SECRET}:
            raise web.HTTPUnauthorized()
        return web.json_response({"access_token": FIXTURE_TOKEN, "expires_in": 7200})

    async def gateway(self, request: web.Request) -> web.Response:
        self.check_token(request)
        return web.json_response({"url": self.origin.replace("http://", "ws://", 1) + "/socket"})

    def check_token(self, request: web.Request) -> None:
        if request.headers.get("Authorization") != f"QQBot {FIXTURE_TOKEN}":
            raise web.HTTPUnauthorized()

    async def websocket(self, request: web.Request) -> web.WebSocketResponse:
        socket = web.WebSocketResponse()
        await socket.prepare(request)
        await socket.send_json({"op": 10, "d": {"heartbeat_interval": 2000}})
        try:
            async for message in socket:
                packet = message.json()
                if packet.get("op") == 2:
                    identify = packet["d"]
                    if identify.get("token") != f"QQBot {FIXTURE_TOKEN}" or identify.get("intents") != GROUP_AND_C2C:
                        await socket.close(code=4000)
                        return socket
                    await socket.send_json({"op": 0, "t": "READY", "s": 1,
                                            "d": {"session_id": "qq-fixture", "user": {"id": FIXTURE_APP_ID}}})
                    self.socket = socket
                elif packet.get("op") == 6:
                    resume = packet["d"]
                    if resume.get("token") != f"QQBot {FIXTURE_TOKEN}" or resume.get("session_id") != "qq-fixture" or resume.get("seq") != self.sequence:
                        await socket.close(code=4000)
                        return socket
                    self.resume_count += 1
                    self.socket = socket
                    await socket.send_json({"op": 0, "t": "RESUMED", "s": self.sequence, "d": {}})
                elif packet.get("op") == 1:
                    await socket.send_json({"op": 11})
        finally:
            if self.socket is socket:
                self.socket = None
        return socket

    async def send(self, request: web.Request) -> web.Response:
        self.check_token(request)
        body = await request.json()
        if body.get("msg_type") != 0 or not isinstance(body.get("msg_id"), str) or not isinstance(body.get("msg_seq"), int):
            raise web.HTTPBadRequest(text="Expected a passive text reply")
        failure, self.next_failure = self.next_failure, ""
        if failure == "429":
            return web.json_response({"code": 22009}, status=429)
        index = len(self.sent) + 1
        self.sent.append({"path": request.path, "body": body})
        if failure == "disconnect":
            if request.transport:
                request.transport.abort()
            return web.Response()
        return web.json_response({"id": f"fixture-reply-{index}", "ext_info": {"ref_idx": f"fixture-reference-{index}"}})

    async def events(self, request: web.Request) -> web.Response:
        socket = self.socket
        if not socket or socket.closed:
            raise web.HTTPConflict(text="QQ bridge is disconnected")
        events = await request.json()
        if not isinstance(events, list):
            raise web.HTTPBadRequest(text="Expected an array of native event fixtures")
        for event in events:
            self.sequence += 1
            await socket.send_json({"op": 0, "t": event["type"], "s": self.sequence, "d": event["data"]})
        return web.json_response({"sent": len(events)})

    async def list_sent(self, request: web.Request) -> web.Response:
        return web.json_response(self.sent)

    async def fail_next(self, request: web.Request) -> web.Response:
        body = await request.json()
        if body.get("mode") not in ("429", "disconnect"):
            raise web.HTTPBadRequest()
        self.next_failure = body["mode"]
        return web.json_response({"ok": True})

    async def reconnect(self, request: web.Request) -> web.Response:
        if self.socket is None or self.socket.closed:
            raise web.HTTPConflict(text="QQ bridge is disconnected")
        await self.socket.send_json({"op": 7})
        return web.json_response({"ok": True})

    async def status(self, request: web.Request) -> web.Response:
        return web.json_response({"connected": bool(self.socket and not self.socket.closed), "resumes": self.resume_count})


async def serve() -> None:
    fake = FakeQQ()
    app = web.Application()
    app.add_routes([
        web.post("/app/getAppAccessToken", fake.token), web.get("/gateway/bot", fake.gateway),
        web.get("/socket", fake.websocket), web.post("/v2/{scope:groups|users}/{peer}/messages", fake.send),
        web.post("/_fixture/events", fake.events), web.get("/_fixture/sent", fake.list_sent),
        web.post("/_fixture/fail-next", fake.fail_next),
        web.post("/_fixture/reconnect", fake.reconnect), web.get("/_fixture/status", fake.status),
    ])
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = runner.addresses[0][1]
    fake.origin = f"http://127.0.0.1:{port}"
    print(json.dumps({"type": "mockReady", "origin": fake.origin}), flush=True)
    reader = asyncio.StreamReader()
    loop = asyncio.get_running_loop()
    transport, _ = await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
    try:
        await reader.read()
    finally:
        transport.close()
        if fake.socket:
            await fake.socket.close()
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(serve())
