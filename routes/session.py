import requests
import json
from flask import Blueprint, request, jsonify, session
from models import db, InterviewSession, EmotionEvent
from datetime import datetime

session_bp = Blueprint('session', __name__)

_whisper_model = None
def get_whisper_model():
    """Load Whisper once and cache it — reloading per-request costs ~2-3s each time.
    'tiny' over 'base' — every audio chunk now runs through this (needed to
    catch um/uh, which the browser's own transcript strips out), so the
    per-chunk latency matters more than raw accuracy here."""
    global _whisper_model
    if _whisper_model is None:
        import whisper
        _whisper_model = whisper.load_model('tiny')
    return _whisper_model

@session_bp.route('/session/start', methods=['POST'])
def start_session():
    from models import InterviewSession, SessionQuestion

    user_id = session.get('user_id')
    if not user_id:
        return jsonify({'error': 'Not logged in'}), 401

    data = request.get_json()

    # Create session with metadata from setup page
    new_session = InterviewSession(
        user_id        = user_id,
        job_role       = data.get('job_role'),
        company        = data.get('company'),
        experience     = data.get('experience'),
        interview_type = data.get('interview_type'),
        skills         = data.get('skills')
    )
    db.session.add(new_session)
    db.session.flush()  # get the new session id before committing

    # Save each question to the DB
    questions = data.get('questions', [])
    for i, q_text in enumerate(questions):
        q = SessionQuestion(
            session_id   = new_session.id,
            question_num = i + 1,
            question     = q_text
        )
        db.session.add(q)

    db.session.commit()

    return jsonify({
        'message':    'Session started',
        'session_id': new_session.id
    }), 201


@session_bp.route('/session/end', methods=['POST'])
def end_session():
    from models import InterviewSession, EmotionEvent, SessionQuestion
    import sqlalchemy as sa

    data       = request.get_json()
    session_id = data.get('session_id')

    interview_session = InterviewSession.query.get(session_id)
    if not interview_session:
        return jsonify({'error': 'Session not found'}), 404

    # Calculate aggregate scores from all emotion events
    events = EmotionEvent.query.filter_by(session_id=session_id).all()

    if events:
        avg_conf   = sum(e.face_score    or 0 for e in events) / len(events)
        avg_calm   = sum(100 - (e.anxiety_level or 0) for e in events) / len(events)
        avg_speech = sum(e.speech_score  or 0 for e in events) / len(events)
        # Use last event's filler_count — it's a running total of the full transcript
        max_fill   = events[-1].filler_count or 0
    else:
        avg_conf   = data.get('overall_score', 50)
        avg_calm   = 50
        avg_speech = 0
        max_fill   = 0

    filler_penalty = 100 - min(max_fill * 5, 100)

    # Multimodal blend: face 30% + calmness 20% + speech quality 30% + fluency 20%
    overall = (avg_conf * 0.30) + (avg_calm * 0.20) + (avg_speech * 0.30) + (filler_penalty * 0.20)

    # Hard guard: a calm, present face is not proof of a real answer — sitting
    # silently in front of the webcam can still score well on face_score alone.
    # Ground truth is actual spoken words captured per question.
    total_words = sum(
        len((q.answer_text or '').split())
        for q in SessionQuestion.query.filter_by(session_id=session_id).all()
    )
    if total_words == 0:
        overall = min(overall, 10)
    elif avg_speech < 20 and max_fill == 0:
        overall = min(overall, 30)

    interview_session.ended_at      = datetime.utcnow()
    interview_session.overall_score = round(overall, 1)
    interview_session.avg_confidence= round(avg_conf, 1)
    interview_session.avg_calmness  = round(avg_calm, 1)
    interview_session.total_fillers = max_fill

    db.session.commit()

    return jsonify({
        'message':       'Session ended',
        'session_id':    session_id,
        'overall_score': round(overall, 1)
    }), 200


@session_bp.route('/session/emotion', methods=['POST'])
def save_emotion():
    from models import EmotionEvent

    data = request.get_json()

    event = EmotionEvent(
        session_id    = data.get('session_id'),
        question_num  = data.get('question_num'),
        face_score    = data.get('face_score'),
        anxiety_level = data.get('anxiety_level'),
        engagement    = data.get('engagement'),
        speech_score  = data.get('speech_score'),
        filler_count  = data.get('filler_count', 0),
        overall_score = data.get('overall_score')
    )
    db.session.add(event)
    db.session.commit()

    return jsonify({'message': 'Emotion event saved'}), 201


@session_bp.route('/session/answer', methods=['POST'])
def save_answer():
    from models import SessionQuestion

    data          = request.get_json()
    session_id    = data.get('session_id')
    question_num  = data.get('question_num')
    answer_text   = data.get('answer_text', '')

    q = SessionQuestion.query.filter_by(
        session_id=session_id, question_num=question_num
    ).first()

    if not q:
        return jsonify({'error': 'Question not found'}), 404

    q.answer_text = answer_text
    q.answered    = True
    db.session.commit()

    return jsonify({'message': 'Answer saved'}), 200


@session_bp.route('/api/generate-questions', methods=['POST'])
def generate_questions():
    data     = request.get_json()
    role     = data.get('role', 'Software Engineer')
    company  = data.get('company', '')
    skills   = data.get('skills', '')
    exp      = data.get('experience', 'Fresher')
    itype    = data.get('type', 'General HR')
    count    = data.get('count', 7)

    company_line = f"The company/industry is: {company}." if company else ""
    skills_line  = f"Focus on these skills: {skills}." if skills else ""

    prompt = f"""You are an expert interview coach. Generate exactly {count} interview questions for the following:

Role: {role}
Experience Level: {exp}
Interview Type: {itype}
{company_line}
{skills_line}

Rules:
- Use plain, everyday English. Short sentences. No jargon, no buzzwords, no corporate-speak.
- Each question must be one clear ask — never stack two questions into one.
- A candidate should understand exactly what's being asked on first read, with no re-reading.
- Each question must be specific to the role and experience level
- Include at least 2 situational questions phrased as a real scenario, e.g. "Imagine you're mid-sprint and a teammate's bug breaks your feature — what do you do?"
- Mix behavioural, situational and technical questions based on the interview type
- Questions should be progressively more challenging
- Do NOT number the questions
- Return ONLY a valid JSON array of strings, nothing else
- Example format: ["Question 1?", "Question 2?", "Question 3?"]

Return only the JSON array. No explanation, no preamble, no markdown."""

    try:
        res = requests.post(
            'http://localhost:11434/api/generate',
            json={
                'model':  'llama3.2',
                'prompt': prompt,
                'stream': False
            },
            timeout=60
        )

        raw      = res.json().get('response', '').strip()
        # Extract JSON array from response
        start    = raw.find('[')
        end      = raw.rfind(']') + 1
        if start == -1 or end == 0:
            raise ValueError('No JSON array found in response')

        questions = json.loads(raw[start:end])

        if not isinstance(questions, list) or len(questions) == 0:
            raise ValueError('Invalid questions format')

        return jsonify({ 'questions': questions }), 200

    except requests.exceptions.ConnectionError:
        return jsonify({ 'error': 'Ollama is not running. Start it with: ollama serve' }), 503
    except Exception as e:
        return jsonify({ 'error': f'Question generation failed: {str(e)}' }), 500
    
@session_bp.route('/api/session/<int:session_id>/results', methods=['GET'])
def session_results(session_id):
    from models import InterviewSession, EmotionEvent, SessionQuestion

    user_id = session.get('user_id')
    if not user_id:
        return jsonify({'error': 'Not logged in'}), 401

    interview_session = InterviewSession.query.get(session_id)
    if not interview_session:
        return jsonify({'error': 'Session not found'}), 404
    if interview_session.user_id != user_id:
        return jsonify({'error': 'Forbidden'}), 403

    # Get all emotion events
    events = EmotionEvent.query.filter_by(session_id=session_id)\
                .order_by(EmotionEvent.timestamp).all()

    # Get all questions
    questions = SessionQuestion.query.filter_by(session_id=session_id)\
                .order_by(SessionQuestion.question_num).all()

    # Calculate per-question scores from emotion events
    question_results = []
    for q in questions:
        q_events = [e for e in events if e.question_num == q.question_num]
        if q_events:
            avg_conf   = sum(e.face_score    or 0 for e in q_events) / len(q_events)
            avg_anx    = sum(e.anxiety_level or 0 for e in q_events) / len(q_events)
            avg_speech = sum(e.speech_score  or 0 for e in q_events) / len(q_events)
            avg_fil    = max(e.filler_count  or 0 for e in q_events)

            filler_penalty = 100 - min(avg_fil * 5, 100)
            q_score = round((avg_conf * 0.30) + ((100 - avg_anx) * 0.20) +
                             (avg_speech * 0.30) + (filler_penalty * 0.20))

            # Ground truth for "did they actually answer" is spoken word count,
            # not face_score — sitting calmly and silently still scores well on face alone.
            q_words = len((q.answer_text or '').split())
            if q_words == 0:
                q_score = min(q_score, 10)
            elif avg_speech < 20 and avg_fil == 0:
                q_score = min(q_score, 30)
        else:
            avg_conf   = None
            avg_anx    = None
            avg_speech = None
            avg_fil    = 0
            q_score    = None  # No data — user skipped

        question_results.append({
            'question_num': q.question_num,
            'question':     q.question,
            'answer':       q.answer_text,
            'avg_confidence': round(avg_conf, 1) if avg_conf is not None else None,
            'avg_anxiety':    round(avg_anx,  1) if avg_anx  is not None else None,
            'filler_count':   avg_fil,
            'score':          q_score
        })

    # Overall filler word totals — from last emotion event (cumulative)
    last_event    = events[-1] if events else None
    total_fillers = last_event.filler_count if last_event else 0

    # Aggregate scores
    if events:
        avg_conf   = sum(e.face_score    or 0 for e in events) / len(events)
        avg_calm   = sum(100-(e.anxiety_level or 0) for e in events) / len(events)
        avg_speech = sum(e.speech_score  or 0 for e in events) / len(events)
        filler_penalty = 100 - min(total_fillers * 5, 100)

        if interview_session.overall_score is not None:
            overall = interview_session.overall_score
        else:
            overall = (avg_conf * 0.30) + (avg_calm * 0.20) + (avg_speech * 0.30) + (filler_penalty * 0.20)
            total_words = sum(len((q.answer_text or '').split()) for q in questions)
            if total_words == 0:
                overall = min(overall, 10)
            elif avg_speech < 20 and total_fillers == 0:
                overall = min(overall, 30)
    else:
        avg_conf  = 0
        avg_calm  = 0
        overall   = 0

    # Get coaching tips
    from models import CoachingTip
    tips = CoachingTip.query.filter_by(session_id=session_id)\
               .order_by(CoachingTip.timestamp).all()

    return jsonify({
        'session': {
            'id':            interview_session.id,
            'job_role':      interview_session.job_role      or 'Interview',
            'interview_type':interview_session.interview_type or 'General',
            'started_at':    str(interview_session.started_at),
            'ended_at':      str(interview_session.ended_at),
            'overall_score': round(overall, 1),
            'avg_confidence':round(avg_conf, 1),
            'avg_calmness':  round(avg_calm, 1),
            'total_fillers': total_fillers
        },
        'questions': question_results,
        'timeline':  [{
            'timestamp':    str(e.timestamp),
            'face_score':   round(e.face_score    or 0, 1),
            'calmness':     round(100-(e.anxiety_level or 0), 1),
            'question_num': e.question_num
        } for e in events],
        'coaching_tips': [{
            'question_num': t.question_num,
            'trigger':      t.trigger,
            'tip_text':     t.tip_text,
            'timestamp':    str(t.timestamp)
        } for t in tips]
    }), 200


@session_bp.route('/session/audio', methods=['POST'])
def analyse_audio():
    """Receive audio chunk from browser, analyse with librosa, return speech scores."""
    import librosa
    import numpy as np
    import soundfile as sf
    import tempfile, os, base64

    data       = request.get_json()
    audio_b64  = data.get('audio')
    session_id = data.get('session_id')

    if not audio_b64:
        return jsonify({'error': 'No audio data'}), 400

    try:
        # Decode base64 audio blob sent from browser
        audio_bytes = base64.b64decode(audio_b64)

        # Write as webm first, convert to wav for librosa
        with tempfile.NamedTemporaryFile(suffix='.webm', delete=False) as f:
            f.write(audio_bytes)
            webm_path = f.name

        # Convert webm to wav using soundfile via ffmpeg
        import subprocess
        tmp_path = webm_path.replace('.webm', '.wav')
        subprocess.run(
            ['ffmpeg', '-y', '-i', webm_path, tmp_path],
            capture_output=True
        )
        os.unlink(webm_path)

        # Load with librosa (tmp_path is also handed to Whisper below, so don't delete it yet)
        y, sr = librosa.load(tmp_path, sr=22050, mono=True) 

        if len(y) < 100:
            os.unlink(tmp_path) if os.path.exists(tmp_path) else None
            return jsonify({'speech_score': 0, 'pace': 'normal', 'energy': 0, 'spoke': False, 'transcript': ''}), 200

        # ── Feature extraction ──
        # 1. RMS energy (volume/confidence proxy) — also used as a silence gate
        rms          = float(np.sqrt(np.mean(y**2)))
        energy_score = min(100, max(0, int(rms * 2000)))

        # Below this RMS there's no real speech in the chunk (mic noise floor /
        # dead air). Skip Whisper too — running it on silence just wastes time.
        SILENCE_RMS_THRESHOLD = 0.01
        if rms < SILENCE_RMS_THRESHOLD:
            return jsonify({
                'speech_score': max(5, energy_score),
                'pace': 'normal', 'energy': energy_score, 'spoke': False, 'transcript': ''
            }), 200

        # ── Transcription (Whisper) — runs on the wav BEFORE it gets deleted below ──
        # Always runs: the frontend uses this transcript only to catch um/uh
        # (which the browser's own SpeechRecognition strips out entirely),
        # so this can't be skipped even when the browser transcript is live.
        transcript_text = ''
        try:
            model  = get_whisper_model()
            result = model.transcribe(tmp_path, fp16=False, language='en')
            transcript_text = result.get('text', '').strip()
        except Exception:
            transcript_text = ''  # transcription is supplementary — never fail the request over it

        # 2. Spectral centroid (brightness — higher = more expressive)
        centroid   = librosa.feature.spectral_centroid(y=y, sr=sr)
        avg_cent   = float(np.mean(centroid))
        expression = min(100, max(0, int(avg_cent / 80)))

        # 3. Zero crossing rate (nervousness proxy — high ZCR = shaky voice)
        zcr        = librosa.feature.zero_crossing_rate(y)
        avg_zcr    = float(np.mean(zcr))
        nervousness= min(100, max(0, int(avg_zcr * 800)))

        # 4. Tempo (speaking pace)
        tempo, _   = librosa.beat.beat_track(y=y, sr=sr)
        if tempo < 60:
            pace = 'slow'
        elif tempo > 120:
            pace = 'fast'
        else:
            pace = 'normal'

        # 5. Pitch variation (monotone = low variation = nervous/bored)
        pitches, magnitudes = librosa.piptrack(y=y, sr=sr)
        pitch_vals = pitches[magnitudes > np.median(magnitudes)]
        pitch_var  = float(np.std(pitch_vals)) if len(pitch_vals) > 0 else 0
        pitch_score= min(100, max(0, int(pitch_var / 5)))

        # ── Combine into speech score ──
        speech_score = int(
            (energy_score  * 0.30) +
            (expression    * 0.25) +
            (pitch_score   * 0.25) +
            ((100 - nervousness) * 0.20)
        )

        os.unlink(tmp_path)

        return jsonify({
            'speech_score': speech_score,
            'energy':       energy_score,
            'pace':         pace,
            'pitch_var':    pitch_score,
            'nervousness':  nervousness,
            'spoke':        True,
            'transcript':   transcript_text
        }), 200

    except Exception as e:
        return jsonify({'speech_score': 0, 'pace': 'normal', 'energy': 0, 'spoke': False, 'error': str(e), 'transcript': ''}), 200


@session_bp.route('/api/sessions/history', methods=['GET'])
def session_history():
    """Return all past sessions for the logged-in user."""
    user_id = session.get('user_id')
    if not user_id:
        return jsonify({'error': 'Not logged in'}), 401

    sessions = InterviewSession.query\
        .filter_by(user_id=user_id)\
        .order_by(InterviewSession.started_at.desc())\
        .limit(20).all()

    return jsonify({
        'sessions': [{
            'id':            s.id,
            'job_role':      s.job_role      or 'Interview',
            'interview_type':s.interview_type or 'General',
            'experience':    s.experience    or '—',
            'started_at':    str(s.started_at),
            'ended_at':      str(s.ended_at) if s.ended_at else None,
            'overall_score': s.overall_score,
            'avg_confidence':s.avg_confidence,
            'avg_calmness':  s.avg_calmness,
            'total_fillers': s.total_fillers or 0,
            'completed':     s.ended_at is not None
        } for s in sessions]
    }), 200


@session_bp.route('/session/coaching-tip', methods=['POST'])
def save_coaching_tip():
    from models import CoachingTip

    data = request.get_json()


    tip = CoachingTip(
        session_id   = data.get('session_id'),
        question_num = data.get('question_num'),
        trigger      = data.get('trigger'),
        tip_text     = data.get('tip_text')
    )
    db.session.add(tip)
    db.session.commit()

    return jsonify({'message': 'Tip saved'}), 201


@session_bp.route('/session/analyse-face', methods=['POST'])
def analyse_face():
    """Receive a base64 image from browser, analyse with DeepFace, return emotion scores."""
    import base64
    import numpy as np
    import tempfile
    import os
    from deepface import DeepFace

    data      = request.get_json()
    image_b64 = data.get('image')

    if not image_b64:
        return jsonify({'error': 'No image data'}), 400

    try:
        # Decode base64 image
        image_data = base64.b64decode(image_b64.split(',')[-1])

        # Write to temp file
        with tempfile.NamedTemporaryFile(suffix='.jpg', delete=False) as f:
            f.write(image_data)
            tmp_path = f.name

        # Analyse with DeepFace
        result = DeepFace.analyze(
            img_path        = tmp_path,
            actions         = ['emotion'],
            enforce_detection = False,  # don't crash if face not clearly detected
            silent          = True
        )
        os.unlink(tmp_path)

        # DeepFace returns a list — take first face
        face     = result[0] if isinstance(result, list) else result
        emotions = face['emotion']  # dict of emotion: probability

        # ── Map DeepFace emotions to our scores ──
        # Positive emotions → confidence
        confidence = round(
            emotions.get('happy',   0) * 0.60 +
            emotions.get('neutral', 0) * 0.40
        )

        # Negative emotions → anxiety
        anxiety = round(
            emotions.get('fear',    0) * 0.40 +
            emotions.get('sad',     0) * 0.25 +
            emotions.get('angry',   0) * 0.20 +
            emotions.get('disgust', 0) * 0.15
        )

        # Engagement — any strong expression
        engagement = round(
            emotions.get('happy',    0) * 0.50 +
            emotions.get('surprise', 0) * 0.30 +
            emotions.get('neutral',  0) * 0.20
        )

        calmness = round(100 - anxiety)

        # Dominant emotion label
        dominant = max(emotions, key=emotions.get)

        return jsonify({
            'confidence':  min(confidence, 100),
            'anxiety':     min(anxiety,    100),
            'engagement':  min(engagement, 100),
            'calmness':    min(calmness,   100),
            'dominant':    dominant,
            'emotions':    {k: round(v, 1) for k, v in emotions.items()},
            'detected':    True
        }), 200

    except Exception as e:
        # Return neutral scores on failure — don't crash the interview
        return jsonify({
            'confidence': 50,
            'anxiety':    50,
            'engagement': 50,
            'calmness':   50,
            'dominant':   'neutral',
            'detected':   False,
            'error':      str(e)
        }), 200