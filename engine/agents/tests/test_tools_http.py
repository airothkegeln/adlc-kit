"""
Tests de github_search, web_fetch, notion_search, linear_search y factory.

Usa httpx.MockTransport para interceptar requests sin red. Cada test arma
un transport con respuestas canned y se lo inyecta a la tool via su
parametro `client`.
"""

from __future__ import annotations

import json

import httpx
import pytest

from ..tools.disabled import DisabledTool
from ..tools.factory import build_tool_registry
from ..tools.github_search import GithubSearchTool
from ..tools.linear_search import LinearSearchTool
from ..tools.notion_search import NotionSearchTool
from ..tools.web_fetch import WebFetchTool


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------
def _make_mock_client(handler) -> httpx.AsyncClient:
    transport = httpx.MockTransport(handler)
    return httpx.AsyncClient(transport=transport)


# ======================================================================
# GithubSearchTool
# ======================================================================
@pytest.mark.asyncio
async def test_github_search_parses_hits():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["headers"] = dict(request.headers)
        return httpx.Response(200, json={
            "total_count": 2,
            "items": [
                {
                    "path": "src/onboarding.py",
                    "html_url": "https://github.com/owner/repo/blob/main/src/onboarding.py",
                    "score": 1.5,
                    "repository": {"full_name": "owner/repo"},
                },
                {
                    "path": "docs/onboarding.md",
                    "html_url": "https://github.com/owner/repo/blob/main/docs/onboarding.md",
                    "score": 1.2,
                    "repository": {"full_name": "owner/repo"},
                },
            ],
        })

    client = _make_mock_client(handler)
    tool = GithubSearchTool(token="ghp_test", client=client)
    out = await tool.run({"query": "onboarding repo:owner/repo", "per_page": 5})
    await client.aclose()

    assert out["total_count"] == 2
    assert len(out["hits"]) == 2
    assert out["hits"][0]["path"] == "src/onboarding.py"
    assert out["hits"][0]["repo"] == "owner/repo"
    # Auth header presente
    assert captured["headers"].get("authorization") == "Bearer ghp_test"
    # Query encoded en la URL
    assert "onboarding" in captured["url"]


@pytest.mark.asyncio
async def test_github_search_401_returns_error():
    def handler(request):
        return httpx.Response(401, json={"message": "Bad credentials"})
    client = _make_mock_client(handler)
    tool = GithubSearchTool(token="ghp_invalid", client=client)
    out = await tool.run({"query": "x"})
    await client.aclose()
    assert "error" in out
    assert "401" in out["error"]


@pytest.mark.asyncio
async def test_github_search_403_rate_limit():
    def handler(request):
        return httpx.Response(403, json={"message": "API rate limit exceeded"})
    client = _make_mock_client(handler)
    tool = GithubSearchTool(token="ghp_x", client=client)
    out = await tool.run({"query": "x"})
    await client.aclose()
    assert "error" in out
    assert "rate limit" in out["details"].lower()


@pytest.mark.asyncio
async def test_github_search_per_page_capped_at_30():
    def handler(request):
        # Verificar que el query string trae per_page=30 (cap)
        assert "per_page=30" in str(request.url)
        return httpx.Response(200, json={"total_count": 0, "items": []})
    client = _make_mock_client(handler)
    tool = GithubSearchTool(token="t", client=client)
    await tool.run({"query": "x", "per_page": 999})
    await client.aclose()


@pytest.mark.asyncio
async def test_github_search_missing_query():
    tool = GithubSearchTool(token="t")
    out = await tool.run({})
    assert "error" in out


def test_github_search_empty_token_raises():
    with pytest.raises(ValueError, match="token"):
        GithubSearchTool(token="")


# ======================================================================
# WebFetchTool
# ======================================================================
@pytest.mark.asyncio
async def test_web_fetch_allowed_domain_returns_body():
    def handler(request):
        return httpx.Response(
            200,
            text="hola mundo",
            headers={"content-type": "text/plain"},
        )
    client = _make_mock_client(handler)
    tool = WebFetchTool(allowed_domains=["example.com"], client=client)
    out = await tool.run({"url": "https://example.com/page"})
    await client.aclose()
    assert out["status_code"] == 200
    assert out["body"] == "hola mundo"
    assert out["truncated"] is False


@pytest.mark.asyncio
async def test_web_fetch_subdomain_matches_allowlist():
    def handler(request):
        return httpx.Response(200, text="ok")
    client = _make_mock_client(handler)
    tool = WebFetchTool(allowed_domains=["github.com"], client=client)
    out = await tool.run({"url": "https://api.github.com/repos/owner/repo"})
    await client.aclose()
    assert out["status_code"] == 200


@pytest.mark.asyncio
async def test_web_fetch_blocks_disallowed_domain():
    tool = WebFetchTool(allowed_domains=["example.com"])
    out = await tool.run({"url": "https://evil.invalid/x"})
    assert "error" in out
    assert out["host"] == "evil.invalid"


@pytest.mark.asyncio
async def test_web_fetch_blocks_non_http_scheme():
    tool = WebFetchTool(allowed_domains=["example.com"])
    out = await tool.run({"url": "file:///etc/passwd"})
    assert "error" in out
    assert "esquema" in out["error"]


@pytest.mark.asyncio
async def test_web_fetch_truncates_large_response():
    big = "x" * 10_000

    def handler(request):
        return httpx.Response(200, text=big, headers={"content-type": "text/plain"})

    client = _make_mock_client(handler)
    tool = WebFetchTool(allowed_domains=["example.com"], max_response_kb=5, client=client)
    out = await tool.run({"url": "https://example.com/big"})
    await client.aclose()
    assert out["truncated"] is True
    assert len(out["body"].encode("utf-8")) <= 5 * 1024
    assert out["bytes_total"] == 10_000


@pytest.mark.asyncio
async def test_web_fetch_missing_url():
    tool = WebFetchTool(allowed_domains=["x.com"])
    out = await tool.run({})
    assert "error" in out


# ======================================================================
# NotionSearchTool
# ======================================================================
@pytest.mark.asyncio
async def test_notion_search_parses_hits():
    captured = {}

    def handler(request):
        captured["headers"] = dict(request.headers)
        captured["body"] = json.loads(request.content.decode())
        return httpx.Response(200, json={
            "results": [
                {
                    "id": "page-1",
                    "url": "https://notion.so/page-1",
                    "last_edited_time": "2026-04-01T12:00:00.000Z",
                    "properties": {
                        "title": {
                            "title": [{"plain_text": "Onboarding empresas"}],
                        },
                    },
                },
            ],
        })

    client = _make_mock_client(handler)
    tool = NotionSearchTool(token="secret_x", client=client)
    out = await tool.run({"query": "onboarding"})
    await client.aclose()

    assert len(out["hits"]) == 1
    assert out["hits"][0]["title"] == "Onboarding empresas"
    assert out["hits"][0]["id"] == "page-1"
    # Auth y version headers
    assert captured["headers"]["authorization"] == "Bearer secret_x"
    assert captured["headers"]["notion-version"] == "2022-06-28"
    # Filter por page object en el body
    assert captured["body"]["filter"]["value"] == "page"


@pytest.mark.asyncio
async def test_notion_search_handles_missing_title():
    def handler(request):
        return httpx.Response(200, json={
            "results": [{"id": "x", "url": "u", "last_edited_time": "", "properties": {}}],
        })
    client = _make_mock_client(handler)
    tool = NotionSearchTool(token="t", client=client)
    out = await tool.run({"query": "x"})
    await client.aclose()
    assert out["hits"][0]["title"] == ""


@pytest.mark.asyncio
async def test_notion_search_401():
    def handler(request):
        return httpx.Response(401, text="unauthorized")
    client = _make_mock_client(handler)
    tool = NotionSearchTool(token="bad", client=client)
    out = await tool.run({"query": "x"})
    await client.aclose()
    assert "401" in out["error"]


# ======================================================================
# LinearSearchTool
# ======================================================================
@pytest.mark.asyncio
async def test_linear_search_parses_nodes():
    captured = {}

    def handler(request):
        captured["headers"] = dict(request.headers)
        captured["body"] = json.loads(request.content.decode())
        return httpx.Response(200, json={
            "data": {
                "issues": {
                    "nodes": [
                        {
                            "id": "issue-1",
                            "identifier": "MACHBANK-42",
                            "title": "Onboarding empresas — flujo identidad",
                            "url": "https://linear.app/machbank/issue/MACHBANK-42",
                            "state": {"name": "In Progress"},
                            "team": {"key": "MACHBANK", "name": "MACHBank"},
                        },
                    ],
                },
            },
        })

    client = _make_mock_client(handler)
    tool = LinearSearchTool(token="lin_token", client=client)
    out = await tool.run({"query": "onboarding"})
    await client.aclose()

    assert len(out["hits"]) == 1
    h = out["hits"][0]
    assert h["identifier"] == "MACHBANK-42"
    assert h["state"] == "In Progress"
    assert h["team"] == "MACHBANK"
    # Linear NO usa "Bearer" en el header
    assert captured["headers"]["authorization"] == "lin_token"
    # GraphQL variables
    assert captured["body"]["variables"]["query"] == "onboarding"


@pytest.mark.asyncio
async def test_linear_search_graphql_errors():
    def handler(request):
        return httpx.Response(200, json={
            "errors": [{"message": "syntax error"}],
        })
    client = _make_mock_client(handler)
    tool = LinearSearchTool(token="t", client=client)
    out = await tool.run({"query": "x"})
    await client.aclose()
    assert "graphql errors" in out["error"]


@pytest.mark.asyncio
async def test_linear_search_401():
    def handler(request):
        return httpx.Response(401, text="unauthorized")
    client = _make_mock_client(handler)
    tool = LinearSearchTool(token="bad", client=client)
    out = await tool.run({"query": "x"})
    await client.aclose()
    assert "401" in out["error"]


# ======================================================================
# Factory + DisabledTool
# ======================================================================
def test_factory_registers_disabled_when_token_missing():
    registry, status = build_tool_registry(config={}, env={})
    # Las 4 tools del catalogo deben estar registradas (como Disabled)
    for name in ("github_search", "notion_search", "linear_search", "web_fetch"):
        assert name in registry.names()
        assert isinstance(registry.get(name), DisabledTool)
        assert status[name].startswith("disabled:")


def test_factory_registers_real_tools_when_creds_present():
    config = {
        "web_fetch": {"allowed_domains": ["github.com"]},
    }
    env = {
        "GITHUB_TOKEN": "ghp_test",
        "NOTION_TOKEN": "secret_x",
        "LINEAR_TOKEN": "lin_t",
    }
    registry, status = build_tool_registry(config=config, env=env)
    assert isinstance(registry.get("github_search"), GithubSearchTool)
    assert isinstance(registry.get("notion_search"), NotionSearchTool)
    assert isinstance(registry.get("linear_search"), LinearSearchTool)
    assert isinstance(registry.get("web_fetch"), WebFetchTool)
    for k in ("github_search", "notion_search", "linear_search", "web_fetch"):
        assert status[k] == "ok"


def test_factory_disabled_when_explicitly_off():
    config = {"github_search": {"enabled": False}}
    env = {"GITHUB_TOKEN": "ghp_test"}  # token presente pero enabled=False
    registry, status = build_tool_registry(config=config, env=env)
    assert isinstance(registry.get("github_search"), DisabledTool)
    assert "deshabilitada" in status["github_search"]


def test_factory_web_fetch_needs_allowed_domains():
    registry, status = build_tool_registry(config={"web_fetch": {"allowed_domains": []}}, env={})
    assert isinstance(registry.get("web_fetch"), DisabledTool)
    assert "allowed_domains" in status["web_fetch"]


def test_factory_include_stubs_adds_echo_and_noop():
    registry, status = build_tool_registry(config={}, env={}, include_stubs=True)
    assert "echo" in registry.names()
    assert "noop_search" in registry.names()
    assert status["echo"] == "ok"
    assert status["noop_search"] == "ok"


def test_factory_token_env_override():
    config = {"github_search": {"token_env": "MY_CUSTOM_GH"}}
    env = {"MY_CUSTOM_GH": "ghp_x"}
    registry, status = build_tool_registry(config=config, env=env)
    assert isinstance(registry.get("github_search"), GithubSearchTool)


@pytest.mark.asyncio
async def test_disabled_tool_returns_clear_error():
    from ..tools.disabled import DisabledTool as DT
    t = DT(name="x", description="d", reason="missing creds", input_schema={})
    out = await t.run({})
    assert out["disabled"] is True
    assert out["tool"] == "x"
    assert "missing creds" in out["reason"]
