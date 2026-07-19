import requests
import json
from flask import Blueprint, request, jsonify, session
from models import db, InterviewSession, EmotionEvent
from datetime import datetime

session_bp = Blueprint('session', __name__)

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
    from models import InterviewSession, EmotionEvent
    import sqlalchemy as sa

    data       = request.get_json()
    session_id = data.get('session_id')

    interview_session = InterviewSession.query.get(session_id)
    if not interview_session:
        return jsonify({'error': 'Session not found'}), 404

    # Calculate aggregate scores from all emotion events
    events = EmotionEvent.query.filter_by(session_id=session_id).all()

    if events:
        avg_conf  = sum(e.face_score    or 0 for e in events) / len(events)
        avg_calm  = sum(100 - (e.anxiety_level or 0) for e in events) / len(events)
        max_fill  = max((e.filler_count or 0) for e in events)
    else:
        avg_conf  = data.get('overall_score', 50)
        avg_calm  = 50
        max_fill  = 0

    overall = (avg_conf * 0.5) + (avg_calm * 0.3) + ((100 - min(max_fill * 5, 100)) * 0.2)

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

    prompt = f"""You are an expert interview coach. Generate exactly {count} professional interview questions for the following:

Role: {role}
Experience Level: {exp}
Interview Type: {itype}
{company_line}
{skills_line}

Rules:
- Each question must be specific to the role and experience level
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

    interview_session = InterviewSession.query.get(session_id)
    if not interview_session:
        return jsonify({'error': 'Session not found'}), 404

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
            avg_conf  = sum(e.face_score    or 0 for e in q_events) / len(q_events)
            avg_anx   = sum(e.anxiety_level or 0 for e in q_events) / len(q_events)
            avg_fil   = max(e.filler_count  or 0 for e in q_events)
            q_score   = round((avg_conf * 0.6) + ((100 - avg_anx) * 0.4))
        else:
            avg_conf  = None
            avg_anx   = None
            avg_fil   = 0
            q_score   = None  # No data — user skipped

        question_results.append({
            'question_num': q.question_num,
            'question':     q.question,
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
        avg_conf  = sum(e.face_score    or 0 for e in events) / len(events)
        avg_calm  = sum(100-(e.anxiety_level or 0) for e in events) / len(events)
        overall   = interview_session.overall_score or round(
            (avg_conf * 0.5) + (avg_calm * 0.3) +
            ((100 - min(total_fillers * 5, 100)) * 0.2)
        )
    else:
        avg_conf  = 0
        avg_calm  = 0
        overall   = 0

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
        'timeline': [{
            'timestamp':   str(e.timestamp),
            'face_score':  round(e.face_score    or 0, 1),
            'calmness':    round(100-(e.anxiety_level or 0), 1),
            'question_num':e.question_num
        } for e in events]
    }), 200