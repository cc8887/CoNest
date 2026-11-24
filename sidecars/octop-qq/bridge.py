"""Local stdio bridge from the pinned Octop QQ transport into CoNest."""

import asyncio
from collections.abc import AsyncIterator, Callable
from datetime import datetime, timezone
import json
import logging
import os
import re
import stat
import sys
import time
from typing import Any

from octop_gateway import ChannelManager, InboundMessage, MessageEvent
from octop_gateway.channels.qq import QQChannel, QQConfig
from octop_gateway.channels.qq.channel import INTENT_GROUP_AND_C2C
from octop_gateway.group_context import GroupContextConfig
from octop_gateway.models import TextContent


EVENT_SCOPES = {
    "C2C_MESSAGE_CREATE": "dm",
    "GROUP_AT_MESSAGE_CREATE": "group",
    "GROUP_MESSAGE_CREATE": "group",
}
ADDRESS = re.compile(r"[a-zA-Z0-9_-]{1,160}\Z")
MAX_FRAME = 128 * 1024


def emit(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=True, separators=(",", ":")), flush=True)


def credentials() -> tuple[str, str]:
    filename = os.environ["CONEST_QQ_CREDENTIALS_FILE"]
    fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("QQ credentials must be a private regular file owned by the current user")
        content = file.read(16 * 1024)
        if len(content) == 16 * 1024:
            raise ValueError("QQ credentials file is too large")
        value = json.loads(content)
    if not isinstance(value, dict):
        raise ValueError("Invalid QQ credentials")
    app_id, secret = value.get("appId"), value.get("appSecret")
    if not isinstance(app_id, str) or not ADDRESS.fullmatch(app_id) or not isinstance(secret, str) or not secret.strip():
        raise ValueError("Invalid QQ credentials")
    if os.environ.get("CONEST_QQ_APP_ID", app_id) != app_id:
        raise ValueError("QQ credentials select a different application")
    return app_id, secret


def native_text(value: Any, limit: int) -> str | None:
    return value if isinstance(value, str) and 0 < len(value) <= limit and "\x00" not in value else None


def platform_time(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        at = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if at.tzinfo is None:
            return None
        return at.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except (ValueError, OverflowError):
        return None


def bridge_event(account_id: str, raw: dict[str, Any], message: InboundMessage) -> dict[str, Any] | None:
    event_type, data = raw.get("t"), raw.get("d")
    if not isinstance(event_type, str) or event_type not in EVENT_SCOPES or not isinstance(data, dict):
        return None
    scope = EVENT_SCOPES[event_type]
    author = data.get("author")
    if not isinstance(author, dict):
        return None
    sender = native_text(author.get("member_openid" if scope == "group" else "user_openid"), 160)
    conversation = native_text(data.get("group_openid"), 160) if scope == "group" else sender
    message_id = native_text(data.get("id"), 512)
    at = platform_time(data.get("timestamp"))
    if not sender or not ADDRESS.fullmatch(sender) or not conversation or not ADDRESS.fullmatch(conversation) or not message_id or not at:
        return None
    bot = author.get("bot")
    sender_kind = "bot" if bot is True else "user" if bot is False else "unknown"
    mentions = []
    raw_mentions = data.get("mentions")
    for item in raw_mentions[:80] if isinstance(raw_mentions, list) else []:
        if not isinstance(item, dict):
            continue
        mention_id = native_text(item.get("member_openid") or item.get("id"), 160) or "unknown"
        is_self = item.get("is_you") is True or mention_id == account_id
        mentions.append({"id": mention_id, "isBot": is_self or item.get("bot") is True, "isSelf": is_self})
    text = message.text.strip()
    if not text:
        return None
    result = {
        "type": "message", "accountId": account_id, "eventType": event_type, "scope": scope, "senderId": sender, "senderKind": sender_kind,
        "conversationId": conversation, "messageId": message_id, "at": at, "text": text[:16000],
        "mentioned": event_type == "GROUP_AT_MESSAGE_CREATE" or any(item["isSelf"] for item in mentions),
        "mentions": mentions,
    }
    message_index = native_text(message.metadata.get("msg_idx"), 1024)
    if message_index:
        result["messageIndex"] = message_index
    reference = native_text(message.metadata.get("ref_msg_idx"), 1024)
    if reference:
        result["referenceId"] = reference
    return result


class BridgeQQChannel(QQChannel):
    """Carry authoritative QQ fields lost by normalization and keep each input separate."""

    def __init__(self, processor: Callable[..., Any], *, config: QQConfig) -> None:
        super().__init__(processor, config=config, channel_id=config.app_id)
        self._constraints.typing_keepalive_interval = 0
        self._constraints.reply_timeout = 0
        self.ready = asyncio.Event()
        self.start_failed = False

    async def start(self) -> None:
        try:
            await super().start()
        except Exception:
            self.start_failed = True
            raise

    async def _handle_op(self, ws: Any, op: int, payload: dict[str, Any]) -> None:
        await super()._handle_op(ws, op, payload)
        if op == 0 and payload.get("t") in ("READY", "RESUMED") and self._session_id_ws:
            self.ready.set()

    def parse_inbound(self, raw_payload: Any) -> InboundMessage:
        message = super().parse_inbound(raw_payload)
        if isinstance(raw_payload, dict):
            message.content = [part for part in message.content if isinstance(part, TextContent)]
            message.group_context = None
            event = bridge_event(self._config.app_id, raw_payload, message)
            if event:
                reference = event.get("referenceId")
                if event["scope"] == "group" and reference:
                    sent_at = self._sent_references.get((event["conversationId"], reference))
                    elements = raw_payload["d"].get("msg_elements")
                    authors = (element.get("author") for element in elements if isinstance(element, dict)
                               and element.get("msg_idx") == reference) if isinstance(elements, list) else ()
                    own_quote = self._bot_user_id and any(isinstance(author, dict)
                        and self._bot_user_id in (author.get("member_openid"), author.get("id")) for author in authors)
                    if own_quote or (sent_at is not None and time.monotonic() - sent_at < 600):
                        event["replyToBot"] = True
                message.metadata["conest_event"] = event
        return message

    def should_batch_inbound(self, message: InboundMessage) -> bool:
        return False

    async def send_passive(self, request: dict[str, Any]) -> dict[str, Any]:
        delivery_id = request["id"]
        failure = {"type": "failed", "id": delivery_id, "retryable": False}
        scope, conversation = request.get("scope"), request.get("conversationId")
        text, message_id = native_text(request.get("text"), 16000), native_text(request.get("messageId"), 512)
        message_index = native_text(request.get("messageIndex"), 1024)
        sequence = request.get("sequence")
        if (request.get("type") != "send" or request.get("accountId") != self._config.app_id
            or scope not in ("dm", "group") or not isinstance(conversation, str) or not ADDRESS.fullmatch(conversation)
            or not text or not message_id or type(sequence) is not int or not 1 <= sequence <= 2147483647):
            return failure
        kind = "group" if scope == "group" else "c2c"
        key = "group_openid" if scope == "group" else "user_openid"
        metadata = {key: conversation, "msg_id": message_id}
        payload = {"msg_type": 0, "content": text, "msg_id": message_id, "msg_seq": sequence}
        if scope == "group" and message_index:
            payload["message_reference"] = {"message_id": message_index}
        dispatched = False
        try:
            async with asyncio.timeout(18):
                await self._acquire_rate_slot()
                # _send_message allocates a fresh sequence itself. Use the pinned
                # adapter's lower-level send with CoNest's durable sequence.
                dispatched = True
                ok, status, body = await self._try_send_message(conversation, payload, kind, metadata)
        except Exception:
            # The provider may already have received the request.
            return {**failure, "uncertain": True} if dispatched else {**failure, "retryable": True}
        if not ok:
            if status >= 500:
                return {**failure, "uncertain": True}
            return {**failure, "retryable": status == 429}
        result = {"type": "sent", "id": delivery_id}
        try:
            response = json.loads(body)
            sent_id = native_text(response.get("id"), 512)
            reference = native_text(response.get("ext_info", {}).get("ref_idx"), 1024)
            if sent_id:
                result["messageId"] = sent_id
            if reference:
                result["replyIndex"] = reference
        except (ValueError, AttributeError):
            pass  # The successful status acknowledges delivery even without an ID.
        return result


async def run(channel_kind: type[BridgeQQChannel] = BridgeQQChannel) -> None:
    account_id, secret = credentials()
    announced = asyncio.Event()

    async def process(message: InboundMessage) -> AsyncIterator[MessageEvent]:
        event = message.metadata.get("conest_event")
        if event:
            await announced.wait()
            emit(event)
        yield MessageEvent.completed()

    config = QQConfig(app_id=account_id, secret=secret, intents=INTENT_GROUP_AND_C2C, c2c_streaming=False,
                      group_context=GroupContextConfig(enabled=False, owner_commands_only=False))
    channel = channel_kind(process, config=config)
    manager = ChannelManager({account_id: channel}, workers_per_channel=1)
    reader = asyncio.StreamReader(limit=MAX_FRAME)
    loop = asyncio.get_running_loop()
    transport, _ = await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin.buffer)
    try:
        async with asyncio.timeout(25):
            await manager.start()
            if channel.start_failed:
                raise RuntimeError("Octop QQ startup failed")
            await channel.ready.wait()
        emit({"type": "ready", "accountId": account_id})
        announced.set()
        while line := await reader.readline():
            try:
                request = json.loads(line)
            except (ValueError, UnicodeDecodeError):
                continue
            if isinstance(request, dict) and native_text(request.get("id"), 256):
                emit(await channel.send_passive(request))
    finally:
        transport.close()
        await manager.stop()


def main(channel_kind: type[BridgeQQChannel] = BridgeQQChannel) -> None:
    # Upstream debug/INFO logs can include incoming bodies. Send only the
    # authenticated event on stdout and a generic failure notice on stderr.
    logging.disable(logging.CRITICAL)
    try:
        asyncio.run(run(channel_kind))
    except (Exception, KeyboardInterrupt):
        print("Octop QQ bridge could not start or was disconnected", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
