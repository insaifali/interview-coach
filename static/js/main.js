// ── Questions ───────────────────────────────────────────
// Load AI-generated questions from setup page
const storedQ   = localStorage.getItem('interview_questions');
const QUESTIONS = storedQ ? JSON.parse(storedQ) : [
  "Tell me about yourself and your background.",
  "What is your greatest strength?",
  "Describe a challenge you overcame.",
  "Where do you see yourself in 5 years?",
  "Why do you want this role?"
];
const ROLE = localStorage.getItem('interview_role') || 'General';

// ── State ───────────────────────────────────────────────
let currentQ       = 0;
let sessionId      = null;
let questionAnswerStart = 0; // index into fullTranscript where the current question's answer begins
let timeLeft       = 120;
let timerInterval  = null;
let emotionInterval= null;
let recognition    = null;
// True only once SpeechRecognition has proven it can actually deliver
// results — NOT just that `new SR()` didn't throw. Constructing the object
// succeeds even when the mic is unavailable to it (e.g. already held
// exclusively by our own getUserMedia() stream for MediaRecorder); the
// failure only shows up later via onerror. Whisper's transcript is the
// fallback source for as long as this is false.
let recognitionUsable = false;
let fillerCounts   = { um:0, uh:0, like:0, youknow:0, basically:0, so:0 };
let totalFillers   = 0;
let confHistory    = [];
let calmHistory    = [];
let questionsAnswered = 0;
let coachingTimeout= null;

// 'um'/'uh' are deliberately absent — Chrome's Web Speech API strips
// disfluencies from its transcript, so they'd never match here no matter
// what. They're tracked separately from Whisper's transcript instead
// (see updateUmUhFromWhisper), which does preserve them.
const FILLERS = {
  'like'      : 'f-like',
  'you know'  : 'f-youknow',
  'basically' : 'f-basically',
  'so'        : 'f-so'
};

// Hedging language — live-tracked the same way as filler words. Passive
// voice and incomplete sentences are harder to detect incrementally on a
// growing transcript, so those are computed server-side from the final
// answer text instead (see language_analysis.py).
let hedgingCounts = { ithink:0, iguess:0, maybe:0, sortof:0, kindof:0, probably:0 };
let totalHedging  = 0;
const HEDGING = {
  'i think'   : 'h-ithink',
  'i guess'   : 'h-iguess',
  'maybe'     : 'h-maybe',
  'sort of'   : 'h-sortof',
  'kind of'   : 'h-kindof',
  'probably'  : 'h-probably'
};

// ── Boot ────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  const name = localStorage.getItem('user_name') || 'Student';
  document.getElementById('user-name').textContent = name;
  document.getElementById('avatar-initials').textContent =
    name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2);

  // Show role badge if available
  const roleBadge = document.getElementById('role-badge');
  if (roleBadge && ROLE) roleBadge.textContent = '📋 ' + ROLE;

  buildDots();
  loadQ(0);
  await startWebcam();
  await startAudio();
  await startSession();
  startSpeech();
  emotionInterval = setInterval(sendEmotion, 3000);
  startDeepFaceAnalysis();
});

// ── Question dots ───────────────────────────────────────
function buildDots() {
  const wrap = document.getElementById('q-dots');
  wrap.innerHTML = '';
  QUESTIONS.forEach((_, i) => {
    const d = document.createElement('div');
    d.className = 'q-dot' + (i === 0 ? ' active' : '');
    d.id = 'dot-' + i;
    wrap.appendChild(d);
  });
  document.getElementById('q-total').textContent = QUESTIONS.length;
}

function loadQ(index) {
  currentQ = index;
  document.getElementById('q-text').textContent = QUESTIONS[index];
  document.getElementById('q-num').textContent  = index + 1;
  document.getElementById('q-done').textContent =
    `${Math.min(index, QUESTIONS.length)} / ${QUESTIONS.length}`;

  // Update dots
  QUESTIONS.forEach((_, i) => {
    const d = document.getElementById('dot-' + i);
    d.className = 'q-dot' +
      (i < index ? ' completed' : i === index ? ' active' : '');
  });

  resetTimer();
}

function nextQ() {
  saveCurrentAnswer();
  if (currentQ < QUESTIONS.length - 1) {
    questionsAnswered++;
    loadQ(currentQ + 1);
  } else {
    endSession();
  }
}

// Everything spoken since the last question boundary is this question's answer
function saveCurrentAnswer() {
  const answer = fullTranscript.slice(questionAnswerStart).trim();
  questionAnswerStart = fullTranscript.length;

  if (!answer || !sessionId) return;

  fetch('http://127.0.0.1:5000/session/answer', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      session_id:   sessionId,
      question_num: currentQ + 1,
      answer_text:  answer
    })
  }).catch(() => {});
}

function prevQ() {
  if (currentQ > 0) loadQ(currentQ - 1);
}

// ── Timer ───────────────────────────────────────────────
function resetTimer() {
  clearInterval(timerInterval);
  timeLeft = 120;
  renderTimer();
  timerInterval = setInterval(() => {
    timeLeft--;
    renderTimer();
    if (timeLeft <= 0) { clearInterval(timerInterval); nextQ(); }
  }, 1000);
}

function renderTimer() {
  const m = Math.floor(timeLeft / 60);
  const s = timeLeft % 60;
  const el = document.getElementById('timer');
  el.textContent = `${m}:${s.toString().padStart(2,'0')}`;
  el.className = 'timer-val' +
    (timeLeft <= 10 ? ' danger' : timeLeft <= 30 ? ' warn' : '');
}

// ── Webcam ──────────────────────────────────────────────
async function startWebcam() {
  try {
    const vid = document.getElementById('webcam');

    // Let MediaPipe's Camera utility handle the stream entirely
    // Do NOT call getUserMedia separately — it conflicts with MediaPipe
    vid.addEventListener('loadeddata', () => {
      const canvas  = document.getElementById('face-canvas');
      canvas.width  = vid.videoWidth  || 640;
      canvas.height = vid.videoHeight || 480;
    });

    const canvas = document.getElementById('face-canvas');
    await initFaceDetection(vid, canvas, onFaceResult);

  } catch (err) {
    console.error('Webcam error:', err);
    showCoaching('⚠️', 'Camera access denied. Please allow camera and refresh.', 'camera_error', { skipUpgrade: true });
  }
}

// ── Audio ──────────────────────────────────────────────
let audioAnalysisInterval = null;
let latestSpeechScores    = { speech_score: 50, pace: 'normal', energy: 50 };

async function startAudio() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    console.log('✅ Audio stream ready');

    const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    let   audioChunks   = [];

    mediaRecorder.ondataavailable = e => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      if (!audioChunks.length) return;

      const blob   = new Blob(audioChunks, { type: 'audio/webm' });
      audioChunks  = [];

      // Convert to base64 and send to Flask/librosa
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64 = reader.result.split(',')[1];
        try {
          const res  = await fetch('http://127.0.0.1:5000/session/audio', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ audio: base64, session_id: sessionId })
          });
          const data = await res.json();
          latestSpeechScores = data;

          // Update pace indicator in UI
          const paceEl = document.getElementById('stat-pace');
          if (paceEl) {
            paceEl.textContent = data.pace || 'normal';
            paceEl.style.color = data.pace === 'fast' ? '#ff9800'
                               : data.pace === 'slow' ? '#ff4444' : '#4caf50';
          }

          if (data.transcript) {
            if (recognitionUsable) {
              // Browser SpeechRecognition owns fullTranscript (it's instant);
              // Whisper's transcript is only consulted for um/uh, which the
              // browser API strips out entirely.
              updateUmUhFromWhisper(data.transcript);
            } else {
              // Browser STT unavailable/unproven — Whisper is the transcript source.
              fullTranscript += data.transcript.trim() + ' ';
              renderTranscript(fullTranscript);
              updateUmUhFromWhisper(data.transcript);
            }
          }
        } catch { /* silent fail — speech analysis is supplementary */ }
      };
      reader.readAsDataURL(blob);

      // Restart recording
      if (mediaRecorder.state === 'inactive') mediaRecorder.start();
    };

    // Record in 5-second chunks
    mediaRecorder.start();
    audioAnalysisInterval = setInterval(() => {
      if (mediaRecorder.state === 'recording') mediaRecorder.stop();
    }, 5000);

  } catch (err) {
    console.error('Audio error:', err);
  }
}

// ── DeepFace Analysis ────────────────────────────────────
let deepfaceInterval   = null;
let latestDeepFace     = null;

function startDeepFaceAnalysis() {
  // Capture a frame every 5 seconds and send to DeepFace
  deepfaceInterval = setInterval(captureAndAnalyse, 5000);
  // Run immediately on start
  setTimeout(captureAndAnalyse, 2000);
}

async function captureAndAnalyse() {
  const video = document.getElementById('webcam');
  if (!video || video.readyState < 2) return;

  try {
    // Draw current video frame to a temp canvas
    const canvas  = document.createElement('canvas');
    canvas.width  = 320;  // smaller = faster analysis
    canvas.height = 240;
    const ctx     = canvas.getContext('2d');

    // Mirror to match what user sees
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Convert to base64 JPEG
    const base64 = canvas.toDataURL('image/jpeg', 0.8);

    const res  = await fetch('http://127.0.0.1:5000/session/analyse-face', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ image: base64, session_id: sessionId })
    });

    const data = await res.json();

    if (data.detected) {
      latestDeepFace = data;

      // Override MediaPipe scores with DeepFace scores
      latestFaceScores = {
        confidence: data.confidence,
        anxiety:    data.anxiety,
        engagement: data.engagement,
        calmness:   data.calmness
      };

      // Show dominant emotion in UI
      updateDominantEmotion(data.dominant, data.emotions);

      console.log('DeepFace:', data.dominant, data.emotions);
    } else if (data.error) {
      // Backend hit an exception and fell back to neutral 50s — surface it
      // instead of silently sitting on stale defaults for the whole session.
      console.warn('DeepFace did not detect a face:', data.error);
    }

  } catch (err) {
    console.warn('DeepFace analysis failed:', err);
  }
}

function updateDominantEmotion(dominant, emotions) {
  const el = document.getElementById('dominant-emotion');
  if (!el) return;

  const labels = {
    happy:    { emoji: '😊', label: 'Happy',    color: '#4caf50' },
    neutral:  { emoji: '😐', label: 'Neutral',  color: '#8b8fa8' },
    sad:      { emoji: '😢', label: 'Sad',      color: '#6c63ff' },
    angry:    { emoji: '😠', label: 'Angry',    color: '#ff4444' },
    fear:     { emoji: '😰', label: 'Anxious',  color: '#ff9800' },
    surprise: { emoji: '😲', label: 'Surprised',color: '#a78bfa' },
    disgust:  { emoji: '😒', label: 'Tense',    color: '#ff6b6b' }
  };

  const meta      = labels[dominant] || labels['neutral'];
  el.textContent  = `${meta.emoji} ${meta.label}`;
  el.style.color  = meta.color;
}

// Called every frame by MediaPipe with real emotion scores
let latestFaceScores = { confidence: 50, anxiety: 50, engagement: 50 };

function onFaceResult(result) {
  if (!result.detected) {
    // No face found — show warning briefly
    document.getElementById('stat-conf').textContent = 'No face';
    return;
  }
  // DeepFace (captureAndAnalyse, every 5s) is the authoritative score sent
  // to the backend via latestFaceScores — this geometric MediaPipe result
  // is display-only, so it never overwrites that. Runs every frame purely
  // to keep the meters moving smoothly between DeepFace refreshes.
  updateMeters(
    result.confidence,
    result.calmness,
    result.anxiety,
    result.engagement
  );
}

// ── Session ─────────────────────────────────────────────
async function startSession() {
  try {
    const r    = await fetch('http://127.0.0.1:5000/session/start', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      credentials:'include',
      body:JSON.stringify({
        questions:      QUESTIONS,
        job_role:       localStorage.getItem('interview_role')      || '',
        company:        localStorage.getItem('interview_company')   || '',
        experience:     localStorage.getItem('interview_exp')       || '',
        interview_type: localStorage.getItem('interview_type')      || '',
        skills:         localStorage.getItem('interview_skills')    || ''
      })
    });
    const data = await r.json();
    sessionId  = data.session_id;
    console.log('✅ Session started:', sessionId);
  } catch { console.error('Session start failed'); }
}

async function endSession() {
  if (!confirm('End this session and go to dashboard?')) return;

  saveCurrentAnswer(); // no-op if nextQ() already flushed this question

  clearInterval(timerInterval);
  clearInterval(emotionInterval);
  clearInterval(audioAnalysisInterval);
  clearInterval(deepfaceInterval);
  if (recognition) recognition.stop();

  try {
    await fetch('http://127.0.0.1:5000/session/end', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      credentials:'include',
      body:JSON.stringify({ session_id: sessionId, overall_score: calcOverallScore() })
    });
  } catch { console.error('Session end failed'); }

  localStorage.setItem('last_session_id', sessionId);
  window.location.href = '/dashboard';
}

function calcOverallScore() {
  if (!confHistory.length) return 50;
  const avg = confHistory.reduce((a,b) => a+b, 0) / confHistory.length;
  return Math.round(avg);
}

// ── Emotion data ────────────────────────────────────────
let lastAnxietyTipAt = 0;

function sendEmotion() {
  if (!sessionId) return;

  const faceScore    = latestFaceScores.confidence ?? 50;
  const anxietyLevel = latestFaceScores.anxiety     ?? 50;
  const engagement   = latestFaceScores.engagement  ?? 50;
  // If the backend explicitly told us nothing was said, don't let a stale
  // "50" flatter the score — treat it as zero speech contribution.
  const spoke        = latestSpeechScores.spoke !== false;
  const speechScore  = spoke ? (latestSpeechScores.speech_score ?? 50) : 0;

  confHistory.push(faceScore);
  calmHistory.push(100 - anxietyLevel);

  updateMeters(faceScore, speechScore, anxietyLevel, engagement);

  // High-anxiety nudge — 15s cooldown so it doesn't spam every 3s once triggered
  const now = Date.now();
  if (anxietyLevel > 60 && now - lastAnxietyTipAt > 15000) {
    lastAnxietyTipAt = now;
    const tips = [
      'Take a slow breath — pausing shows confidence.',
      'Slow down slightly. Speaking clearly matters more than speed.',
      'Make eye contact with the camera — it builds rapport.',
      'Use the STAR method: Situation, Task, Action, Result.'
    ];
    showCoaching('💡', tips[Math.floor(Math.random() * tips.length)], 'high_anxiety', {
      context: { anxiety_level: anxietyLevel, face_score: faceScore, question: QUESTIONS[currentQ] }
    });
  }

  fetch('/session/emotion', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    credentials:'include',
    body: JSON.stringify({
      session_id:    sessionId,
      question_num:  currentQ + 1,
      face_score:    faceScore,
      speech_score:  speechScore,
      filler_count:  totalFillers,
      anxiety_level: anxietyLevel,
      engagement:    engagement,
      overall_score: Math.round(
        (faceScore * 0.30) + ((100 - anxietyLevel) * 0.20) +
        (speechScore * 0.30) + ((100 - Math.min(totalFillers * 5, 100)) * 0.20)
      )
    })
  }).catch(() => {});
}

function updateMeters(conf, speech, anx, eng) {
  const c = Math.round(conf);
  const a = Math.round(anx);
  const ca= Math.round(100 - anx);
  const e = Math.round(eng);

  set('m-conf',    c + '%', c + '%');
  set('m-calm',    ca + '%', ca + '%');
  set('m-anx',     a + '%', a + '%');
  set('m-eng',     e + '%', e + '%');

  document.getElementById('stat-conf').textContent = c + '%';

  // Update running averages
  const avgC = Math.round(confHistory.reduce((a,b)=>a+b,0)/confHistory.length);
  const avgCa= Math.round(calmHistory.reduce((a,b)=>a+b,0)/calmHistory.length);
  document.getElementById('avg-conf').textContent = avgC + '%';
  document.getElementById('avg-calm').textContent = avgCa + '%';
}

function set(id, width, label) {
  document.getElementById(id).style.width = width;
  document.getElementById(id + '-val').textContent = label;
}

// ── Coaching overlay ────────────────────────────────────
let coachingGen = 0; // guards a late Ollama tip from overwriting a newer, already-superseded one

// `opts.context` (optional) feeds live state to Ollama for a personalised
// upgrade of this tip; `opts.skipUpgrade` skips that call entirely (used
// for tips unrelated to emotional state, e.g. camera errors).
function showCoaching(emoji, text, trigger = 'general', opts = {}) {
  // Show static/rule-based tip immediately — instant feedback, no waiting on Ollama
  const box  = document.getElementById('coaching-inline');
  const span = document.getElementById('coaching-text');
  document.querySelector('.tip-emoji').textContent = emoji;
  span.textContent = text;
  box.classList.add('show');
  clearTimeout(coachingTimeout);
  coachingTimeout = setTimeout(() => box.classList.remove('show'), 6000);

  const myGen = ++coachingGen;

  // Save to DB
  if (sessionId) {
    fetch('http://127.0.0.1:5000/session/coaching-tip', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        session_id:   sessionId,
        question_num: currentQ + 1,
        trigger:      trigger,
        tip_text:     text
      })
    }).catch(() => {});
  }

  // Try to upgrade to a personalised tip from Ollama while this one is
  // still on screen — silently does nothing if Ollama is slow/unavailable,
  // or if a newer tip has already taken over.
  if (!opts.skipUpgrade) {
    requestDynamicTip(trigger, opts.context || {}).then(tip => {
      if (!tip || myGen !== coachingGen) return;
      span.textContent = tip;
    });
  }
}

async function requestDynamicTip(trigger, context) {
  try {
    const res = await fetch('http://127.0.0.1:5000/api/coaching-tip/generate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger, ...context })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.tip || null;
  } catch {
    return null;
  }
}

// ── Speech recognition ──────────────────────────────────
let fullTranscript = ''; // accumulates FINAL speech for the whole session — survives restarts
let lastFillerTipCount = 0;

function startSpeech() {
  // Browser SpeechRecognition owns fullTranscript when it works — instant,
  // no server round-trip. Whisper (see mediaRecorder.onstop) is the
  // fallback transcript source for as long as recognitionUsable is false,
  // and always the source for um/uh regardless (the browser API strips those).
  if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) return;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.continuous     = true;
  recognition.interimResults = true;
  recognition.lang           = 'en-US';

  recognition.onresult = e => {
    recognitionUsable = true; // a result only ever fires if it's actually working

    let interim = '';

    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        fullTranscript += e.results[i][0].transcript + ' ';
      } else {
        interim += e.results[i][0].transcript;
      }
    }

    renderTranscript(fullTranscript + interim);
  };

  let sttFailNotified = false;
  recognition.onerror = e => {
    console.warn('SpeechRecognition error:', e.error);
    // 'no-speech' fires constantly during normal pauses — not a real failure.
    if (e.error === 'not-allowed' || e.error === 'audio-capture') {
      recognitionUsable = false; // fall back to Whisper for the transcript
      if (!sttFailNotified) {
        sttFailNotified = true;
        showCoaching('⚠️', 'Live transcript is using periodic transcription — instant browser transcription isn\'t available right now.', 'speech_error', { skipUpgrade: true });
      }
    }
  };
  recognition.onend = () => {
    try { recognition.start(); } catch (err) { console.warn('SpeechRecognition restart failed:', err); }
  };
  recognition.start();
}

function renderTranscript(text) {
  let html = text;

  Object.entries(FILLERS).forEach(([word, elId]) => {
    const re      = new RegExp(`\\b${word}\\b`, 'gi');
    const matches = (text.match(re) || []).length;
    const key     = elId.slice(2); // 'f-like' -> 'like', 'f-youknow' -> 'youknow', etc.
    fillerCounts[key] = matches;
    document.getElementById(elId).textContent = matches;
    html = html.replace(re, `<span class="filler">${word}</span>`);
  });

  Object.entries(HEDGING).forEach(([phrase, elId]) => {
    const re      = new RegExp(`\\b${phrase}\\b`, 'gi');
    const matches = (text.match(re) || []).length;
    const key     = elId.slice(2); // 'h-ithink' -> 'ithink', etc.
    hedgingCounts[key] = matches;
    const el = document.getElementById(elId);
    if (el) el.textContent = matches;
    html = html.replace(re, `<span class="hedge">${phrase}</span>`);
  });

  document.getElementById('transcript').innerHTML  = html || '<span style="color:#3a3d4e;">Listening...</span>';
  recomputeTotalFillers();
  recomputeTotalHedging();
}

// um/uh never appear in the browser's transcript (Web Speech API strips
// disfluencies), so they're counted from Whisper's transcript of the same
// audio instead — additive per 5s chunk since Whisper chunks don't overlap.
function updateUmUhFromWhisper(chunkText) {
  if (!chunkText) return;

  fillerCounts.um += (chunkText.match(/\bum\b/gi) || []).length;
  fillerCounts.uh += (chunkText.match(/\buh\b/gi) || []).length;
  document.getElementById('f-um').textContent = fillerCounts.um;
  document.getElementById('f-uh').textContent = fillerCounts.uh;
  recomputeTotalFillers();
}

function recomputeTotalFillers() {
  totalFillers = Object.values(fillerCounts).reduce((a, b) => a + b, 0);
  document.getElementById('stat-fillers').textContent  = totalFillers;
  document.getElementById('total-fillers').textContent = totalFillers;

  // Fire a coaching nudge every time fillers climb by 3+ since the last one
  if (totalFillers - lastFillerTipCount >= 3) {
    lastFillerTipCount = totalFillers;
    showCoaching('🗣️', 'Try pausing instead of saying "um" or "like" — a brief silence reads as confidence.', 'filler_words', {
      context: { filler_count: totalFillers, question: QUESTIONS[currentQ] }
    });
  }
}

function recomputeTotalHedging() {
  totalHedging = Object.values(hedgingCounts).reduce((a, b) => a + b, 0);
  const el = document.getElementById('stat-hedging');
  if (el) el.textContent = totalHedging;
}