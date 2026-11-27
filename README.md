# Syntee Helper

**Русский** · [English](README.en.md)

AI-ассистент для Windows и Linux. Чат с несколькими провайдерами, работа с кодом и файлами, MCP, плагины, скиллы и локальные мини-агенты.

## Установка

- Windows x64 — `Syntee-Helper-Setup-<версия>-x64.exe`.
- Linux x86_64 — переносимый `syntee-helper-<версия>-x86_64.tar.zst`.
- Arch x86_64 — `sudo pacman -U <файл.pkg.tar.zst>`.

Опубликованные сборки и SHA-256 находятся в [Releases](../../releases). Пока публикация на паузе, тестовые сборки находятся в [Actions](../../actions/workflows/test-release.yml).

## Что есть в 1.1.8

Большие каталоги MCP загружаются по запросу. В настройках контекста можно вернуть полный каталог. Скиллы ищутся по имени и описанию, полные инструкции открываются через `get_skill`. Мини-агенты сохраняют журнал между запусками. В настройках можно выбрать обычную локальную модель или Qwen2.5 Coder Abliterated.

## Сборка

Нужны Node.js 24+, Rust, на Windows — Visual Studio C++ Build Tools и Python, на Linux — CMake, pkg-config и zstd.

```sh
npm ci
npm run build:win:installer  # Windows
npm run build:linux          # Linux
```

Для пакета Arch запустите `makepkg -si` в `packaging/arch`. Для разработки — `npm run dev`, для проверок — `npm run build && npm test`. На Linux тестам Electron может потребоваться Xvfb.

Ветки форка продвигаются по порядку `dev` → `dev-1.1.6` → `test-release` → `release`. Тег версии и публикация выполняются отдельно. Для сборки своего канала задайте `SYNTEE_RELEASE_REPOSITORY=owner/repo`. CI подставляет текущий репозиторий.

[Документация](docs/) · [Rust sidecar](Sidecar/) · [Ошибки и предложения](../../issues) · [MIT](LICENSE)
