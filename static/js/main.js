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
let timeLeft       = 120;
let timerInterval  = null;
let emotionInterval= null;
let recognition    = null;
let fillerCounts   = { um:0, uh:0, like:0, youknow:0, basically:0, so:0 };
let totalFillers   = 0;
let confHistory    = [];
let calmHistory    = [];
let questionsAnswered = 0;
let coachingTimeout= null;

const FILLERS = {
  'um'        : 'f-um',
  'uh'        : 'f-uh',
  'like'      : 'f-like',
  'you know'  : 'f-youknow',
  'basically' : 'f-basically',
  'so'        : 'f-so'
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
  if (currentQ < QUESTIONS.length - 1) {
    questionsAnswered++;
    loadQ(currentQ + 1);
  } else {
    endSession();
  }
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
    showCoaching('⚠️', 'Camera access denied. Please allow camera and refresh.');
  }
}

// ── Audio ──────────────────────────────────────────────
async function startAudio() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    // Audio stream ready — speech recognition uses it automatically
    console.log('✅ Audio stream ready');
  } catch (err) {
    console.error('Audio error:', err);
  }
}

// Called every frame by MediaPipe with real emotion scores
let latestFaceScores = { confidence: 50, anxiety: 50, engagement: 50 };

function onFaceResult(result) {
  if (!result.detected) {
    // No face found — show warning briefly
    document.getElementById('stat-conf').textContent = 'No face';
    return;
  }
  // Store latest scores — sendEmotion() picks them up every 3s
  latestFaceScores = result;

  // Update meters immediately every frame for smooth UI
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

  clearInterval(timerInterval);
  clearInterval(emotionInterval);
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
function sendEmotion() {
  if (!sessionId) return;

  // Real scores from MediaPipe face detection
  const faceScore    = latestFaceScores.confidence  ?? 50;
  const anxietyLevel = latestFaceScores.anxiety      ?? 50;
  const engagement   = latestFaceScores.engagement   ?? 50;
  const speechScore  = 100 - (totalFillers * 5);  // speech score from filler count

  confHistory.push(faceScore);
  calmHistory.push(100 - anxietyLevel);

  updateMeters(faceScore, speechScore, anxietyLevel, engagement);

  if (anxietyLevel > 72) {
    const tips = [
      'Take a slow breath — pausing shows confidence.',
      'Slow down slightly. Speaking clearly matters more than speed.',
      'Make eye contact with the camera — it builds rapport.',
      'Use the STAR method: Situation, Task, Action, Result.'
    ];
    showCoaching('💡', tips[Math.floor(Math.random() * tips.length)]);
  }

  fetch('http://127.0.0.1:5000/session/emotion', {
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
      overall_score: Math.round((faceScore * 0.5) + ((100 - anxietyLevel) * 0.3) + (speechScore * 0.2))
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
function showCoaching(emoji, text) {
  const box  = document.getElementById('coaching-inline');
  const span = document.getElementById('coaching-text');
  document.querySelector('.tip-emoji').textContent = emoji;
  span.textContent = text;
  box.classList.add('show');
  clearTimeout(coachingTimeout);
  coachingTimeout = setTimeout(() => box.classList.remove('show'), 6000);
}

// ── Speech recognition ──────────────────────────────────
function startSpeech() {
  if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
    document.getElementById('transcript').textContent =
      'Use Chrome for live speech transcription.';
    return;
  }

  const SR   = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.continuous    = true;
  recognition.interimResults = true;
  recognition.lang          = 'en-US';

  recognition.onresult = e => {
    let text = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      text += e.results[i][0].transcript;
    }
    renderTranscript(text);
  };

  recognition.onerror = () => {};
  recognition.onend   = () => { try { recognition.start(); } catch {} };
  recognition.start();
}

function renderTranscript(text) {
  // Reset counts
  Object.keys(fillerCounts).forEach(k => fillerCounts[k] = 0);
  totalFillers = 0;

  let html = text;

  Object.entries(FILLERS).forEach(([word, elId]) => {
    const re      = new RegExp(`\\b${word}\\b`, 'gi');
    const matches = (text.match(re) || []).length;
    const key     = Object.keys(fillerCounts)[Object.values(FILLERS).indexOf(elId)];
    fillerCounts[key] = matches;
    totalFillers += matches;
    document.getElementById(elId).textContent = matches;
    html = html.replace(re, `<span class="filler">${word}</span>`);
  });

  document.getElementById('transcript').innerHTML  = html || '<span style="color:#3a3d4e;">Listening...</span>';
  document.getElementById('stat-fillers').textContent  = totalFillers;
  document.getElementById('total-fillers').textContent = totalFillers;
}