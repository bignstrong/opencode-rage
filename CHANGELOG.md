# Rage changelog

## 0.2.0

- OpenCode V2 applies `orng` on first activation, retaining the selected theme mode. Later theme choices persist.
- New profiles start with Russian menus and speech, Whisper Turbo, Digital breath, and draft-only dictation. No startup model picker.
- The thinking orb uses the orng orange in animated and still modes.

## 0.1.1

- `rage` starts the native CLI without Node on macOS, including npm symlink installs.
- Managed engines download from Rage’s own `engines-v1` release. Engine bytes and supported platforms are unchanged.

## 0.1.0

- Dictate into an editable OpenCode draft with a system or pinned microphone. On macOS, the microphone picker updates as devices connect or disconnect.
- Recover an interrupted take as an unsent draft in the original session.
- Choose an activity animation with `/orbs` and configure recording, models and shortcuts with `/voice-settings`.
- Build the macOS Rust core and native addon with `npm run build:native`.
