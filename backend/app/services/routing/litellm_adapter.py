"""LiteLLM adapter — wraps LiteLLM calls with format translation and error mapping."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Any

import litellm

from app.services.routing.headers import get_browser_headers
from app.services.routing.proxy_router import decide as decide_proxy_mode
from app.services.routing.proxy_transport import reset_proxy_mode, set_proxy_mode

if TYPE_CHECKING:
    from app.services.routing.key_manager import KeyManager
    from app.services.routing.resolver import Candidate

logger = logging.getLogger(__name__)


class AuthError(Exception):
    def __init__(self, status_code: int, message: str = "Authentication error"):
        self.status_code = status_code
        super().__init__(message)


class RateLimitError(Exception):
    def __init__(self, message: str = "Rate limited", retry_after: int | None = None):
        self.retry_after = retry_after
        super().__init__(message)


class ServerError(Exception):
    def __init__(self, status_code: int, message: str = "Server error"):
        self.status_code = status_code
        super().__init__(message)


class ClientError(Exception):
    def __init__(self, status_code: int, message: str = "Client error"):
        self.status_code = status_code
        super().__init__(message)


class GatewayError(Exception):
    """Transient gateway/proxy error — e.g. io.net's reverse proxy returning
    ``<html>400 Bad Request</html>`` for a temporary hiccup.

    Handled like a 429 (rotate to the next key, up to ``keys_per_429``) but
    WITHOUT applying a cooldown — the key itself is fine, the gateway just
    choked momentarily.
    """

    def __init__(self, status_code: int, message: str = "Gateway error"):
        self.status_code = status_code
        super().__init__(message)


class BillingExhaustedError(Exception):
    def __init__(self, message: str = "Billing exhausted"):
        super().__init__(message)


class LiteLLMAdapter:
    def __init__(self, key_manager: KeyManager, timeout: float | None = None):
        self.key_manager = key_manager
        self.timeout = timeout
        self.warnings: list[str] = []
        self._anthropic_sdk_adapter: Any | None = None

    def _native_anthropic_adapter(self) -> Any:
        """Lazy-initialised AnthropicSdkAdapter (avoids circular import)."""
        if self._anthropic_sdk_adapter is None:
            from app.services.routing.anthropic_sdk_adapter import AnthropicSdkAdapter
            self._anthropic_sdk_adapter = AnthropicSdkAdapter(self.key_manager, self.timeout)
        return self._anthropic_sdk_adapter

    @staticmethod
    def _use_native_anthropic(candidate: Candidate) -> bool:
        """Whether this candidate should bypass LiteLLM and call the Anthropic
        SDK directly (needed for providers like Vercel AI Gateway where LiteLLM
        drops thinking blocks)."""
        return bool((candidate.provider_config or {}).get("use_native_anthropic_sdk"))

    @asynccontextmanager
    async def _proxy_scope(self, candidate: Candidate):
        """Set the per-request proxy mode around an upstream litellm call.

        Decides direct vs proxied using ProxyRouter, sets the contextvar the
        shared httpx transport reads, and always restores the prior value.
        """
        try:
            mode, proxy_urls = await decide_proxy_mode(candidate.provider_id)
        except Exception:
            mode, proxy_urls = "direct", []
        tokens = set_proxy_mode(mode, proxy_urls)
        try:
            yield
        finally:
            reset_proxy_mode(tokens)

    @staticmethod
    def _set_browser_headers(kwargs: dict[str, Any], key_id: str, provider_config: dict | None = None) -> None:
        """Inject outgoing headers.

        If the provider config declares ``extra_headers`` (or
        ``claude_code_cli_headers``), those override the default browser-like
        headers — needed for providers like Aerolink that gate access to
        certain models behind a Claude Code CLI fingerprint.
        """
        prov_cfg = provider_config or {}
        extra = prov_cfg.get("extra_headers") or {}
        if prov_cfg.get("claude_code_cli_headers") and not extra:
            extra = {
                "User-Agent": "claude-cli/2.1.201 (external, cli)",
                "x-app": "cli",
                "anthropic-beta": "fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14",
            }
        if extra:
            merged = get_browser_headers(str(key_id))
            merged.update(extra)
            kwargs["extra_headers"] = merged
        else:
            kwargs["extra_headers"] = get_browser_headers(str(key_id))

    @staticmethod
    def _extract_unsupported_params(error_msg: str) -> list[str]:
        """Parse param names from litellm UnsupportedParamsError message."""
        import re
        match = re.search(r"\['([^]]+)'\]", error_msg)
        if match:
            return [p.strip().strip("'") for p in match.group(1).split("', '")]
        return []

    @staticmethod
    def _resolve_base_url(candidate: Candidate, key: Any) -> str:
        """Pick the upstream base_url.

        For providers whose config sets ``per_key_endpoint=true`` (e.g.
        Letaido, one public endpoint per workspace key), the per-key
        ``endpoint_url`` overrides the provider/model base_url. Otherwise the
        candidate's base_url is used as-is.
        """
        prov_cfg = candidate.provider_config or {}
        if prov_cfg.get("per_key_endpoint"):
            key_endpoint = getattr(key, "endpoint_url", None)
            if key_endpoint:
                return key_endpoint.rstrip("/")
        return candidate.base_url

    @staticmethod
    def _resolve_model_name(candidate: Candidate, base_url: str) -> str:
        """Build the litellm model string for the resolved base_url.

        For openai-type providers pointing at a non-OpenAI base_url, litellm
        needs the ``openai/`` provider prefix so it routes through the
        custom-endpoint path. ``native_name`` may itself contain a slash
        (e.g. ``anthropic/claude-opus-4.8`` on Letaido/OpenRouter) and is kept
        verbatim as the model id sent upstream.
        """
        if candidate.api_type == "anthropic":
            return f"anthropic/{candidate.native_name}"
        if candidate.api_type == "openai" and base_url != "https://api.openai.com/v1":
            return f"openai/{candidate.native_name}"
        return candidate.native_name

    async def call_completion(
        self,
        candidate: Candidate,
        key: Any,
        request_body: dict,
        stream: bool = False,
    ) -> dict | Any:
        if self._use_native_anthropic(candidate):
            return await self._native_anthropic_adapter().call_completion(candidate, key, request_body, stream)

        decrypted_key = key.decrypted_key if hasattr(key, 'decrypted_key') else self.key_manager.get_decrypted_key(key)

        base_url = self._resolve_base_url(candidate, key)
        model_name = self._resolve_model_name(candidate, base_url)

        kwargs: dict[str, Any] = {
            "model": model_name,
            "api_base": base_url,
            "api_key": decrypted_key,
            "stream": stream,
            "drop_params": True,
            **{k: v for k, v in request_body.items() if k not in ("model",)},
        }
        if self.timeout is not None:
            kwargs["timeout"] = self.timeout
        self._set_browser_headers(kwargs, key.id, candidate.provider_config)

        if stream:
            kwargs.setdefault("stream_options", {"include_usage": True})

        try:
            async with self._proxy_scope(candidate):
                response = await litellm.acompletion(**kwargs)
            if stream:
                return response
            return response.model_dump()
        except Exception as e:
            if "UnsupportedParamsError" in type(e).__name__ or "does not support parameters" in str(e):
                logger.warning("Dropping unsupported params for %s: %s", model_name, str(e))
                unsupported = self._extract_unsupported_params(str(e))
                for p in unsupported:
                    kwargs.pop(p, None)
                # Restore stream_options if it wasn't the unsupported param, so the
                # provider still returns usage in the final stream chunk.
                if stream and "stream_options" not in unsupported:
                    kwargs["stream_options"] = {"include_usage": True}
                async with self._proxy_scope(candidate):
                    response = await litellm.acompletion(**kwargs)
                if stream:
                    return response
                return response.model_dump()
            self._map_error(e, candidate.provider_config)
            raise

    async def call_text_completion(
        self,
        candidate: Candidate,
        key: Any,
        request_body: dict,
        stream: bool = False,
    ) -> dict | Any:
        decrypted_key = key.decrypted_key if hasattr(key, 'decrypted_key') else self.key_manager.get_decrypted_key(key)

        base_url = self._resolve_base_url(candidate, key)
        model_name = self._resolve_model_name(candidate, base_url)

        kwargs: dict[str, Any] = {
            "model": model_name,
            "api_base": base_url,
            "api_key": decrypted_key,
            "stream": stream,
            "drop_params": True,
            **{k: v for k, v in request_body.items() if k not in ("model",)},
        }
        if self.timeout is not None:
            kwargs["timeout"] = self.timeout
        self._set_browser_headers(kwargs, key.id, candidate.provider_config)

        if stream:
            kwargs.setdefault("stream_options", {"include_usage": True})

        try:
            async with self._proxy_scope(candidate):
                response = await litellm.atext_completion(**kwargs)
            if stream:
                return response
            return response.model_dump()
        except Exception as e:
            if "UnsupportedParamsError" in type(e).__name__ or "does not support parameters" in str(e):
                logger.warning("Dropping unsupported params for %s: %s", model_name, str(e))
                unsupported = self._extract_unsupported_params(str(e))
                for p in unsupported:
                    kwargs.pop(p, None)
                if stream and "stream_options" not in unsupported:
                    kwargs["stream_options"] = {"include_usage": True}
                async with self._proxy_scope(candidate):
                    response = await litellm.atext_completion(**kwargs)
                if stream:
                    return response
                return response.model_dump()
            self._map_error(e, candidate.provider_config)
            raise

    async def call_embedding(
        self,
        candidate: Candidate,
        key: Any,
        request_body: dict,
    ) -> dict:
        decrypted_key = key.decrypted_key if hasattr(key, 'decrypted_key') else self.key_manager.get_decrypted_key(key)
        base_url = self._resolve_base_url(candidate, key)
        model_name = self._resolve_model_name(candidate, base_url)

        kwargs: dict[str, Any] = {
            "model": model_name,
            "api_base": base_url,
            "api_key": decrypted_key,
            **{k: v for k, v in request_body.items() if k not in ("model",)},
        }
        if self.timeout is not None:
            kwargs["timeout"] = self.timeout
        self._set_browser_headers(kwargs, key.id, candidate.provider_config)
        try:
            async with self._proxy_scope(candidate):
                response = await litellm.aembedding(**kwargs)
            return response.model_dump()
        except Exception as e:
            self._map_error(e, candidate.provider_config)
            raise

    async def call_image_generation(
        self,
        candidate: Candidate,
        key: Any,
        request_body: dict,
    ) -> dict:
        decrypted_key = key.decrypted_key if hasattr(key, 'decrypted_key') else self.key_manager.get_decrypted_key(key)
        base_url = self._resolve_base_url(candidate, key)
        model_name = self._resolve_model_name(candidate, base_url)

        kwargs: dict[str, Any] = {
            "model": model_name,
            "api_base": base_url,
            "api_key": decrypted_key,
            **{k: v for k, v in request_body.items() if k not in ("model",)},
        }
        if self.timeout is not None:
            kwargs["timeout"] = self.timeout
        self._set_browser_headers(kwargs, key.id, candidate.provider_config)
        try:
            async with self._proxy_scope(candidate):
                response = await litellm.aimage_generation(**kwargs)
            return response.model_dump() if hasattr(response, "model_dump") else response
        except Exception as e:
            self._map_error(e, candidate.provider_config)
            raise

    async def call_transcription(
        self,
        candidate: Candidate,
        key: Any,
        request_body: dict,
        file_data: bytes,
        filename: str,
    ) -> dict:
        decrypted_key = key.decrypted_key if hasattr(key, 'decrypted_key') else self.key_manager.get_decrypted_key(key)
        base_url = self._resolve_base_url(candidate, key)
        model_name = self._resolve_model_name(candidate, base_url)

        kwargs: dict[str, Any] = {
            "model": model_name,
            "api_base": base_url,
            "api_key": decrypted_key,
            "file": (filename, file_data),
            **{k: v for k, v in request_body.items() if k not in ("model",)},
        }
        if self.timeout is not None:
            kwargs["timeout"] = self.timeout
        self._set_browser_headers(kwargs, key.id, candidate.provider_config)
        try:
            async with self._proxy_scope(candidate):
                response = await litellm.atranscription(**kwargs)
            return response.model_dump() if hasattr(response, "model_dump") else response
        except Exception as e:
            self._map_error(e, candidate.provider_config)
            raise

    async def call_speech(
        self,
        candidate: Candidate,
        key: Any,
        request_body: dict,
    ) -> bytes:
        decrypted_key = key.decrypted_key if hasattr(key, 'decrypted_key') else self.key_manager.get_decrypted_key(key)
        base_url = self._resolve_base_url(candidate, key)
        model_name = self._resolve_model_name(candidate, base_url)

        kwargs: dict[str, Any] = {
            "model": model_name,
            "api_base": base_url,
            "api_key": decrypted_key,
            **{k: v for k, v in request_body.items() if k not in ("model",)},
        }
        if self.timeout is not None:
            kwargs["timeout"] = self.timeout
        self._set_browser_headers(kwargs, key.id, candidate.provider_config)
        try:
            async with self._proxy_scope(candidate):
                response = await litellm.aspeech(**kwargs)
            return response
        except Exception as e:
            self._map_error(e, candidate.provider_config)
            raise

    async def call_anthropic_messages(
        self,
        candidate: Candidate,
        key: Any,
        request_body: dict,
        stream: bool = False,
    ) -> dict | Any:
        if self._use_native_anthropic(candidate):
            return await self._native_anthropic_adapter().call_anthropic_messages(candidate, key, request_body, stream)

        decrypted_key = key.decrypted_key if hasattr(key, 'decrypted_key') else self.key_manager.get_decrypted_key(key)
        base_url = self._resolve_base_url(candidate, key)
        model_name = f"anthropic/{candidate.native_name}"

        kwargs: dict[str, Any] = {
            "model": model_name,
            "api_base": base_url,
            "api_key": decrypted_key,
            "stream": stream,
            "drop_params": True,
            **{k: v for k, v in request_body.items() if k not in ("model",)},
        }
        if self.timeout is not None:
            kwargs["timeout"] = self.timeout
        self._set_browser_headers(kwargs, key.id, candidate.provider_config)

        if stream:
            kwargs.setdefault("stream_options", {"include_usage": True})

        try:
            async with self._proxy_scope(candidate):
                if stream:
                    response = await litellm.acompletion(**kwargs)
                    return response
                response = await litellm.acompletion(**kwargs)
            return response.model_dump()
        except Exception as e:
            if "UnsupportedParamsError" in type(e).__name__ or "does not support parameters" in str(e):
                logger.warning("Dropping unsupported params for %s: %s", model_name, str(e))
                unsupported = self._extract_unsupported_params(str(e))
                for p in unsupported:
                    kwargs.pop(p, None)
                if stream and "stream_options" not in unsupported:
                    kwargs["stream_options"] = {"include_usage": True}
                async with self._proxy_scope(candidate):
                    response = await litellm.acompletion(**kwargs)
                if stream:
                    return response
                return response.model_dump()
            self._map_error(e, candidate.provider_config)
            raise

    def _map_error(self, e: Exception, provider_config: dict | None = None) -> None:
        import asyncio
        try:
            import httpx
        except ImportError:
            httpx = None

        if isinstance(e, asyncio.TimeoutError) or (httpx and isinstance(e, httpx.TimeoutException)):
            raise ServerError(504, f"Upstream timeout: {e}")

        status_code = getattr(e, "status_code", None)
        if status_code is None:
            status_code = getattr(getattr(e, "response", None), "status_code", 500)

        if status_code in (401, 403):
            raise AuthError(status_code, str(e))
        if status_code == 402:
            raise BillingExhaustedError(str(e))
        if status_code == 429:
            retry_after = self._extract_retry_after(e)
            raise RateLimitError(str(e), retry_after=retry_after)
        if status_code and 500 <= status_code < 600:
            raise ServerError(status_code, str(e))
        if status_code and 400 <= status_code < 500:
            # A 4xx is normally terminal (the request itself is bad, retrying
            # won't help). But two cases warrant retrying instead:
            #
            # 1. The response body is HTML — this is a gateway/infrastructure
            #    error (nginx, Cloudflare, etc.), never a real API error. E.g.
            #    io.net's reverse proxy returns ``<html>400 Bad Request</html>``
            #    for transient gateway hiccups. Retrying makes sense because
            #    the failure is transient and not caused by the request payload.
            #
            # 2. The provider config explicitly lists this status code in
            #    ``retryable_status_codes`` — gives admins fine-grained control
            #    for providers that return non-HTML 4xx for transient issues.
            if self._is_retryable_client_error(e, status_code, provider_config):
                logger.info(
                    "Reclassifying %d as GatewayError "
                    "(HTML gateway body or provider retryable_status_codes): %s",
                    status_code, str(e)[:200],
                )
                raise GatewayError(status_code, str(e))
            raise ClientError(status_code, str(e))
        raise ServerError(502, str(e))

    @staticmethod
    def _is_retryable_client_error(
        e: Exception, status_code: int, provider_config: dict | None,
    ) -> bool:
        """Return True when a 4xx error should be retried (treated as
        ServerError) instead of treated as terminal (ClientError).

        Retryable when:
        * The provider config lists ``status_code`` in
          ``retryable_status_codes``, OR
        * The error response body is HTML — a gateway/proxy page, never a
          legitimate JSON API error.
        """
        if provider_config:
            retryable = provider_config.get("retryable_status_codes") or []
            if status_code in retryable:
                return True

        body = LiteLLMAdapter._extract_error_body(e)
        if body and LiteLLMAdapter._is_html_body(body):
            return True

        return False

    @staticmethod
    def _extract_error_body(e: Exception) -> str | None:
        """Best-effort extraction of the HTTP response body from a litellm /
        OpenAI SDK exception. Falls back to the exception message (litellm
        includes the upstream body in str(e))."""
        response = getattr(e, "response", None)
        if response is not None:
            text = getattr(response, "text", None)
            if text:
                return text
            content = getattr(response, "content", None)
            if isinstance(content, (bytes, bytearray)):
                try:
                    return content.decode("utf-8", errors="replace")
                except Exception:
                    pass
        return str(e)

    @staticmethod
    def _is_html_body(body: str) -> bool:
        """Detect whether a response body is an HTML page (gateway/proxy
        error) rather than a JSON API error response."""
        lower = body[:500].lower()
        return "<html" in lower or "<!doctype html" in lower

    @staticmethod
    def _extract_retry_after(e: Exception) -> int | None:
        """Extract Retry-After header value (in seconds) from an upstream 429 response."""
        try:
            response = getattr(e, "response", None)
            if response is None:
                return None
            headers = getattr(response, "headers", None)
            if headers is None:
                return None
            # httpx Headers supports dict-like access and .get()
            raw = headers.get("retry-after") or headers.get("Retry-After")
            if not raw:
                return None
            # Retry-After can be seconds or an HTTP-date; we only parse seconds
            try:
                return int(raw)
            except (ValueError, TypeError):
                return None
        except Exception:
            return None
