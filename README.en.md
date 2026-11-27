# Syntee Helper

[Русский](README.md) · **English**

A desktop AI assistant for Windows and Linux with multiple providers, an agent for code and files, MCP, plugins, skills, and local assistants.

## Install

- Windows x64 uses `Syntee-Helper-Setup-<version>-x64.exe`.
- Linux x86_64 uses the portable `syntee-helper-<version>-x86_64.tar.zst`.
- Arch x86_64 packages install with `sudo pacman -U <file.pkg.tar.zst>`.

Published builds and checksums are in [Releases](../../releases). While publication is paused, test builds are available in [Actions](../../actions/workflows/test-release.yml).

## Version 1.1.8

Large MCP catalogues load on demand. Context settings can restore the full catalogue. Skill search returns matching names and descriptions, and `get_skill` opens the full instructions. Assistant logs survive restarts. The local model menu offers standard models and Qwen2.5 Coder Abliterated.

## Build

Requires Node.js 24+ and Rust. Windows needs Visual Studio C++ Build Tools and Python. Linux needs CMake, pkg-config, and zstd.

```sh
npm ci
npm run build:win:installer  # Windows
npm run build:linux          # Linux
```

For an Arch package, run `makepkg -si` in `packaging/arch`. Use `npm run dev` for development and `npm run build && npm test` for verification. Electron tests on Linux may need Xvfb.

The fork promotes changes through `dev` → `dev-1.1.6` → `test-release` → `release`. Tagging and publication are separate. Set `SYNTEE_RELEASE_REPOSITORY=owner/repo` when building an update channel locally. CI uses the current repository.

[Documentation](docs/) · [Rust sidecar](Sidecar/) · [Issues](../../issues) · [MIT](LICENSE)
