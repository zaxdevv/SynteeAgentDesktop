"""
syntee — SDK для Python-плагинов SynteeHelper (runtime: "python").

Хост запускает `python {main}` и говорит тем же JSON-протоколом, что и
JS-плагинам: сообщения приходят построчно (JSON Lines) в stdin, ответы
пишутся в stdout. SDK прячет протокол за простым API:

    from syntee import syntee

    @syntee.tool("hello", "Поздороваться", parameters={
        "type": "object",
        "properties": {"name": {"type": "string"}},
        "required": ["name"],
    })
    def hello(name: str) -> str:
        return f"Привет, {name}!"

    @syntee.command("demo", "Демо-команда")
    def demo(args: str) -> str:
        return "аргументы: " + args

    syntee.run()   # обязательно в конце — запускает цикл обработки

Доступно также: syntee.log, syntee.storage.{get,set,delete},
syntee.config.get, syntee.fetch, syntee.notify, syntee.on(event),
syntee.deactivate(fn), syntee.host_request(method, **params).

Только stdlib — никаких зависимостей для самого SDK.
"""

import json
import sys
import threading
import traceback

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

_write_lock = threading.Lock()


def _send(msg):
    """Пишет сообщение протокола в stdout (JSON Lines, thread-safe)."""
    line = json.dumps(msg, ensure_ascii=False, default=str)
    with _write_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


class _Storage:
    """KV-хранилище плагина (персистентное, живёт в БД приложения)."""

    def __init__(self, sdk):
        self._sdk = sdk

    def get(self, key, default=None):
        ok, result, err = self._sdk.host_request("storage.get", key=key)
        if not ok:
            return default
        return result.get("value", default) if isinstance(result, dict) else default

    def set(self, key, value):
        ok, _result, err = self._sdk.host_request("storage.set", key=key, value=value)
        if not ok:
            raise RuntimeError(f"storage.set: {err}")

    def delete(self, key):
        self._sdk.host_request("storage.delete", key=key)


class Syntee:
    """API плагина. Единственный инстанс доступен как `syntee.syntee`."""

    def __init__(self):
        self.plugin_dir = ""
        self.permissions = []
        self.version = ""
        self._tools = {}
        self._commands = {}
        self._events = {}      # event → [handlers]
        self._deactivate = None
        self._init_event = threading.Event()
        self._host_waiters = {}  # requestId → {"event", "result"}
        self._waiters_lock = threading.Lock()
        self._started = False
        self.storage = _Storage(self)

    # ── Регистрация (декораторы) ──────────────────────────────────────────

    def tool(self, name=None, description="", parameters=None):
        """Декоратор тула для AI. handler(args: dict) → str | dict | list."""
        def deco(fn):
            tool_name = name or fn.__name__
            self._tools[tool_name] = fn
            _send({
                "type": "registerTool",
                "name": tool_name,
                "description": description or (fn.__doc__ or "").strip(),
                "inputSchema": parameters or {"type": "object", "properties": {}},
            })
            return fn
        return deco

    def command(self, name=None, description="", icon=None):
        """Декоратор слэш-команды: /name args → handler(args: str) → str."""
        def deco(fn):
            cmd_name = name or fn.__name__
            self._commands[cmd_name] = fn
            msg = {"type": "registerCommand", "name": cmd_name,
                   "description": description or (fn.__doc__ or "").strip()}
            if icon:
                msg["icon"] = icon
            _send(msg)
            return fn
        return deco

    def on(self, event):
        """Декоратор хендлера события хоста (chat:message, theme:changed, …).
        Для хуков (chat:before-send, tool:result, prompt:before-build)
        верните {"action": "modify", "content": …} или
        {"action": "reject", "reason": …} — иначе None (allow)."""
        def deco(fn):
            self._events.setdefault(event, []).append(fn)
            events = list(self._events.keys())
            _send({"type": "subscribeEvents", "events": events})
            return fn
        return deco

    def deactivate(self, fn):
        """Декоратор функции очистки — вызывается при выключении плагина."""
        self._deactivate = fn
        return fn

    # ── Утилиты ───────────────────────────────────────────────────────────

    def log(self, message, level="info"):
        """Запись в журнал плагина (виден в карточке UI). level: info|warn|error."""
        _send({"type": "log", "level": level, "message": str(message)})

    def notify(self, title, body=""):
        """Системное уведомление (permission: notifications)."""
        return self.host_request("notification.show", title=str(title), body=str(body))

    def config_get(self, key, default=None):
        """Значение настройки плагина (схема config в манифесте)."""
        ok, result, _err = self.host_request("config.get", key=key)
        if not ok:
            return default
        return result if result is not None else default

    def fetch(self, url, method="GET", headers=None, body=None, binary=False, timeout=None):
        """HTTP-запрос через хост (permission: net). → dict:
        {ok, status, headers, body} или {ok, status, headers, bodyBase64}."""
        init = {"method": method}
        if headers:
            init["headers"] = headers
        if body is not None:
            init["body"] = body
        params = {"url": url, "init": init}
        if binary:
            params["binary"] = True
        ok, result, err = self.host_request("net.fetch", **params)
        if not ok:
            return {"ok": False, "error": err}
        result["ok"] = True
        return result

    def host_request(self, method, timeout=None, **params):
        """Прямой запрос к host-API (см. доку plugin_docs, секция api-core).
        timeout — секунды ожидания ответа (по умолчанию 60).
        → (ok: bool, result, error: str | None)."""
        request_id = f"py-{id(self)}-{threading.get_ident()}-{next(self._counter)}"
        event = threading.Event()
        with self._waiters_lock:
            self._host_waiters[request_id] = {"event": event, "result": None}
        _send({"type": "hostRequest", "requestId": request_id,
               "method": method, "params": params})
        if not event.wait(timeout or 60):
            with self._waiters_lock:
                self._host_waiters.pop(request_id, None)
            return False, None, f"hostRequest timeout: {method}"
        with self._waiters_lock:
            entry = self._host_waiters.pop(request_id, None)
        if entry is None:
            return False, None, f"hostRequest потерян: {method}"
        resp = entry["result"] or {}
        if resp.get("ok"):
            return True, resp.get("result"), None
        return False, None, resp.get("error") or f"hostRequest error: {method}"

    _counter = iter(range(1, 1 << 30))

    # ── Цикл обработки ────────────────────────────────────────────────────

    def run(self):
        """Запускает цикл обработки. Обязательная последняя строка main-файла.
        Блокирует навсегда (до shutdown). Reader-поток уже работает с момента
        импорта (init приходит в stdin раньше, чем пользовательский код
        доберётся до run()) — здесь дожидаемся init и подтверждаем активацию."""
        if self._started:
            return
        self._started = True
        if not self._init_event.wait(timeout=30):
            sys.stderr.write("[syntee] init от хоста не получен за 30с\n")
            sys.exit(1)
        _send({"type": "initResult", "requestId": self._init_request_id, "ok": True})
        # Главный поток спит вечно; вся работа — в reader + worker-тредах.
        threading.Event().wait()

    # internals ---------------------------------------------------------------

    def _read_loop(self):
        for line in sys.stdin:
            # BOM (UTF-8 BOM от некоторых тулов/пайпов Windows) ломает JSON.
            line = line.strip().lstrip("﻿")
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                self.log(f"не-JSON от хоста: {line[:200]}", "error")
                continue
            try:
                self._dispatch(msg)
            except Exception:
                sys.stderr.write(traceback.format_exc())

    def _dispatch(self, msg):
        mtype = msg.get("type")
        if mtype == "init":
            self.plugin_dir = msg.get("pluginDir", "")
            self.permissions = msg.get("permissions", [])
            env = msg.get("env", {})
            self.version = env.get("appVersion", "")
            self._init_request_id = msg.get("requestId", "")
            self._init_event.set()
        elif mtype == "hostResponse":
            with self._waiters_lock:
                entry = self._host_waiters.get(msg.get("requestId"))
            if entry is not None:
                entry["result"] = msg
                entry["event"].set()
        elif mtype == "callTool":
            threading.Thread(target=self._handle_call_tool, args=(msg,), daemon=True).start()
        elif mtype == "callCommand":
            threading.Thread(target=self._handle_call_command, args=(msg,), daemon=True).start()
        elif mtype == "hook":
            threading.Thread(target=self._handle_hook, args=(msg,), daemon=True).start()
        elif mtype == "event":
            threading.Thread(target=self._handle_event, args=(msg,), daemon=True).start()
        elif mtype == "uiMessage":
            threading.Thread(target=self._handle_event, args=(msg,), daemon=True).start()
        elif mtype == "shutdown":
            threading.Thread(target=self._handle_shutdown, args=(msg,), daemon=True).start()
        else:
            # callHandler / uiCall и прочее — generic-заглушка с понятной ошибкой.
            if mtype in ("callHandler", "uiCall"):
                kind = "callHandlerResult" if mtype == "callHandler" else "uiCallResult"
                threading.Thread(
                    target=lambda: _send({
                        "type": kind, "requestId": msg.get("requestId"), "ok": False,
                        "error": "Этот тип регистрации пока не поддержан в Python SDK",
                    }),
                    daemon=True,
                ).start()

    def _handle_call_tool(self, msg):
        name = msg.get("toolName", "")
        handler = self._tools.get(name)
        try:
            if handler is None:
                raise RuntimeError(f"Тул не зарегистрирован: {name}")
            result = handler(msg.get("args") or {})
            if not isinstance(result, str):
                result = json.dumps(result, ensure_ascii=False, default=str)
            _send({"type": "callToolResult", "requestId": msg.get("requestId"),
                   "ok": True, "output": result})
        except Exception as e:
            _send({"type": "callToolResult", "requestId": msg.get("requestId"),
                   "ok": False, "error": f"{type(e).__name__}: {e}"})

    def _handle_call_command(self, msg):
        name = msg.get("commandName", "")
        handler = self._commands.get(name)
        try:
            if handler is None:
                raise RuntimeError(f"Команда не зарегистрирована: {name}")
            result = handler(msg.get("args") or "")
            if not isinstance(result, str):
                result = json.dumps(result, ensure_ascii=False, default=str)
            _send({"type": "callCommandResult", "requestId": msg.get("requestId"),
                   "ok": True, "output": result})
        except Exception as e:
            _send({"type": "callCommandResult", "requestId": msg.get("requestId"),
                   "ok": False, "error": f"{type(e).__name__}: {e}"})

    def _handle_hook(self, msg):
        event = msg.get("event", "")
        action, content, error = "allow", None, None
        try:
            for handler in self._events.get(event, []):
                res = handler(msg.get("payload") or {})
                if isinstance(res, dict):
                    if res.get("action") == "reject":
                        action, error = "reject", res.get("reason")
                        break
                    if res.get("action") == "modify" and isinstance(res.get("content"), str):
                        action, content = "modify", res["content"]
        except Exception as e:
            self.log(f"hook {event}: {type(e).__name__}: {e}", "error")
        _send({"type": "hookResult", "requestId": msg.get("requestId"),
               "ok": action != "reject", "action": action,
               "content": content, "error": error})

    def _handle_event(self, msg):
        event = msg.get("event", "")
        payload = msg.get("payload") if msg.get("type") == "event" else msg.get("data")
        for handler in self._events.get(event, []):
            try:
                handler(payload or {})
            except Exception as e:
                self.log(f"event {event}: {type(e).__name__}: {e}", "error")

    def _handle_shutdown(self, msg):
        try:
            if self._deactivate:
                self._deactivate()
        except Exception as e:
            self.log(f"deactivate: {type(e).__name__}: {e}", "error")
        _send({"type": "shutdownResult", "requestId": msg.get("requestId")})
        sys.exit(0)


# Единственный инстанс: `from syntee import syntee`.
# Reader-поток стартует сразу — init-сообщение хоста приходит в stdin
# до того, как пользовательский код дойдёт до syntee.run().
syntee = Syntee()
threading.Thread(target=syntee._read_loop, daemon=True).start()
