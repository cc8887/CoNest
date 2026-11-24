"""Run the real Octop adapter against the local QQ fixture with synthetic credentials."""

import os
import re
import sys
from typing import Any

import aiohttp

sys.dont_write_bytecode = True

from bridge import BridgeQQChannel, main
from mock_gateway import FIXTURE_APP_ID, FIXTURE_SECRET


class FixtureChannel(BridgeQQChannel):
    """Redirect Octop's hard-coded token endpoint for loopback testing only."""

    def __init__(self, processor: Any, *, config: Any) -> None:
        super().__init__(processor, config=config)
        origin = os.environ.get("CONEST_QQ_TEST_ORIGIN", "")
        if not re.fullmatch(r"http://127\.0\.0\.1:[1-9][0-9]{0,4}", origin):
            raise ValueError("A loopback mock origin is required")
        if config.app_id != FIXTURE_APP_ID or config.secret != FIXTURE_SECRET:
            raise ValueError("The mock bridge requires synthetic credentials")
        self._api_base = origin

    async def _fetch_gateway_url(self) -> str:
        url = await super()._fetch_gateway_url()
        if url != self._api_base.replace("http://", "ws://", 1) + "/socket":
            raise ValueError("The mock gateway must use the same loopback listener")
        return url

    async def _ensure_http(self) -> aiohttp.ClientSession:
        if self._http is None or self._http.closed:
            port = int(self._api_base.rsplit(":", 1)[1])
            async def redirect(request: Any, handler: Any) -> aiohttp.ClientResponse:
                if str(request.url) == "https://bots.qq.com/app/getAppAccessToken":
                    request.url = request.url.with_scheme("http").with_host("127.0.0.1").with_port(port)
                if (request.url.scheme, request.url.host, request.url.port) != ("http", "127.0.0.1", port):
                    raise ValueError("External network is disabled in the mock bridge")
                return await handler(request)

            self._http = aiohttp.ClientSession(middlewares=(redirect,))
        return self._http


if __name__ == "__main__":
    main(FixtureChannel)
