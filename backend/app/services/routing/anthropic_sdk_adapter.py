"""Native Anthropic SDK adapter — for providers that require direct Anthropic API
calls where LiteLLM drops thinking blocks (e.g. Vercel AI Gateway).

LiteLLM normalizes Anthropic responses to the OpenAI shape and loses
``thinking`` content blocks in the process. This adapter calls the Anthropic SDK
directly, preserving thinking, and converts both directions:

* Request:  OpenAI chat-completion format  →  Anthropic messages params
* Response: Anthropic message               →  OpenAI chat completion dict
* Stream:   Anthropic stream events         →  OpenAI SSE chunk dicts

The output is OpenAI-shaped so the existing gateway SSE/billing plumbing
(``stream_openai_response_with_usage``, ``extract_usage``) works unchanged.
Thinking text is exposed as ``reasoning_content`` on the assistant message,
matching the OpenAI reasoning-model convention.

Error mapping reuses the same exception types as ``LiteLLMAdapter`` so the
``FallbackExecutor`` retry/block logic is identical.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from typing import TYPE_CHECKING, Any

import anthropic

from app.services.routing.headers import get_browser_headers
from app.services.routing.litellm_adapter import (
    AuthError,
    BillingExhaustedError,
    ClientError,
    GatewayError,
    RateLimitError,
    ServerError,
)

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator

    from app.services.routing.key_manager import KeyManager
    from app.services.routing.resolver import Candidate

logger = logging.getLogger(__name__)


async def _safe_close(client: anthropic.AsyncAnthropic | None) -> None:
    """Best-effort close of a per-request Anthropic SDK client (idempotent)."""
    if client is None:
        return
    try:
        await client.close()
    except Exception:
        logger.debug("anthropic client close failed", exc_info=True)


# Anthropic stop_reason → OpenAI finish_reason
_STOP_REASON_MAP: dict[str, str] = {
    "end_turn": "stop",
    "tool_use": "tool_calls",
    "max_tokens": "length",
    "stop_sequence": "stop",
    "pause_turn": "stop",
}


class AnthropicSdkAdapter:
    """Call a provider via the Anthropic SDK directly, with OpenAI↔Anthropic
    format translation.

    Activated when ``provider_config['use_native_anthropic_sdk']`` is true.
    """

    def __init__(self, key_manager: KeyManager, timeout: float | None = None):
        self.key_manager = key_manager
        self.timeout = timeout

    # ------------------------------------------------------------------ #
    #  Public entry points (mirror LiteLLMAdapter signatures)            #
    # ------------------------------------------------------------------ #

    async def call_completion(
        self,
        candidate: Candidate,
        key: Any,
        request_body: dict,
        stream: bool = False,
    ) -> dict | AsyncGenerator[dict]:
        """OpenAI chat-completion request → Anthropic SDK → OpenAI response."""
        client = self._make_client(candidate, key)
        try:
            params = self._build_params_from_openai(candidate, request_body, stream)
            # Vercel AI Gateway doesn't return input_tokens in streaming events,
            # so we pre-compute an estimate to use as a fallback.
            est_input = _estimate_input_tokens(request_body)

            if stream:
                # The generator owns the client lifecycle (closes it in its
                # own finally), so we must NOT close it here.
                return self._stream_openai(client, candidate, params, est_input)
            # When thinking is enabled, max_tokens can be large (e.g. 128000).
            # The Anthropic SDK blocks non-streaming requests that may take
            # >10 min, so we stream internally and reassemble into a single
            # response dict. _stream_and_reassemble closes the client itself.
            if params.get("thinking"):
                return await self._stream_and_reassemble(client, candidate, params, est_input)
            response = await client.messages.create(**params)
            try:
                return self._anthropic_to_openai(response, candidate, est_input)
            finally:
                await _safe_close(client)
        except anthropic.APIStatusError as e:
            await _safe_close(client)
            self._map_error(e)
            raise
        except (TimeoutError, anthropic.APITimeoutError) as e:
            await _safe_close(client)
            raise ServerError(504, f"Upstream timeout: {e}") from e
        except anthropic.APIConnectionError as e:
            await _safe_close(client)
            raise ServerError(502, f"Connection error: {e}") from e
        except Exception:
            await _safe_close(client)
            raise

    async def call_anthropic_messages(
        self,
        candidate: Candidate,
        key: Any,
        request_body: dict,
        stream: bool = False,
    ) -> dict | AsyncGenerator[dict]:
        """Anthropic-native /v1/messages request → Anthropic SDK → OpenAI
        response (matches the existing litellm-based path which also returns
        OpenAI-shaped data)."""
        client = self._make_client(candidate, key)
        try:
            params = self._build_params_from_anthropic(candidate, request_body, stream)
            est_input = _estimate_input_tokens(request_body)

            if stream:
                return self._stream_openai(client, candidate, params, est_input)
            if params.get("thinking"):
                return await self._stream_and_reassemble(client, candidate, params, est_input)
            response = await client.messages.create(**params)
            try:
                return self._anthropic_to_openai(response, candidate, est_input)
            finally:
                await _safe_close(client)
        except anthropic.APIStatusError as e:
            await _safe_close(client)
            self._map_error(e)
            raise
        except (TimeoutError, anthropic.APITimeoutError) as e:
            await _safe_close(client)
            raise ServerError(504, f"Upstream timeout: {e}") from e
        except anthropic.APIConnectionError as e:
            await _safe_close(client)
            raise ServerError(502, f"Connection error: {e}") from e
        except Exception:
            await _safe_close(client)
            raise

    # ------------------------------------------------------------------ #
    #  Client construction                                               #
    # ------------------------------------------------------------------ #

    async def _make_client(self, candidate: Candidate, key: Any) -> anthropic.AsyncAnthropic:
        decrypted_key = (
            key.decrypted_key
            if hasattr(key, "decrypted_key")
            else self.key_manager.get_decrypted_key(key)
        )
        # Anthropic SDK appends /v1/messages itself, so base_url must NOT
        # include /v1 (per the Vercel AI Gateway guide).
        base_url = candidate.base_url.rstrip("/")
        kwargs: dict[str, Any] = {
            "api_key": decrypted_key,
            "base_url": base_url,
        }
        if self.timeout is not None:
            kwargs["timeout"] = self.timeout
        # Browser-like headers for anti-fraud consistency with the litellm path.
        # When anonymous_user_agent flag is ON, skip browser headers so the
        # Anthropic SDK sends its standard library User-Agent.
        from app.services.config.feature_flags import is_anonymous_user_agent_enabled
        if not await is_anonymous_user_agent_enabled():
            kwargs["default_headers"] = get_browser_headers(str(key.id))
        return anthropic.AsyncAnthropic(**kwargs)

    # ------------------------------------------------------------------ #
    #  Request conversion — OpenAI → Anthropic                           #
    # ------------------------------------------------------------------ #

    def _build_params_from_openai(
        self, candidate: Candidate, request_body: dict, stream: bool,
    ) -> dict[str, Any]:
        messages: list[dict] = request_body.get("messages", [])
        system, anthropic_messages = _convert_openai_messages(messages)

        model_cfg = candidate.model_config or {}
        # upstream_model overrides native_name — needed when multiple catalog
        # entries map to the same Vercel model (e.g. Sonnet 5 effort variants).
        upstream_model = model_cfg.get("upstream_model", candidate.native_name)

        params: dict[str, Any] = {
            "model": upstream_model,
            "messages": anthropic_messages,
        }

        # System prompt with prompt caching (Anthropic requires cache_control
        # markers on content blocks; minimum 1024 tokens for cache to activate).
        if system:
            if isinstance(system, str):
                params["system"] = [
                    {"type": "text", "text": system, "cache_control": {"type": "ephemeral"}},
                ]
            else:
                params["system"] = system

        # max_tokens is required by the Anthropic API.
        # When thinking is enabled, thinking tokens come out of max_tokens, so
        # we MUST use the model's full default (128000) — a client-sent
        # max_tokens (e.g. mimocode sends 32000) would leave almost nothing
        # for the actual response after thinking consumes its share.
        model_cfg = candidate.model_config or {}
        thinking_cfg = model_cfg.get("thinking")
        if thinking_cfg:
            max_tokens = model_cfg.get("default_max_tokens", 128000)
        else:
            max_tokens = request_body.get("max_tokens") or model_cfg.get("default_max_tokens", 128000)
        params["max_tokens"] = max_tokens

        # Temperature / top_p — disallowed when thinking is enabled.
        thinking_cfg = model_cfg.get("thinking")
        if not thinking_cfg:
            if request_body.get("temperature") is not None:
                params["temperature"] = request_body["temperature"]
            if request_body.get("top_p") is not None:
                params["top_p"] = request_body["top_p"]
        # else: extended thinking requires temperature=1 (SDK default), so we
        # simply omit temperature/top_p entirely.

        if request_body.get("stop"):
            stop = request_body["stop"]
            params["stop_sequences"] = [stop] if isinstance(stop, str) else stop

        # Tools — add cache_control on the last tool for prompt caching.
        tools = request_body.get("tools")
        if tools:
            converted_tools = [_convert_openai_tool(t) for t in tools]
            if converted_tools:
                converted_tools[-1]["cache_control"] = {"type": "ephemeral"}
            params["tools"] = converted_tools

        # Conversation history caching — find the last large content block
        # in the messages and mark it as cacheable.  Anthropic caches
        # everything from the start of the request up to each cache_control
        # breakpoint, so marking the last old block caches the entire history.
        _add_history_cache_control(anthropic_messages)

        tool_choice = request_body.get("tool_choice")
        if tool_choice is not None and tools:
            params["tool_choice"] = _convert_openai_tool_choice(tool_choice)

        # Thinking + output_config from model config
        self._apply_thinking(params, model_cfg)

        if stream:
            params["stream"] = True

        return params

    # ------------------------------------------------------------------ #
    #  Request conversion — Anthropic-native passthrough                 #
    # ------------------------------------------------------------------ #

    def _build_params_from_anthropic(
        self, candidate: Candidate, request_body: dict, stream: bool,
    ) -> dict[str, Any]:
        model_cfg = candidate.model_config or {}
        upstream_model = model_cfg.get("upstream_model", candidate.native_name)

        params: dict[str, Any] = {
            "model": upstream_model,
            "messages": request_body.get("messages", []),
        }

        # System prompt with prompt caching.
        system = request_body.get("system")
        if system is not None:
            if isinstance(system, str):
                params["system"] = [
                    {"type": "text", "text": system, "cache_control": {"type": "ephemeral"}},
                ]
            elif isinstance(system, list):
                # Add cache_control to the last block if not already present.
                if system and isinstance(system[-1], dict) and "cache_control" not in system[-1]:
                    system[-1]["cache_control"] = {"type": "ephemeral"}
                params["system"] = system
            else:
                params["system"] = system

        model_cfg = candidate.model_config or {}
        thinking_cfg = model_cfg.get("thinking")
        if thinking_cfg:
            max_tokens = model_cfg.get("default_max_tokens", 128000)
        else:
            max_tokens = request_body.get("max_tokens") or model_cfg.get("default_max_tokens", 128000)
        params["max_tokens"] = max_tokens

        thinking_cfg = model_cfg.get("thinking")
        if not thinking_cfg:
            for field in ("temperature", "top_p", "top_k"):
                if request_body.get(field) is not None:
                    params[field] = request_body[field]

        if request_body.get("stop_sequences"):
            params["stop_sequences"] = request_body["stop_sequences"]
        if request_body.get("tools"):
            tools = request_body["tools"]
            # Add cache_control on the last tool for prompt caching.
            if isinstance(tools, list) and tools:
                last = tools[-1]
                if isinstance(last, dict) and "cache_control" not in last:
                    last = {**last, "cache_control": {"type": "ephemeral"}}
                    tools = tools[:-1] + [last]
            params["tools"] = tools

        # Cache conversation history.
        _add_history_cache_control(params["messages"])
        if request_body.get("tool_choice") is not None:
            params["tool_choice"] = request_body["tool_choice"]

        self._apply_thinking(params, model_cfg)

        if stream:
            params["stream"] = True

        return params

    # ------------------------------------------------------------------ #
    #  Thinking config injection                                         #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _apply_thinking(params: dict[str, Any], model_cfg: dict) -> None:
        """Inject thinking + output_config from the model config.

        In anthropic SDK >=0.116, ``output_config`` is a first-class parameter
        (e.g. ``{"effort": "max"}`` for Sonnet 5 on Vercel AI Gateway).
        """
        thinking = model_cfg.get("thinking")
        if thinking:
            params["thinking"] = dict(thinking)
        output_config = model_cfg.get("output_config")
        if output_config:
            params["output_config"] = dict(output_config)

    # ------------------------------------------------------------------ #
    #  Non-stream reassembly via internal streaming                      #
    # ------------------------------------------------------------------ #

    async def _stream_and_reassemble(
        self, client: anthropic.AsyncAnthropic, candidate: Candidate, params: dict[str, Any],
        est_input: int = 0,
    ) -> dict:
        """Stream internally (to bypass the SDK's 10-min non-stream limit) and
        reassemble the events into a single OpenAI-shaped response dict.

        This is used when the client asked for a non-streaming response but
        thinking is enabled — the Anthropic SDK refuses non-streaming requests
        with large max_tokens.
        """
        params = {**params, "stream": True}

        text_parts: list[str] = []
        thinking_parts: list[str] = []
        tool_calls: list[dict] = []
        # block_index → {name, id, args_parts}
        tool_blocks: dict[int, dict] = {}
        tool_counter = 0
        input_tokens = 0
        output_tokens = 0
        stop_reason = "stop"

        try:
            stream = await client.messages.create(**params)
            async for event in stream:
                event_type = getattr(event, "type", None)

                if event_type == "message_start":
                    msg = event.message
                    u = getattr(msg, "usage", None)
                    if u is not None:
                        input_tokens = getattr(u, "input_tokens", 0) or 0
                        input_tokens += getattr(u, "cache_read_input_tokens", 0) or 0
                        input_tokens += getattr(u, "cache_creation_input_tokens", 0) or 0

                elif event_type == "content_block_start":
                    block = event.content_block
                    if getattr(block, "type", None) == "tool_use":
                        tool_blocks[event.index] = {
                            "id": block.id,
                            "name": block.name,
                            "args_parts": [],
                        }
                        tool_counter += 1

                elif event_type == "content_block_delta":
                    delta = event.delta
                    delta_type = getattr(delta, "type", None)
                    if delta_type == "thinking_delta":
                        thinking_parts.append(getattr(delta, "thinking", "") or "")
                    elif delta_type == "text_delta":
                        text_parts.append(getattr(delta, "text", "") or "")
                    elif delta_type == "input_json_delta":
                        tb = tool_blocks.get(event.index)
                        if tb is not None:
                            tb["args_parts"].append(getattr(delta, "partial_json", "") or "")

                elif event_type == "content_block_stop":
                    tb = tool_blocks.pop(event.index, None)
                    if tb is not None:
                        args_str = "".join(tb["args_parts"])
                        try:
                            args_obj = json.loads(args_str) if args_str else {}
                        except json.JSONDecodeError:
                            args_obj = {"raw": args_str}
                        tool_calls.append({
                            "id": tb["id"],
                            "type": "function",
                            "function": {
                                "name": tb["name"],
                                "arguments": json.dumps(args_obj),
                            },
                        })

                elif event_type == "message_delta":
                    evt_delta = event.delta
                    if getattr(evt_delta, "stop_reason", None):
                        stop_reason = _STOP_REASON_MAP.get(evt_delta.stop_reason, "stop")
                    evt_usage = getattr(event, "usage", None)
                    if evt_usage is not None:
                        output_tokens = getattr(evt_usage, "output_tokens", 0) or output_tokens

        except anthropic.APIStatusError as e:
            self._map_error(e)
            raise
        except (TimeoutError, anthropic.APITimeoutError) as e:
            raise ServerError(504, f"Upstream timeout: {e}") from e
        except anthropic.APIConnectionError as e:
            raise ServerError(502, f"Connection error: {e}") from e
        finally:
            await _safe_close(client)

        # Vercel doesn't return input_tokens — use our estimate as fallback.
        if input_tokens == 0:
            input_tokens = est_input
        # Vercel doesn't return output_tokens either — estimate from content.
        if output_tokens == 0:
            output_tokens = _estimate_output_tokens_from_content(
                text="".join(text_parts),
                thinking="".join(thinking_parts),
                tool_calls=tool_calls,
            )
            if output_tokens:
                logger.info(
                    "Vercel (reassemble): output_tokens=0 from upstream, estimated %d from content",
                    output_tokens,
                )

        message: dict[str, Any] = {"role": "assistant", "content": "".join(text_parts) or None}
        if thinking_parts:
            message["reasoning_content"] = "".join(thinking_parts)
        if tool_calls:
            message["tool_calls"] = tool_calls

        return {
            "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": candidate.canonical_name,
            "choices": [{
                "index": 0,
                "message": message,
                "finish_reason": stop_reason,
            }],
            "usage": {
                "prompt_tokens": input_tokens,
                "completion_tokens": output_tokens,
                "total_tokens": input_tokens + output_tokens,
            },
        }

    # ------------------------------------------------------------------ #
    #  Response conversion — Anthropic message → OpenAI completion       #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _anthropic_to_openai(response: Any, candidate: Candidate, est_input: int = 0) -> dict:
        text_parts: list[str] = []
        thinking_parts: list[str] = []
        tool_calls: list[dict] = []

        for block in response.content:
            block_type = getattr(block, "type", None)
            if block_type == "text":
                text_parts.append(block.text)
            elif block_type == "thinking":
                thinking_parts.append(getattr(block, "thinking", "") or "")
            elif block_type == "tool_use":
                tool_calls.append({
                    "id": block.id,
                    "type": "function",
                    "function": {
                        "name": block.name,
                        "arguments": json.dumps(block.input) if block.input is not None else "",
                    },
                })

        message: dict[str, Any] = {"role": "assistant", "content": "".join(text_parts) or None}
        if thinking_parts:
            message["reasoning_content"] = "".join(thinking_parts)
        if tool_calls:
            message["tool_calls"] = tool_calls

        usage = response.usage
        prompt_tokens = getattr(usage, "input_tokens", 0) or 0
        # Include cached tokens (Anthropic caches system prompt + tools).
        prompt_tokens += getattr(usage, "cache_read_input_tokens", 0) or 0
        prompt_tokens += getattr(usage, "cache_creation_input_tokens", 0) or 0
        completion_tokens = getattr(usage, "output_tokens", 0) or 0
        # Vercel doesn't return input_tokens — use our estimate as fallback.
        if prompt_tokens == 0:
            prompt_tokens = est_input
        # Vercel doesn't return output_tokens either — estimate from content.
        if completion_tokens == 0:
            full_text = "".join(text_parts)
            full_thinking = "".join(thinking_parts)
            completion_tokens = _estimate_output_tokens_from_content(
                text=full_text, thinking=full_thinking, tool_calls=tool_calls,
            )
            if completion_tokens:
                logger.info(
                    "Vercel (non-stream): output_tokens=0 from upstream, estimated %d from content",
                    completion_tokens,
                )

        return {
            "id": f"chatcmpl-{response.id}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": candidate.canonical_name,
            "choices": [{
                "index": 0,
                "message": message,
                "finish_reason": _STOP_REASON_MAP.get(response.stop_reason, "stop"),
            }],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": prompt_tokens + completion_tokens,
            },
        }

    # ------------------------------------------------------------------ #
    #  Streaming conversion — Anthropic events → OpenAI chunk dicts      #
    # ------------------------------------------------------------------ #

    async def _stream_openai(
        self, client: anthropic.AsyncAnthropic, candidate: Candidate, params: dict[str, Any],
        est_input: int = 0,
    ) -> AsyncGenerator[dict]:
        """Yield OpenAI-shaped chunk dicts from an Anthropic streaming response.

        The gateway's ``stream_openai_response_with_usage`` consumes these
        dicts directly (it handles both ``model_dump`` objects and plain
        dicts).
        """
        created = int(time.time())
        chatcmpl_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"

        # block_index (Anthropic) → tool_call index (OpenAI)
        tool_index_map: dict[int, int] = {}
        tool_counter = 0
        input_tokens = 0
        output_tokens = 0
        finish_reason = "stop"
        sent_role = False
        # Accumulate content for output-token estimation fallback (Vercel
        # doesn't return output_tokens in streaming events either).
        text_buf: list[str] = []
        thinking_buf: list[str] = []
        tool_args_buf: dict[int, list[str]] = {}

        def _chunk(delta: dict, fr: str | None = None) -> dict:
            return {
                "id": chatcmpl_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": candidate.canonical_name,
                "choices": [{"index": 0, "delta": delta, "finish_reason": fr}],
            }

        try:
            # messages.create(stream=True) returns an AsyncStream of raw events.
            stream = await client.messages.create(**params)
            async for event in stream:
                event_type = getattr(event, "type", None)

                if event_type == "message_start":
                    msg = event.message
                    u = getattr(msg, "usage", None)
                    if u is not None:
                        input_tokens = getattr(u, "input_tokens", 0) or 0
                        input_tokens += getattr(u, "cache_read_input_tokens", 0) or 0
                        input_tokens += getattr(u, "cache_creation_input_tokens", 0) or 0
                    if not sent_role:
                        yield _chunk({"role": "assistant", "content": ""})
                        sent_role = True

                elif event_type == "content_block_start":
                    block = event.content_block
                    if getattr(block, "type", None) == "tool_use":
                        idx = tool_counter
                        tool_index_map[event.index] = idx
                        tool_counter += 1
                        tool_args_buf[idx] = []
                        yield _chunk({"tool_calls": [{
                            "index": idx,
                            "id": block.id,
                            "type": "function",
                            "function": {"name": block.name, "arguments": ""},
                        }]})

                elif event_type == "content_block_delta":
                    delta = event.delta
                    delta_type = getattr(delta, "type", None)
                    if delta_type == "thinking_delta":
                        chunk_text = getattr(delta, "thinking", "") or ""
                        thinking_buf.append(chunk_text)
                        yield _chunk({"reasoning_content": chunk_text})
                    elif delta_type == "text_delta":
                        chunk_text = getattr(delta, "text", "") or ""
                        text_buf.append(chunk_text)
                        yield _chunk({"content": chunk_text})
                    elif delta_type == "input_json_delta":
                        tc_idx = tool_index_map.get(event.index)
                        if tc_idx is not None:
                            partial = getattr(delta, "partial_json", "") or ""
                            tool_args_buf.setdefault(tc_idx, []).append(partial)
                            yield _chunk({"tool_calls": [{
                                "index": tc_idx,
                                "function": {"arguments": partial},
                            }]})

                elif event_type == "message_delta":
                    evt_delta = event.delta
                    if getattr(evt_delta, "stop_reason", None):
                        finish_reason = _STOP_REASON_MAP.get(evt_delta.stop_reason, "stop")
                    evt_usage = getattr(event, "usage", None)
                    if evt_usage is not None:
                        output_tokens = getattr(evt_usage, "output_tokens", 0) or output_tokens

                elif event_type == "message_stop":
                    pass

        except anthropic.APIStatusError as e:
            self._map_error(e)
            raise
        except (TimeoutError, anthropic.APITimeoutError) as e:
            raise ServerError(504, f"Upstream timeout: {e}") from e
        except anthropic.APIConnectionError as e:
            raise ServerError(502, f"Connection error: {e}") from e
        finally:
            # Close the upstream stream and the per-request client on every
            # exit path — including client disconnect (GeneratorExit /
            # CancelledError) which lands in finally too. Without this the
            # AsyncAnthropic client + its httpx connection pool leak per
            # aborted streaming request.
            stream_local = locals().get("stream")
            if stream_local is not None:
                try:
                    await stream_local.close()
                except Exception:
                    logger.debug("anthropic stream close failed", exc_info=True)
            await _safe_close(client)

        # Final chunk carries finish_reason + usage so billing captures tokens.
        # Vercel doesn't return input_tokens OR output_tokens in streaming
        # events — estimate both from the request and the accumulated content.
        if input_tokens == 0:
            input_tokens = est_input
        if output_tokens == 0:
            # Build tool_calls list for the estimator
            est_tc: list[dict] = []
            for idx in sorted(tool_args_buf):
                est_tc.append({
                    "function": {
                        "name": "",
                        "arguments": "".join(tool_args_buf[idx]),
                    }
                })
            output_tokens = _estimate_output_tokens_from_content(
                text="".join(text_buf),
                thinking="".join(thinking_buf),
                tool_calls=est_tc,
            )
            if output_tokens:
                logger.info(
                    "Vercel: output_tokens=0 from upstream, estimated %d from content",
                    output_tokens,
                )
        final = _chunk({}, finish_reason)
        final["usage"] = {
            "prompt_tokens": input_tokens,
            "completion_tokens": output_tokens,
            "total_tokens": input_tokens + output_tokens,
        }
        yield final

    # ------------------------------------------------------------------ #
    #  Error mapping                                                     #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _map_error(e: anthropic.APIStatusError) -> None:
        """Translate Anthropic SDK exceptions into the same domain exceptions
        used by ``LiteLLMAdapter`` so ``FallbackExecutor`` handles them
        uniformly."""
        status_code = getattr(e, "status_code", None) or 500

        if status_code in (401, 403):
            raise AuthError(status_code, str(e)) from e
        if status_code == 402:
            raise BillingExhaustedError(str(e)) from e
        if status_code == 429:
            retry_after = AnthropicSdkAdapter._extract_retry_after(e)
            raise RateLimitError(str(e), retry_after=retry_after) from e
        if 500 <= status_code < 600:
            raise ServerError(status_code, str(e)) from e
        if 400 <= status_code < 500:
            body = str(e)
            if "<html" in body[:500].lower() or "<!doctype html" in body[:500].lower():
                raise GatewayError(status_code, str(e)) from e
            raise ClientError(status_code, str(e)) from e
        raise ServerError(502, str(e)) from e

    @staticmethod
    def _extract_retry_after(e: anthropic.APIStatusError) -> int | None:
        """Extract Retry-After (seconds) from a 429 response if present."""
        try:
            response = getattr(e, "response", None)
            if response is None:
                return None
            headers = getattr(response, "headers", None)
            if headers is None:
                return None
            raw = headers.get("retry-after") or headers.get("Retry-After")
            if not raw:
                return None
            try:
                return int(raw)
            except (ValueError, TypeError):
                return None
        except Exception:
            return None


# ===================================================================== #
#  Pure conversion helpers (module-level, easily testable)              #
# ===================================================================== #


def _convert_openai_messages(
    messages: list[dict],
) -> tuple[str | list[dict] | None, list[dict]]:
    """Convert OpenAI messages to Anthropic (system, messages) pair.

    * ``system`` role messages are extracted and concatenated into the
      ``system`` parameter (Anthropic keeps system separate from the
      conversation turns).
    * ``tool`` role messages become ``tool_result`` blocks inside a ``user``
      message — Anthropic requires tool results to be user-role.
    * ``assistant`` tool_calls become ``tool_use`` blocks.
    * Image content (data URIs or URLs) becomes Anthropic image blocks.
    """
    system_parts: list[str] = []
    anthropic_messages: list[dict] = []

    for msg in messages:
        role = msg.get("role")
        content = msg.get("content")

        if role in ("system", "developer"):
            # "developer" is the newer OpenAI convention (used by Codex-like
            # agents such as mimocode) — treat it identically to "system".
            text = _extract_text(content)
            if text:
                system_parts.append(text)
            continue

        if role == "tool":
            # OpenAI tool result → Anthropic tool_result in a user message.
            tool_result = {
                "type": "tool_result",
                "tool_use_id": msg.get("tool_call_id", ""),
                "content": _extract_text(content) or "",
            }
            _append_to_user(anthropic_messages, [tool_result])
            continue

        if role == "assistant":
            blocks: list[dict] = []
            # Preserve reasoning_content (thinking) from previous assistant
            # turns — mimocode sends it back as part of the conversation
            # history. Without this, a large chunk of context is lost and
            # Vercel reports far fewer input tokens than the actual session.
            reasoning = msg.get("reasoning_content")
            if reasoning and isinstance(reasoning, str) and reasoning.strip():
                blocks.append({"type": "thinking", "thinking": reasoning, "signature": ""})
            text = _extract_text(content)
            if text:
                blocks.append({"type": "text", "text": text})
            for tc in msg.get("tool_calls") or []:
                fn = tc.get("function", {})
                args_raw = fn.get("arguments", "")
                try:
                    args_obj = json.loads(args_raw) if isinstance(args_raw, str) and args_raw else args_raw
                except (json.JSONDecodeError, TypeError):
                    args_obj = args_raw
                blocks.append({
                    "type": "tool_use",
                    "id": tc.get("id", ""),
                    "name": fn.get("name", ""),
                    "input": args_obj if isinstance(args_obj, dict) else {"value": args_obj},
                })
            if blocks:
                anthropic_messages.append({"role": "assistant", "content": blocks})
            continue

        if role == "user":
            blocks = _convert_user_content(content)
            if blocks:
                _append_to_user(anthropic_messages, blocks)
            continue

    system = "\n\n".join(system_parts) if system_parts else None
    return system, anthropic_messages


def _append_to_user(messages: list[dict], blocks: list[dict]) -> None:
    """Append blocks to the last message if it's a user message, else create
    a new user message. Anthropic allows consecutive user messages, but merging
    tool_result blocks into the preceding user turn keeps the conversation
    well-formed."""
    if messages and messages[-1]["role"] == "user":
        existing = messages[-1]["content"]
        if isinstance(existing, list):
            existing.extend(blocks)
        else:
            messages[-1]["content"] = [{"type": "text", "text": existing}, *blocks]
    else:
        messages.append({"role": "user", "content": blocks})


def _add_history_cache_control(messages: list[dict]) -> None:
    """Mark the last content block in old conversation history for caching.

    Anthropic prompt caching works by placing ``cache_control`` breakpoints
    on content blocks.  Everything from the start of the request up to each
    breakpoint is cached.  By marking the last block in an older message,
    we cache the entire conversation history — system, tools, old user/
    assistant turns — in a single pass.

    Skips the most recent message (the current user turn that still needs
    processing) so we only cache old, immutable history.

    Anthropic allows max 4 cache breakpoints per request.  We use 3:
      1. System prompt
      2. Last tool definition
      3. Last block in old conversation history (this function)
    """
    if len(messages) < 2:
        return  # Nothing to cache — conversation too short.

    # Walk backwards through messages, skipping the last one (current turn).
    for msg in reversed(messages[:-1]):
        content = msg.get("content")
        if not isinstance(content, list) or not content:
            continue
        # Find the last content block that can carry cache_control.
        for block in reversed(content):
            if isinstance(block, dict) and "type" in block:
                if "cache_control" not in block:
                    block["cache_control"] = {"type": "ephemeral"}
                return


def _convert_user_content(content: Any) -> list[dict]:
    """Convert OpenAI user message content (str or list of parts) to Anthropic
    content blocks."""
    if isinstance(content, str):
        return [{"type": "text", "text": content}] if content else []

    if not isinstance(content, list):
        return [{"type": "text", "text": str(content)}]

    blocks: list[dict] = []
    for part in content:
        if not isinstance(part, dict):
            continue
        part_type = part.get("type")
        if part_type == "text":
            text = part.get("text", "")
            if text:
                blocks.append({"type": "text", "text": text})
        elif part_type == "image_url":
            img_block = _convert_image_url(part.get("image_url", {}))
            if img_block:
                blocks.append(img_block)
    return blocks


def _convert_image_url(image_url: dict | str) -> dict | None:
    """Convert an OpenAI image_url part to an Anthropic image block.

    Supports:
    * data URIs (``data:image/png;base64,...``) → base64 source
    * http(s) URLs → url source (supported by newer Anthropic API versions)
    """
    url = image_url.get("url") if isinstance(image_url, dict) else image_url
    if not url:
        return None

    if url.startswith("data:"):
        # Parse: data:<media_type>;base64,<data>
        try:
            header, data = url.split(",", 1)
            media_type = header.split(":")[1].split(";")[0]
            return {
                "type": "image",
                "source": {"type": "base64", "media_type": media_type, "data": data},
            }
        except (ValueError, IndexError):
            return None

    if url.startswith("http://") or url.startswith("https://"):
        return {"type": "image", "source": {"type": "url", "url": url}}

    return None


def _extract_text(content: Any) -> str:
    """Extract plain text from OpenAI message content (str or parts list)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                parts.append(part.get("text", ""))
        return "".join(parts)
    return ""


def _convert_openai_tool(tool: dict) -> dict:
    """OpenAI tool (function wrapper) → Anthropic tool (name + input_schema)."""
    fn = tool.get("function", tool)
    return {
        "name": fn.get("name", ""),
        "description": fn.get("description", ""),
        "input_schema": fn.get("parameters") or {"type": "object", "properties": {}},
    }


def _convert_openai_tool_choice(tool_choice: Any) -> dict:
    """OpenAI tool_choice → Anthropic tool_choice.

    * ``"auto"``    → ``{"type": "auto"}``
    * ``"none"``    → ``{"type": "none"}``  (Anthropic doesn't have "none"; we
                      just omit tools instead, but this shouldn't be reached
                      when tools are present — handled by caller)
    * ``"required"``→ ``{"type": "any"}``
    * ``{"type": "function", "function": {"name": "x"}}`` → ``{"type": "tool", "name": "x"}``
    """
    if isinstance(tool_choice, str):
        mapping = {"auto": "auto", "required": "any", "none": "none"}
        return {"type": mapping.get(tool_choice, "auto")}
    if isinstance(tool_choice, dict):
        fn = tool_choice.get("function", {})
        name = fn.get("name")
        if name:
            return {"type": "tool", "name": name}
    return {"type": "auto"}


def _estimate_input_tokens(request_body: dict) -> int:
    """Input token estimate for Vercel (which returns 0 for all usage).

    Uses the same bytes/4 heuristic as the rest of the gateway so the count
    is consistent with pre-billing holds.  Counts messages + tools
    definitions.  Only runs for Vercel — other providers return real counts.
    """
    try:
        from app.services.billing.pricing import estimate_tokens_fast
        import json as _json

        messages = request_body.get("messages", [])
        total = estimate_tokens_fast(messages)

        # Count tool definitions — they're part of the input the model sees.
        tools = request_body.get("tools")
        if isinstance(tools, list):
            for tool in tools:
                if isinstance(tool, dict):
                    fn = tool.get("function", tool)
                    total += len(fn.get("name", "").encode("utf-8")) // 4
                    total += len(fn.get("description", "").encode("utf-8")) // 4
                    params = fn.get("parameters")
                    if isinstance(params, dict):
                        total += len(_json.dumps(params).encode("utf-8")) // 4
                    total += 5

        return total
    except Exception:
        return 0


def _estimate_output_tokens_from_content(
    text: str = "",
    thinking: str = "",
    tool_calls: list[dict] | None = None,
) -> int:
    """Cheap output token estimate from accumulated response content.

    Vercel AI Gateway does not return ``output_tokens`` in streaming events
    (just like ``input_tokens``).  This function estimates the output token
    count from the actual content that was streamed/returned — text,
    reasoning (thinking), and tool-call arguments — using the same ~4
    bytes/token heuristic as ``estimate_tokens_fast``.
    """
    total = 0
    if text:
        total += len(text.encode("utf-8")) // 4
    if thinking:
        total += len(thinking.encode("utf-8")) // 4
    for tc in tool_calls or []:
        fn = tc.get("function", {}) if isinstance(tc, dict) else {}
        total += len(fn.get("name", "").encode("utf-8")) // 4
        args = fn.get("arguments", "")
        if isinstance(args, str):
            total += len(args.encode("utf-8")) // 4
        elif isinstance(args, dict):
            import json as _json
            total += len(_json.dumps(args).encode("utf-8")) // 4
        total += 3  # tool-call id + type overhead
    return total
