from flask import Blueprint, request, jsonify, session
from models import db, InterviewSession, EmotionEvent
from datetime import datetime

session_bp = Blueprint('session', __name__)

@session_bp.route('/session/start', methods=['POST'])
def start_session():
    user_id = session.get('user_id')
    if not user_id:
        return jsonify({'error': 'Not logged in'}), 401

    new_session = InterviewSession(user_id=user_id)
    db.session.add(new_session)
    db.session.commit()

    return jsonify({'message': 'Session started', 'session_id': new_session.id}), 201


@session_bp.route('/session/end', methods=['POST'])
def end_session():
    data = request.get_json()
    session_id = data.get('session_id')

    interview_session = InterviewSession.query.get(session_id)
    if not interview_session:
        return jsonify({'error': 'Session not found'}), 404

    interview_session.ended_at = datetime.utcnow()
    interview_session.overall_score = data.get('overall_score', 0.0)
    db.session.commit()

    return jsonify({'message': 'Session ended', 'session_id': session_id}), 200


@session_bp.route('/session/emotion', methods=['POST'])
def save_emotion():
    data = request.get_json()

    event = EmotionEvent(
        session_id    = data.get('session_id'),
        face_score    = data.get('face_score'),
        speech_score  = data.get('speech_score'),
        filler_count  = data.get('filler_count', 0),
        anxiety_level = data.get('anxiety_level')
    )
    db.session.add(event)
    db.session.commit()

    return jsonify({'message': 'Emotion event saved'}), 201