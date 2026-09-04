# scrubby-dub 🧼

A small, intentionally dependency-light demo for **frame-accurate-ish scroll scrubbing** with [Mediabunny](https://mediabunny.dev/) and optional [Lenis](https://lenis.darkroom.engineering/).

<img width="1066" height="779" alt="Screenshot 1537" src="https://github.com/user-attachments/assets/05092f31-d91a-4be6-b4d3-f03962521acd" />


## What it demonstrates

- Native `window.scrollY` → video timestamp.
- Optional Lenis physics → video timestamp.
- Mediabunny `VideoSampleSink.getSample(timestamp)` for frame retrieval.
- Direct `VideoSample.draw()` into one persistent canvas — no per-seek canvas allocation.
- A stale-request guard so slow decoder results don't overwrite a newer scroll position.
- User-supplied local video files, in addition to the included demo asset.

## Run

```bash
pnpm install
pnpm dev
```

Open the local Vite URL (dev is served under `/scrubby-dub/`).

To publish on GitHub Pages from the `docs/` folder:

```bash
pnpm build
```

That writes into `docs/` with asset URLs under `/scrubby-dub/`, which matches [https://spencer-sweet.github.io/scrubby-dub/](https://spencer-sweet.github.io/scrubby-dub/).

## Production notes

This is deliberately a **demo**, not a finished video player.

For a production scroll sequence:

1. Encode the asset with a GOP/keyframe strategy appropriate for seeking. More frequent keyframes reduce seek latency at the cost of file size — a scrub always redecodes from the nearest keyframe forward (`VideoDecoder.flush()` requires the next `decode()` to be a keyframe, so a decoder can't resume mid-GOP), and some browsers' WebCodecs decoders are slow enough per-frame that a long GOP is noticeably choppy even though the same file scrubs fine elsewhere. In this repo, Firefox was visibly choppy on the original ~70-frame GOP demo clip and much smoother once re-encoded to a 6-frame GOP.

   To re-encode a video with a short keyframe interval and rebuild the site, use [`optimize.sh`](optimize.sh):

   ```bash
   ./optimize.sh public/your-video.mp4        # defaults to a 6-frame GOP at CRF 23
   ./optimize.sh public/your-video.mp4 12 20  # override: 12-frame GOP, CRF 20
   ```

   It re-encodes the file in place (via `ffmpeg -g <gop> -keyint_min <gop> -sc_threshold 0`, which forces a keyframe every `<gop>` frames instead of x264's default scene-cut-based GOP — that can otherwise run 60–90+ frames between keyframes) and then runs `pnpm build` to regenerate `docs/`.

   - Shorter GOPs cost bitrate at the same CRF (more full frames = more bits) — going from a ~70-frame to a 6-frame GOP roughly doubled this repo's demo clip's file size for a ~5x drop in average redecode time. Check a file's current GOP length with `ffprobe`:
     ```bash
     ffprobe -v error -select_streams v:0 -show_entries frame=pict_type -of csv public/your-video.mp4 | grep -c ',I'
     ```
     (keyframe count — compare against total frame count for the average GOP length)
   - Nothing publishes until the resulting changes are committed and pushed — review with `git status`/`git diff --stat` first.
2. Test H.264/AVC first for broad WebCodecs availability.
3. Benchmark Safari/iOS separately; WebCodecs availability and codec support should be checked at runtime.
4. Keep the decoder work out of the render path where possible and only paint the newest completed frame.
5. If the source is very long or very high resolution, consider a dedicated worker/rendering architecture and lower-resolution preview assets.

Mediabunny's `CanvasSink` is useful here because it retrieves decoded frames at timestamps and can reuse a canvas pool. Its `getCanvas()` call returns the last frame at or before the requested timestamp. See the Mediabunny docs for the underlying behavior.

## Acknowledgements
- Demo footage is a snippet from [Oton Bacar](https://vimeo.com/17439665)'s rad video on Vimeo
