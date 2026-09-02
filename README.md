# scrubby-dub

A small, intentionally dependency-light demo for **frame-accurate-ish scroll scrubbing** with [Mediabunny](https://mediabunny.dev/) and optional [Lenis](https://lenis.darkroom.engineering/).

## What it demonstrates

- Native `window.scrollY` → video timestamp.
- Optional Lenis physics → video timestamp.
- Mediabunny `VideoSampleSink.getSample(timestamp)` for frame retrieval.
- Direct `VideoSample.draw()` into one persistent canvas — no per-seek canvas allocation.
- A stale-request guard so slow decoder results don't overwrite a newer scroll position.
- User-supplied local video files, in addition to the included demo asset.

## Run

```bash
npm install
npm run dev
```

Open the local Vite URL.

## Production notes

This is deliberately a **demo**, not a finished video player.

For a production scroll sequence:

1. Encode the asset with a GOP/keyframe strategy appropriate for seeking. More frequent keyframes can reduce seek latency at the cost of file size.
2. Test H.264/AVC first for broad WebCodecs availability.
3. Benchmark Safari/iOS separately; WebCodecs availability and codec support should be checked at runtime.
4. Keep the decoder work out of the render path where possible and only paint the newest completed frame.
5. If the source is very long or very high resolution, consider a dedicated worker/rendering architecture and lower-resolution preview assets.

Mediabunny's `CanvasSink` is useful here because it retrieves decoded frames at timestamps and can reuse a canvas pool. Its `getCanvas()` call returns the last frame at or before the requested timestamp. See the Mediabunny docs for the underlying behavior.
