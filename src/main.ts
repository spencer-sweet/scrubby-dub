import Lenis from 'lenis';
import {
  ALL_FORMATS,
  BlobSource,
  UrlSource,
  EncodedPacketSink,
  VideoSample,
  Input,
  type Rotation,
} from 'mediabunny';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <main>
    <section class="hero">
      <div class="hud">
        <div class="brand">
          <a
            class="eyebrow"
            href="https://github.com/spencer-sweet/scrubby-dub"
            target="_blank"
            rel="noopener noreferrer"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
            spencer-sweet/scrubby-dub
          </a>
          <h1>Scroll-controlled<br><em>video.</em></h1>
        </div>
        <div class="controls">
          <label class="toggle">
            <input id="lenis-toggle" type="checkbox" />
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
        <div class="scrub-fallback" id="scrub-fallback">
          <video
            id="fallback-video"
            class="scrub-video"
            muted
            playsinline
            preload="auto"
            crossorigin="anonymous"
            disablepictureinpicture
          ></video>
          <p class="fallback-note">HTML video fallback</p>
        </div>
        <div class="loading" id="loading">Loading video…</div>
        <div class="status" id="status">0.0s · 0%</div>
      </div>

      <div class="hint">Scroll to scrub</div>
    </section>

  </main>
`;

const canvas = document.querySelector<HTMLCanvasElement>('#video-canvas')!;
const ctx = canvas.getContext('2d', { alpha: false }) ?? canvas.getContext('2d')!;
const htmlVideo = document.querySelector<HTMLVideoElement>('#fallback-video')!;
const fallbackWrap = document.querySelector<HTMLDivElement>('#scrub-fallback')!;
const loading = document.querySelector<HTMLDivElement>('#loading')!;
const status = document.querySelector<HTMLDivElement>('#status')!;
const lenisToggle = document.querySelector<HTMLInputElement>('#lenis-toggle')!;
const fileInput = document.querySelector<HTMLInputElement>('#video-file')!;

htmlVideo.playsInline = true;
htmlVideo.muted = true;
htmlVideo.setAttribute('webkit-playsinline', 'true');
htmlVideo.controls = false;
htmlVideo.hidden = true;

const isAndroid = /Android/i.test(navigator.userAgent);
const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;

// Chrome on Android exposes VideoDecoder but MediaCodec/WebCodecs often
// rejects the H.264 configs Mediabunny feeds it (High profile, B-frames),
// or configure() succeeds and decode then fails silently. The HTML <video>
// element uses the same platform decoder through a path that actually works.
function preferHtmlVideoPlayback() {
  return isAndroid || typeof VideoDecoder !== 'function';
}

// Budget for the decoded-frame cache: cap by estimated memory rather than a
// fixed frame count, so a 4K upload doesn't try to hold as many frames as a
// 720p one. ~2 bytes/pixel covers 4:2:0 chroma-subsampled video with margin.
const FRAME_CACHE_BUDGET_BYTES = (isAndroid ? 48 : 256) * 1024 * 1024;

// A VideoDecoder kept alive for the whole scrub session, plus the packet
// sink used to feed it. VideoDecoder.flush() requires the next decode() call
// to be a key frame, so a *fresh* seek still redecodes from the nearest key
// frame forward (same total decode work as VideoSampleSink.getSample()) —
// keeping the decoder alive only avoids reconfiguring/closing it on every
// single scrub frame. What actually avoids the redecode is `frameCache`:
// every frame produced while walking from a key frame to a target is kept
// (LRU-bounded by `maxCachedFrames`), so re-visiting anywhere in an
// already-decoded stretch — the common case when scrubbing back and forth —
// is a plain cache hit with no decoder involved at all.
type WebCodecsSession = {
  kind: 'webcodecs';
  packetSink: EncodedPacketSink;
  decoder: VideoDecoder;
  rotation: Rotation;
  displayWidth: number;
  displayHeight: number;
  latestFrame: VideoFrame | null;
  frameCache: Map<number, VideoFrame>; // keyed by EncodedPacket.sequenceNumber, in LRU order
  maxCachedFrames: number;
  // Maps an in-flight decode chunk's timestamp (microseconds) back to the
  // packet it came from, so the decoder's output callback knows which cache
  // key to store each produced frame under.
  pendingSequenceByTimestamp: Map<number, number>;
};

type HtmlVideoSession = {
  kind: 'html';
  video: HTMLVideoElement;
  seekGeneration: number;
};

type DecodeSession = WebCodecsSession | HtmlVideoSession;

function cacheGet(session: WebCodecsSession, sequenceNumber: number): VideoFrame | undefined {
  const frame = session.frameCache.get(sequenceNumber);
  if (frame) {
    // Bump to most-recently-used by reinserting (Map preserves insertion order).
    session.frameCache.delete(sequenceNumber);
    session.frameCache.set(sequenceNumber, frame);
  }
  return frame;
}

function cachePut(session: WebCodecsSession, sequenceNumber: number, frame: VideoFrame) {
  session.frameCache.get(sequenceNumber)?.close();
  session.frameCache.delete(sequenceNumber);
  session.frameCache.set(sequenceNumber, frame);

  while (session.frameCache.size > session.maxCachedFrames) {
    const oldestKey = session.frameCache.keys().next().value;
    if (oldestKey === undefined) break;
    session.frameCache.get(oldestKey)?.close();
    session.frameCache.delete(oldestKey);
  }
}

// Draws a frame and closes it (and its VideoSample wrapper) immediately.
// Every VideoSample MUST be closed synchronously like this: mediabunny's
// finalizer closes the *underlying* VideoFrame whenever an unclosed
// VideoSample wrapper gets garbage collected, regardless of whether anything
// else — like frameCache — still needs that frame. An uncollected wrapper
// around a cached frame would silently invalidate it at some random future
// GC pause. So this always takes ownership; draw a cached frame via a
// disposable clone() instead of calling this directly on the cached frame.
function drawAndCloseFrame(session: WebCodecsSession, frame: VideoFrame) {
  const sample = new VideoSample(frame, {
    rotation: session.rotation,
    displayWidth: session.displayWidth,
    displayHeight: session.displayHeight,
    timestamp: frame.timestamp / 1e6,
  });
  sample.draw(ctx, 0, 0, canvas.width, canvas.height);
  sample.close();
}

let input: Input | null = null;
let activeSession: DecodeSession | null = null;
let duration = 0;
let targetTimestamp = 0;
let decodedTimestamp = -1;
let sourceUrl: string | null = null;
let lenis: Lenis | null = null;

// Woken up whenever targetTimestamp changes (or the session is torn down), so
// the decode loop below can react without polling.
let updateSignal = 0;
let wakeResolvers: Array<() => void> = [];

function wake() {
  updateSignal++;
  const resolvers = wakeResolvers;
  wakeResolvers = [];
  for (const resolve of resolvers) resolve();
}

function waitForWake(signalBefore: number): Promise<void> {
  if (updateSignal !== signalBefore) return Promise.resolve();
  return new Promise((resolve) => wakeResolvers.push(resolve));
}

function setPlaybackSurface(mode: 'webcodecs' | 'html') {
  const html = mode === 'html';
  htmlVideo.hidden = !html;
  htmlVideo.classList.toggle('is-active', html);
  fallbackWrap.classList.toggle('is-active', html);
  canvas.hidden = html;
  canvas.classList.toggle('is-hidden', html);
}

function teardownSession() {
  if (activeSession?.kind === 'webcodecs') {
    activeSession.latestFrame?.close();
    for (const frame of activeSession.frameCache.values()) frame.close();
    try {
      activeSession.decoder.close();
    } catch {
      // Already closed.
    }
  }

  input?.dispose();
  input = null;
  activeSession = null;
  targetTimestamp = 0;
  decodedTimestamp = -1;
  duration = 0;
  wake();

  htmlVideo.pause();
  htmlVideo.removeAttribute('src');
  htmlVideo.load();
  setPlaybackSurface('webcodecs');
}

async function configureDecoder(decoder: VideoDecoder, base: VideoDecoderConfig) {
  const attempts: VideoDecoderConfig[] = [
    { ...base, optimizeForLatency: true, hardwareAcceleration: 'prefer-software' },
    { ...base, hardwareAcceleration: 'prefer-software' },
    { ...base, optimizeForLatency: true },
    base,
  ];

  for (const config of attempts) {
    try {
      if (typeof VideoDecoder.isConfigSupported === 'function') {
        const { supported } = await VideoDecoder.isConfigSupported(config);
        if (!supported) continue;
      }
      decoder.configure(config);
      return;
    } catch {
      // Try the next, more conservative config.
    }
  }

  throw new Error('Could not configure a WebCodecs video decoder.');
}

function waitForVideoEvent(video: HTMLVideoElement, event: string) {
  return new Promise<void>((resolve, reject) => {
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(video.error ?? new Error(`Video failed during ${event}.`));
    };
    const cleanup = () => {
      video.removeEventListener(event, onEvent);
      video.removeEventListener('error', onError);
    };
    video.addEventListener(event, onEvent, { once: true });
    video.addEventListener('error', onError, { once: true });
  });
}

async function loadWithHtmlVideo(source: Blob | string) {
  loading.textContent = 'Preparing video…';
  setPlaybackSurface('html');

  const url = typeof source === 'string'
    ? source
    : (sourceUrl = URL.createObjectURL(source));

  htmlVideo.src = url;
  htmlVideo.load();
  await waitForVideoEvent(htmlVideo, 'loadedmetadata');

  if (!Number.isFinite(htmlVideo.duration) || htmlVideo.duration <= 0) {
    throw new Error('Could not read video duration.');
  }

  duration = htmlVideo.duration;
  canvas.width = htmlVideo.videoWidth || 1280;
  canvas.height = htmlVideo.videoHeight || 720;

  // Android Chrome often will not paint a frame until playback has started
  // at least once, even for a muted inline video.
  try {
    await htmlVideo.play();
    htmlVideo.pause();
  } catch {
    // Autoplay may still be blocked; seeking usually works after metadata.
  }

  const session: HtmlVideoSession = {
    kind: 'html',
    video: htmlVideo,
    seekGeneration: 0,
  };
  activeSession = session;
  loading.textContent = 'Ready';
  loading.hidden = true;
  updateFromProgress(getNativeProgress());
  void runDecodeLoop(session);
}

async function loadWithWebCodecs(source: Blob | string) {
  loading.textContent = 'Reading video…';
  setPlaybackSurface('webcodecs');

  const mediaSource = typeof source === 'string'
    ? new UrlSource(source)
    : new BlobSource(source);

  input = new Input({
    source: mediaSource,
    formats: ALL_FORMATS,
  });

  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('No video track found.');

  const canDecode = await track.canDecode();
  if (!canDecode) throw new Error('This browser cannot decode this video with Mediabunny/WebCodecs.');

  duration = await track.computeDuration();
  const displayWidth = await track.getDisplayWidth();
  const displayHeight = await track.getDisplayHeight();
  const rotation = await track.getRotation();
  const decoderConfig = await track.getDecoderConfig();
  if (!decoderConfig) throw new Error('Could not determine a decoder configuration for this track.');

  canvas.width = displayWidth;
  canvas.height = displayHeight;

  const bytesPerFrame = Math.max(1, displayWidth * displayHeight * 2);
  const maxCachedFrames = Math.max(8, Math.floor(FRAME_CACHE_BUDGET_BYTES / bytesPerFrame));

  const session: WebCodecsSession = {
    kind: 'webcodecs',
    packetSink: new EncodedPacketSink(track),
    decoder: new VideoDecoder({
      output: (frame) => {
        const sequenceNumber = session.pendingSequenceByTimestamp.get(frame.timestamp);
        if (sequenceNumber !== undefined) {
          cachePut(session, sequenceNumber, frame.clone());
        }

        session.latestFrame?.close();
        session.latestFrame = frame;
      },
      error: (error) => console.error(error),
    }),
    rotation,
    displayWidth,
    displayHeight,
    latestFrame: null,
    frameCache: new Map(),
    maxCachedFrames,
    pendingSequenceByTimestamp: new Map(),
  };
  await configureDecoder(session.decoder, decoderConfig);
  activeSession = session;

  loading.textContent = 'Ready';
  loading.hidden = true;
  updateFromProgress(getNativeProgress());
  void runDecodeLoop(session);
}

async function loadVideo(source: Blob | string) {
  loading.hidden = false;
  loading.textContent = 'Reading video…';

  teardownSession();

  if (preferHtmlVideoPlayback()) {
    await loadWithHtmlVideo(source);
    return;
  }

  try {
    await loadWithWebCodecs(source);
  } catch (error) {
    console.warn('WebCodecs playback failed; falling back to HTML video.', error);
    teardownSession();
    loading.hidden = false;
    await loadWithHtmlVideo(source);
  }
}

function timestampEpsilon() {
  return duration > 0 ? Math.max(duration / 10_000, 1 / 240) : 1 / 240;
}

async function seekHtmlVideo(session: HtmlVideoSession, timestamp: number) {
  const video = session.video;
  const clamped = Math.min(Math.max(0, timestamp), Math.max(0, duration - 0.001));
  const generation = ++session.seekGeneration;

  if (Math.abs(video.currentTime - clamped) < 0.001 && video.readyState >= 2) {
    return;
  }

  const seeked = waitForVideoEvent(video, 'seeked');
  video.currentTime = clamped;
  await seeked;

  if (generation !== session.seekGeneration) return;
}

// Decodes from the nearest key frame forward to `timestamp` on the session's
// persistent decoder, unless that exact frame is already in `frameCache` —
// in which case this is just a cache read, no decoder involved. On a miss,
// VideoDecoder.flush() requires the next decode() to be a key frame, so the
// walk always starts there; every frame produced along the way gets cached
// (see the decoder's `output` handler in loadVideo), so revisiting any point
// in this same stretch later is a hit.
async function decodeToTimestamp(session: WebCodecsSession, timestamp: number) {
  const targetPacket = await session.packetSink.getPacket(timestamp);
  if (!targetPacket) return;

  const cached = cacheGet(session, targetPacket.sequenceNumber);
  if (cached) {
    drawAndCloseFrame(session, cached.clone());
    return;
  }

  const keyPacket = await session.packetSink.getKeyPacket(timestamp);
  if (!keyPacket) return;

  session.pendingSequenceByTimestamp.clear();

  const keyChunk = keyPacket.toEncodedVideoChunk();
  session.pendingSequenceByTimestamp.set(keyChunk.timestamp, keyPacket.sequenceNumber);
  session.decoder.decode(keyChunk);
  let cursor = keyPacket;

  while (cursor.sequenceNumber < targetPacket.sequenceNumber) {
    const next = await session.packetSink.getNextPacket(cursor);
    if (!next) break;
    const chunk = next.toEncodedVideoChunk();
    session.pendingSequenceByTimestamp.set(chunk.timestamp, next.sequenceNumber);
    session.decoder.decode(chunk);
    cursor = next;
  }

  await session.decoder.flush();
  session.pendingSequenceByTimestamp.clear();

  if (session.latestFrame) {
    const frame = session.latestFrame;
    session.latestFrame = null;
    drawAndCloseFrame(session, frame);
  }
}

async function runDecodeLoop(session: DecodeSession) {
  while (activeSession === session) {
    const signalBefore = updateSignal;
    const timestamp = targetTimestamp;

    if (Math.abs(timestamp - decodedTimestamp) < timestampEpsilon()) {
      await waitForWake(signalBefore);
      continue;
    }

    try {
      if (session.kind === 'html') await seekHtmlVideo(session, timestamp);
      else await decodeToTimestamp(session, timestamp);
    } catch (error) {
      if (activeSession === session) console.error(error);
      break;
    }

    if (activeSession === session) decodedTimestamp = timestamp;
  }
}

function getNativeProgress() {
  const scrolling = document.scrollingElement ?? document.documentElement;
  const top = scrolling.scrollTop || window.scrollY || window.pageYOffset || 0;
  const max = scrolling.scrollHeight - window.innerHeight;
  return max > 0 ? Math.min(1, Math.max(0, top / max)) : 0;
}

function updateFromProgress(progress: number) {
  const clamped = Math.min(1, Math.max(0, progress));
  status.textContent = `${(clamped * duration).toFixed(2)}s · ${(clamped * 100).toFixed(1)}%`;
  if (duration <= 0 || !activeSession) return;

  targetTimestamp = clamped * duration;
  wake();
}

function onLenisScroll({ scroll, limit }: { scroll: number; limit: number }) {
  updateFromProgress(limit > 0 ? scroll / limit : 0);
}

function enableLenis() {
  if (lenis) return;

  lenis = new Lenis({
    autoRaf: false,
    lerp: 0.1,
    // Android Chrome needs Lenis to own touch, otherwise preventDefault on
    // wheel/touch can leave the page unable to scroll at all.
    syncTouch: true,
    touchMultiplier: 1,
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

window.addEventListener('touchend', () => {
  if (!lenis) updateFromProgress(getNativeProgress());
}, { passive: true });

function raf(time: number) {
  lenis?.raf(time);
  requestAnimationFrame(raf);
}
requestAnimationFrame(raf);

lenisToggle.checked = !isAndroid && !isCoarsePointer;
lenisToggle.addEventListener('change', () => {
  setLenisEnabled(lenisToggle.checked);
});

setLenisEnabled(lenisToggle.checked);

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  try {
    if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    sourceUrl = null;
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
  loading.textContent = error instanceof Error ? error.message : 'Demo video failed to load. Choose a video above.';
  console.error(error);
});
