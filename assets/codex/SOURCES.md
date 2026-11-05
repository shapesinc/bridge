# Bundled upstream notices

- `LICENSE`, `NOTICE`: https://github.com/openai/codex/tree/rust-v0.166.0
- `RATATUI-LICENSE-MIT`: https://github.com/ratatui/ratatui/blob/ratatui-v0.30.2/LICENSE (Codex's pinned Cargo workspace version; also named in upstream NOTICE).
- `RIPGREP-LICENSE-MIT`: https://github.com/BurntSushi/ripgrep/blob/15.2.0/LICENSE-MIT (version printed by the packaged `rg`).

Official app-server archives and SHA-256 values are pinned in `runtime.json`.
The distributions are preserved intact; shapes.inc signs their macOS executables
as nested components and adds these license/notice files for redistribution.
