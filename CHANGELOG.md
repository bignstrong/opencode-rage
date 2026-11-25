# Rage changelog

## 0.1.1

- `rage` starts the native CLI without Node on macOS, including npm symlink installs.
- Managed engines download from Rage’s own `engines-v1` release. Engine bytes and supported platforms are unchanged.

## 0.1.0

- Dictate into an editable OpenCode draft with a system or pinned microphone. On macOS, the microphone picker updates as devices connect or disconnect.
- Recover an interrupted take as an unsent draft in the original session.
- Choose an activity animation with `/orbs` and configure recording, models and shortcuts with `/voice-settings`.
- Build the macOS Rust core and native addon with `npm run build:native`.
