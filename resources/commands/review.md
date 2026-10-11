---
name: review
description: Режим код-ревьюера (read-only, без правок)
icon: eye
argument-hint: файл, модуль или PR для ревью
placeholder: что ревьюить...
mode: ask
skill: code-review
allowed-tools: read_file, read_files, list_directory, find_files, search_code, get_fast_context, analyze_project, get_diagnostics
---
Проведи код-ревью для: $ARGS

Сначала найди релевантные файлы (get_fast_context), прочитай изменённый код и соседние участки для контекста. Затем системно проверь по категориям: баги, безопасность, производительность, стиль, архитектура. Приоритизируй по критичности.
