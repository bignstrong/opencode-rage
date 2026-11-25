# Third-party notices

Rage is based on [safwan-o/opencode-voice](https://github.com/safwan-o/opencode-voice), derived from [ihxnnxs/opencode-voice](https://github.com/ihxnnxs/opencode-voice). The original MIT [license](LICENSE) is retained. Runtime and model sources:

- [Handy](https://github.com/cjpais/Handy) inspired the local-first model experience and supplies the curated `transcribe.cpp` model catalog this plugin pins and verifies.
- Local Whisper transcription uses [`whisper.cpp`](https://github.com/ggml-org/whisper.cpp).
- Handy GGUF transcription runs through the Rust [`transcribe-cpp`](https://crates.io/crates/transcribe-cpp) binding and its upstream `transcribe.cpp` runtime.
- Recording and conversion rely on [FFmpeg](https://ffmpeg.org/) where the platform recorder requires it; managed distribution uses [`ffmpeg-static`](https://github.com/eugeneware/ffmpeg-static).
- Model artifacts are hosted by [Hugging Face](https://huggingface.co/). Individual model creators and licenses remain those declared by each upstream model repository; their pinned source URLs are retained in `lib/handy-model-catalog.js`.
