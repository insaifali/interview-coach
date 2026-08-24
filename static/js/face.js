// ============================================================
//  face.js  —  MediaPipe Face Mesh emotion analysis
//  Recalibrated thresholds for realistic scoring
// ============================================================

let faceMesh      = null;
let showDots      = true;
let smoothedScores = { confidence: 50, anxiety: 50, engagement: 50, calmness: 50 };
const SMOOTH      = 0.15; // smoothing factor (lower = smoother but slower)

async function initFaceDetection(videoEl, canvasEl, onResult) {
  const ctx = canvasEl.getContext('2d');

  faceMesh = new FaceMesh({
    locateFile: file =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
  });

  faceMesh.setOptions({
    maxNumFaces:            1,
    refineLandmarks:        true,
    minDetectionConfidence: 0.6,
    minTrackingConfidence:  0.6
  });

  faceMesh.onResults(results => {
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);

    if (!results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
      onResult({ detected: false });
      return;
    }

    const lm = results.multiFaceLandmarks[0];

    if (showDots) drawOverlay(ctx, lm, canvasEl.width, canvasEl.height);

    const raw     = calculateEmotionScores(lm);
    const smoothed = smoothScores(raw);
    onResult({ ...smoothed, detected: true });
  });

  const camera = new Camera(videoEl, {
    onFrame: async () => {
      if (canvasEl.width  !== videoEl.videoWidth ||
          canvasEl.height !== videoEl.videoHeight) {
        canvasEl.width  = videoEl.videoWidth  || 640;
        canvasEl.height = videoEl.videoHeight || 480;
      }
      await faceMesh.send({ image: videoEl });
    },
    width: 640, height: 480
  });

  await camera.start();
  console.log('✅ MediaPipe Face Mesh running');
}

// ── Smoothing (prevents jumpy values) ───────────────────────
function smoothScores(raw) {
  smoothedScores.confidence = lerp(smoothedScores.confidence, raw.confidence, SMOOTH);
  smoothedScores.anxiety    = lerp(smoothedScores.anxiety,    raw.anxiety,    SMOOTH);
  smoothedScores.engagement = lerp(smoothedScores.engagement, raw.engagement, SMOOTH);
  smoothedScores.calmness   = lerp(smoothedScores.calmness,   raw.calmness,   SMOOTH);
  return {
    confidence: Math.round(smoothedScores.confidence),
    anxiety:    Math.round(smoothedScores.anxiety),
    engagement: Math.round(smoothedScores.engagement),
    calmness:   Math.round(smoothedScores.calmness)
  };
}

function lerp(a, b, t) { return a + (b - a) * t; }

// ── Realistic emotion score calculator ──────────────────────
function calculateEmotionScores(lm) {

  // 1. Brow raise — tighter range for realistic anxiety
  const browRaise = avg([getBrowRaise(lm,'left'), getBrowRaise(lm,'right')]);

  // 2. Eye openness — recalibrated baseline
  const eyeOpen   = avg([getEyeOpenness(lm,'left'), getEyeOpenness(lm,'right')]);

  // 3. Mouth tension
  const mouthTension = getMouthTension(lm);

  // 4. Head pose
  const headStraight = getHeadStraightness(lm);

  // 5. Blink rate proxy — very closed eyes = nervous
  const eyesClosed = clamp(1 - eyeOpen * 1.8);

  // ── Confidence: needs BOTH open eyes AND straight head AND relaxed brow
  // Much harder to score high — all factors must be good simultaneously
  const confidence = clamp(
    (eyeOpen      * 0.40) +
    (headStraight * 0.30) +
    ((1 - browRaise)  * 0.20) +
    ((1 - mouthTension) * 0.10)
  ) * 100;

  // ── Anxiety: any ONE bad signal pushes score up
  const anxiety = clamp(
    (browRaise    * 0.40) +
    (mouthTension * 0.30) +
    (eyesClosed   * 0.20) +
    ((1 - headStraight) * 0.10)
  ) * 100;

  // ── Engagement: head straight + eyes open
  const engagement = clamp(
    (headStraight * 0.55) +
    (eyeOpen      * 0.45)
  ) * 100;

  return {
    confidence:  Math.round(confidence),
    anxiety:     Math.round(anxiety),
    engagement:  Math.round(engagement),
    calmness:    Math.round(clamp(1 - (anxiety / 100)) * 100)
  };
}

// ── Feature extractors (recalibrated ranges) ────────────────
function getBrowRaise(lm, side) {
  const browIdx = side === 'left' ? [70, 63] : [300, 293];
  const eyeIdx  = side === 'left' ? 159      : 386;
  const browY   = avg(browIdx.map(i => lm[i].y));
  const eyeY    = lm[eyeIdx].y;
  const gap     = eyeY - browY;
  // Tighter range: 0.03 (relaxed) to 0.07 (raised)
  return clamp((gap - 0.03) / 0.04);
}

function getEyeOpenness(lm, side) {
  const top = side === 'left' ? 159 : 386;
  const bot = side === 'left' ? 145 : 374;
  const h   = Math.abs(lm[top].y - lm[bot].y);
  // Tighter range: 0.005 (closed) to 0.018 (open)
  // Most people at rest score ~0.50, not 0.90
  return clamp((h - 0.005) / 0.013);
}

function getMouthTension(lm) {
  const gap = Math.abs(lm[13].y - lm[14].y);
  // Tighter: 0.003 (very compressed) to 0.015 (neutral)
  return clamp(1 - (gap - 0.003) / 0.012);
}

function getHeadStraightness(lm) {
  const xDiff = Math.abs(lm[1].x - lm[152].x);
  // Any deviation > 0.04 = not straight
  return clamp(1 - xDiff / 0.04);
}

// ── Canvas overlay ───────────────────────────────────────────
function drawOverlay(ctx, lm, w, h) {
  // Eye outlines only — clean and minimal
  drawEyeOutline(ctx, lm, w, h, 'left');
  drawEyeOutline(ctx, lm, w, h, 'right');
  drawBrowLine(ctx, lm, w, h, 'left');
  drawBrowLine(ctx, lm, w, h, 'right');
  drawMouthOutline(ctx, lm, w, h);

  // Key point dots — very subtle
  const pts = [1, 152, 234, 454];
  ctx.fillStyle = 'rgba(108,99,255,0.5)';
  pts.forEach(i => {
    const p = lm[i];
    ctx.beginPath();
    ctx.arc((1 - p.x) * w, p.y * h, 2, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawEyeOutline(ctx, lm, w, h, side) {
  const idx = side === 'left'
    ? [33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246]
    : [362,382,381,380,374,373,390,249,263,466,388,387,386,385,384,398];
  ctx.strokeStyle = 'rgba(108,99,255,0.6)';
  ctx.lineWidth   = 1.2;
  ctx.beginPath();
  idx.forEach((i, n) => {
    const p = lm[i];
    n === 0
      ? ctx.moveTo((1-p.x)*w, p.y*h)
      : ctx.lineTo((1-p.x)*w, p.y*h);
  });
  ctx.closePath();
  ctx.stroke();
}

function drawBrowLine(ctx, lm, w, h, side) {
  const idx = side === 'left'
    ? [70, 63, 105, 66, 107]
    : [300, 293, 334, 296, 336];
  ctx.strokeStyle = 'rgba(167,139,250,0.5)';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  idx.forEach((i, n) => {
    const p = lm[i];
    n === 0
      ? ctx.moveTo((1-p.x)*w, p.y*h)
      : ctx.lineTo((1-p.x)*w, p.y*h);
  });
  ctx.stroke();
}

function drawMouthOutline(ctx, lm, w, h) {
  const idx = [61,185,40,39,37,0,267,269,270,409,291,375,321,405,314,17,84,181,91,146];
  ctx.strokeStyle = 'rgba(108,99,255,0.4)';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  idx.forEach((i, n) => {
    const p = lm[i];
    n === 0
      ? ctx.moveTo((1-p.x)*w, p.y*h)
      : ctx.lineTo((1-p.x)*w, p.y*h);
  });
  ctx.closePath();
  ctx.stroke();
}

function toggleDots() {
  showDots = !showDots;
  const btn = document.getElementById('dots-toggle');
  if (btn) btn.textContent = showDots ? '👁 Hide Overlay' : '👁 Show Overlay';
}

function clamp(v, mn=0, mx=1) { return Math.max(mn, Math.min(mx, v)); }
function avg(arr) { return arr.reduce((a,b) => a+b, 0) / arr.length; }