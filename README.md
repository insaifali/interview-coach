# Interview Coach

AI-powered mock interview practice app. Generates role-specific interview
questions, records you answering them on webcam + mic, and scores your
performance in real time using face analysis, speech analysis, and
filler-word tracking — then gives you a results dashboard with per-question
feedback and coaching tips.

## Features

- **AI-generated questions** — role, experience level, interview type, and
  optional company/skills fed to a local Ollama model (`llama3.2`) to
  generate a tailored, plain-English question set with behavioural,
  situational, and technical questions.
- **Face analysis** — MediaPipe FaceMesh tracks landmarks live for smooth
  on-screen meters; DeepFace analyses captured frames every 5s for the
  actual confidence/anxiety/engagement/calmness scores that get recorded.
- **Speech analysis** — librosa extracts pace, energy, and expressiveness
  from the mic every 5s.
- **Live transcript + filler-word tracking** — the browser's
  SpeechRecognition API transcribes speech live and counts "like", "you
  know", "basically", "so"; Whisper (`tiny`) transcribes the same audio to
  catch "um"/"uh", which browser speech recognition strips out.
- **Per-question answers** — each question's spoken answer is captured and
  shown on the results dashboard.
- **Session dashboard** — overall + per-question scores, an emotion
  timeline chart, filler-word breakdown, coaching tips log, and a retake
  flow (same questions, or a freshly generated set).
- **Session history** — past sessions listed per user.
- **Auth** — email/password registration and login, sessions stored
  server-side via Flask-Session.

## Tech stack

- **Backend**: Flask, Flask-SQLAlchemy (MySQL), Flask-Session, Flask-CORS
- **Face**: MediaPipe FaceMesh (browser) + DeepFace (server)
- **Speech**: Web Speech API (browser) + OpenAI Whisper (server) + librosa
- **Questions**: Ollama (local LLM, `llama3.2`)
- **Frontend**: vanilla JS, Chart.js, HTML5, CSS3, JavaScript, WebRTC

## Prerequisites

- Python 3.10+
- MySQL server (reachable via the credentials in `.env`)
- [Ollama](https://ollama.com) running locally with the `llama3.2` model
  pulled (`ollama pull llama3.2`, then `ollama serve`)
- `ffmpeg` on `PATH` (used to convert recorded audio for librosa/Whisper)
- A Chromium-based browser (Chrome/Edge) — the live filler-word/transcript
  preview relies on `webkitSpeechRecognition`

## Setup

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Create a `.env` file in the project root:

```
SECRET_KEY=some-random-secret
DB_USERNAME=your-mysql-user
DB_PASSWORD=your-mysql-password
DB_HOST=localhost
DB_NAME=interview_coach
```

Create the database itself (tables are created automatically on startup):

```sql
CREATE DATABASE interview_coach;
```

In a separate terminal, make sure Ollama is running:

```bash
ollama serve
```

Then start the app:

```bash
python app.py
```

The app runs at `http://127.0.0.1:5000`.

## Project structure

```
app.py                  # Flask app, page routes, DB init
config.py               # Config from .env (DB URI, secret key, sessions)
models.py                User, InterviewSession, SessionQuestion,
                          EmotionEvent, CoachingTip
routes/
  auth.py               # /register, /login, /logout
  session.py            # session lifecycle, audio/face analysis,
                         # question generation, results API
static/
  css/style.css
  js/main.js             # interview page logic — recording, transcript,
                          # filler tracking, scoring, dashboard rendering
  js/face.js              # MediaPipe FaceMesh — live meter smoothing
templates/                index, register, setup, interview, dashboard,
                          history
tests/                    pytest suite (auth flow)
```

## Key API routes

| Route | Method | Purpose |
|---|---|---|
| `/register`, `/login`, `/logout` | POST | Auth |
| `/session/start` | POST | Create a session + its question set |
| `/session/audio` | POST | 5s audio chunk → pace/energy + Whisper transcript |
| `/session/analyse-face` | POST | Webcam frame → DeepFace emotion scores |
| `/session/emotion` | POST | Push a periodic combined score snapshot |
| `/session/answer` | POST | Save a question's transcribed answer |
| `/session/coaching-tip` | POST | Log a coaching nudge shown to the user |
| `/session/end` | POST | Finalize and score the session |
| `/api/generate-questions` | POST | Ollama-generated question set |
| `/api/session/<id>/results` | GET | Full results payload for the dashboard |
| `/api/sessions/history` | GET | Past sessions for the logged-in user |

## Testing

```bash
pytest
```
