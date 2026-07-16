# Lunar Joyride — AI-restored music master

`lunar-joyride-restored.flac` is the canonical master for the game music. Re-encode
from THIS file; never transcode the shipped MP3s (that stacks lossy generations).

## Provenance

- Track: "Lunar Joyride v0.8" by FoxSynergy, CC-BY 3.0,
  https://opengameart.org/content/lunar-joyride-8-bit
- The only surviving source is an 80 kbps MP3 (LAME 3.98.2, ~16 kHz cutoff). This
  master is an AI restoration of it: codec-artifact repair plus bandwidth
  extension. It is an estimate of the lost detail, not a recovery.

## How it was made (2026-07-16)

Model: Apollo Universal ("universal super resolution" community checkpoint by Lew,
mirrored at https://huggingface.co/ASesYusuf1/Apollo_universal_model), running on the
Apollo band-sequence restoration architecture (https://github.com/JusperLee/Apollo,
ICASSP 2025). Chosen over Apollo's stock MP3 Enhancer and AudioSR after a blind,
loudness-matched, sample-synced A/B.

```
ffmpeg -i lunar-joyride.mp3 -c:a pcm_f32le input.wav
python inference.py --in_wav input.wav --out_wav restored.wav \
  --ckpt apollo_universal_model.ckpt --config config_apollo.yaml   # feature_dim 384
ffmpeg -i restored.wav -af "aresample=osf=s16:dither_method=triangular_hp" \
  -c:a flac lunar-joyride-restored.flac
```

`inference.py` is jarredou's chunked Apollo runner (chunk 10 s, overlap 2); on Apple
Silicon replace its hardcoded `.cuda()` calls with a `mps` device. Output verified
loudness-consistent with the source (RMS within 0.4 dB), peak -2.7 dBFS.

## Shipped encodes

`public/shared/music/lunar-joyride.mp3` = `android/tv/src/main/res/raw/lunar_joyride.mp3`
(byte-identical, enforced by `tests/i18n-android-parity.test.js`): libmp3lame 192 kbps
CBR 44.1 kHz from the FLAC master. tvOS bundles the web file via its "Sync engine JS"
build phase. MP3 kept (vs AAC/Opus) because every reference — Music.js fetch, ExoPlayer
raw resource, AVFoundation, AirConsole's smart-TV browsers, ad-clip stitch.js — works
unchanged, and old TV webviews decode MP3 most reliably.

## Licensing

- Track: CC-BY 3.0. Attribution ("Music by FoxSynergy" + OGA link) ships in the
  display credits; this file records that the audio was modified (AI restoration).
- Apollo code/weights: CC BY-SA 4.0 (applies to the tooling, not this audio output).
