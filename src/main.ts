import Lenis from 'lenis';
import {
  ALL_FORMATS,
  BlobSource,
  UrlSource,
  VideoSampleSink,
  Input,
  type InputVideoTrack,
} from 'mediabunny';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <main>
    <section class="hero">
      <div class="hud">
        <div>
          <span class="eyebrow">Mediabunny × Lenis</span>
          <h1>Scroll-controlled<br><em>video.</em></h1>
        </div>
        <div class="controls">
          <label class="toggle">
            <input id="lenis-toggle" type="checkbox" checked />
            <span class="switch"></span>
            <span>Use Lenis</span>
          </label>
          <label class="file-input">
            <span>Load video</span>
            <input id="video-file" type="file" accept="video/*,.mp4,.webm,.mov" />
          </label>
        </div>
      </div>

      <div class="scrub-stage">
        <canvas id="video-canvas" aria-label="Scroll scrubbed video"></canvas>
        <div class="loading" id="loading">Loading video…</div>
        <div class="status" id="status">0.0s · 0%</div>
      </div>

      <div class="hint">Scroll to scrub · toggle Lenis on or off</div>
    </section>



    <!--
    <section class="spacer">
      <div>
        <span>01</span>
        <h2>One scroll position.<br/>One requested frame.</h2>
        <p>Mediabunny decodes the frame corresponding to the current scroll position. The demo only asks for a new frame when the target timestamp changes.</p>
      </div>
    </section>
    <section class="spacer dark">
      <div>
        <span>02</span>
        <h2>Lenis is optional.</h2>
        <p>Turn it off to drive the same decoder directly from window.scrollY. Turn it on to let Lenis provide the smooth, physics-based scroll value.</p>
      </div>
    </section>
    -->

  </main>
`;

const canvas = document.querySelector<HTMLCanvasElement>('#video-canvas')!;
const ctx = canvas.getContext('2d', { alpha: false })!;
const loading = document.querySelector<HTMLDivElement>('#loading')!;
const status = document.querySelector<HTMLDivElement>('#status')!;
const lenisToggle = document.querySelector<HTMLInputElement>('#lenis-toggle')!;
const fileInput = document.querySelector<HTMLInputElement>('#video-file')!;

let input: Input | null = null;
let track: InputVideoTrack | null = null;
let sink: VideoSampleSink | null = null;
let duration = 0;
let targetTimestamp = 0;
let decodedTimestamp = -1;
let pumping = false;
let sourceUrl: string | null = null;
let lenis: Lenis | null = null;

async function loadVideo(source: Blob | string) {
  loading.hidden = false;
  loading.textContent = 'Reading video…';

  input?.dispose();
  input = null;
  track = null;
  sink = null;
  targetTimestamp = 0;
  decodedTimestamp = -1;

  while (pumping) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }

  const mediaSource = typeof source === 'string'
    ? new UrlSource(source)
    : new BlobSource(source);

  input = new Input({
    source: mediaSource,
    formats: ALL_FORMATS,
  });

  track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('No video track found.');

  const canDecode = await track.canDecode();
  if (!canDecode) throw new Error('This browser cannot decode this video with Mediabunny/WebCodecs.');

  duration = await track.computeDuration();
  const width = await track.getDisplayWidth();
  const height = await track.getDisplayHeight();

  canvas.width = width;
  canvas.height = height;
  // One VideoSampleSink; getSample still opens a decoder per call, so we
  // never run more than one of those at a time (see pumpFrames).
  sink = new VideoSampleSink(track, {
    optimizeForLatency: true,
  });

  loading.textContent = 'Ready';
  loading.hidden = true;
  await pumpFrames();
}

function timestampEpsilon() {
  return duration > 0 ? Math.max(duration / 10_000, 1 / 240) : 1 / 240;
}

async function pumpFrames() {
  if (pumping || !sink || duration <= 0) return;
  pumping = true;

  try {
    while (sink) {
      const timestamp = targetTimestamp;
      if (Math.abs(timestamp - decodedTimestamp) < timestampEpsilon()) break;

      const activeSink = sink;
      let sample = null;
      try {
        sample = await activeSink.getSample(timestamp);
      } catch (error) {
        if (!sink) break;
        console.error(error);
        decodedTimestamp = timestamp;
        break;
      }

      if (!sink) {
        sample?.close();
        break;
      }

      if (sample) {
        sample.draw(ctx, 0, 0, canvas.width, canvas.height);
        sample.close();
      }

      decodedTimestamp = timestamp;
    }
  } finally {
    pumping = false;
  }

  if (sink && Math.abs(targetTimestamp - decodedTimestamp) >= timestampEpsilon()) {
    void pumpFrames();
  }
}

function getNativeProgress() {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
}

function updateFromProgress(progress: number) {
  const clamped = Math.min(1, Math.max(0, progress));
  status.textContent = `${(clamped * duration).toFixed(2)}s · ${(clamped * 100).toFixed(1)}%`;
  if (duration <= 0 || !sink) return;

  targetTimestamp = clamped * duration;
  void pumpFrames();
}

function onLenisScroll({ scroll, limit }: { scroll: number; limit: number }) {
  updateFromProgress(limit > 0 ? scroll / limit : 0);
}

function enableLenis() {
  if (lenis) return;

  lenis = new Lenis({
    autoRaf: false,
    lerp: 0.1,
  });
  lenis.on('scroll', onLenisScroll);
  lenis.scrollTo(window.scrollY, { immediate: true });
  updateFromProgress(lenis.limit > 0 ? lenis.scroll / lenis.limit : 0);
}

function disableLenis() {
  if (!lenis) return;

  lenis.destroy();
  lenis = null;
  updateFromProgress(getNativeProgress());
}

function setLenisEnabled(enabled: boolean) {
  if (enabled) enableLenis();
  else disableLenis();
}

window.addEventListener('scroll', () => {
  if (!lenis) updateFromProgress(getNativeProgress());
}, { passive: true });

function raf(time: number) {
  lenis?.raf(time);
  requestAnimationFrame(raf);
}
requestAnimationFrame(raf);

lenisToggle.addEventListener('change', () => {
  setLenisEnabled(lenisToggle.checked);
});

setLenisEnabled(lenisToggle.checked);

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  try {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    sourceUrl = URL.createObjectURL(file);
    await loadVideo(file);
  } catch (error) {
    loading.hidden = false;
    loading.textContent = error instanceof Error ? error.message : 'Could not load video.';
    console.error(error);
  }
});

window.addEventListener('resize', () => {
  if (!lenis) updateFromProgress(getNativeProgress());
});

loadVideo(`${import.meta.env.BASE_URL}7d-200fps.mp4`).catch((error) => {
  loading.hidden = false;
  loading.textContent = 'Demo video failed to load. Choose a video above.';
  console.error(error);
});
