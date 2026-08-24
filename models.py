from flask_sqlalchemy import SQLAlchemy
from datetime import datetime

db = SQLAlchemy()

# ── Users ────────────────────────────────────────────────────
class User(db.Model):
    __tablename__ = 'users'

    id            = db.Column(db.Integer, primary_key=True)
    name          = db.Column(db.String(100), nullable=False)
    email         = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    created_at    = db.Column(db.DateTime, default=datetime.utcnow)

    sessions      = db.relationship('InterviewSession', backref='user', lazy=True)


# ── Interview Sessions ───────────────────────────────────────
class InterviewSession(db.Model):
    __tablename__ = 'sessions'

    id              = db.Column(db.Integer, primary_key=True)
    user_id         = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)

    # Setup metadata
    job_role        = db.Column(db.String(150), nullable=True)
    company         = db.Column(db.String(150), nullable=True)
    experience      = db.Column(db.String(50),  nullable=True)
    interview_type  = db.Column(db.String(50),  nullable=True)
    skills          = db.Column(db.Text,         nullable=True)

    # Timing
    started_at      = db.Column(db.DateTime, default=datetime.utcnow)
    ended_at        = db.Column(db.DateTime, nullable=True)

    # Aggregate scores (filled when session ends)
    overall_score   = db.Column(db.Float,  nullable=True)
    avg_confidence  = db.Column(db.Float,  nullable=True)
    avg_calmness    = db.Column(db.Float,  nullable=True)
    total_fillers   = db.Column(db.Integer, default=0)

    # Relationships
    emotion_events  = db.relationship('EmotionEvent',   backref='session', lazy=True, cascade='all, delete-orphan')
    questions       = db.relationship('SessionQuestion', backref='session', lazy=True, cascade='all, delete-orphan')


# ── Session Questions ────────────────────────────────────────
class SessionQuestion(db.Model):
    __tablename__ = 'session_questions'

    id           = db.Column(db.Integer, primary_key=True)
    session_id   = db.Column(db.Integer, db.ForeignKey('sessions.id'), nullable=False)
    question_num = db.Column(db.Integer, nullable=False)   # 1-based order
    question     = db.Column(db.Text,    nullable=False)

    # Per-question scores (filled as user answers)
    avg_confidence  = db.Column(db.Float,   nullable=True)
    avg_anxiety     = db.Column(db.Float,   nullable=True)
    filler_count    = db.Column(db.Integer, default=0)
    answered        = db.Column(db.Boolean, default=False)
    answer_text     = db.Column(db.Text,    nullable=True)


# ── Emotion Events ───────────────────────────────────────────
class EmotionEvent(db.Model):
    __tablename__ = 'emotion_events'

    id            = db.Column(db.Integer, primary_key=True)
    session_id    = db.Column(db.Integer, db.ForeignKey('sessions.id'), nullable=False)
    question_num  = db.Column(db.Integer, nullable=True)   # which question was active
    timestamp     = db.Column(db.DateTime, default=datetime.utcnow)

    # Face analysis scores
    face_score    = db.Column(db.Float,   nullable=True)
    anxiety_level = db.Column(db.Float,   nullable=True)
    engagement    = db.Column(db.Float,   nullable=True)

    # Speech analysis scores
    speech_score  = db.Column(db.Float,   nullable=True)
    filler_count  = db.Column(db.Integer, default=0)

    # Combined
    overall_score = db.Column(db.Float,   nullable=True)


# ── Coaching Tips Log ────────────────────────────────────────
class CoachingTip(db.Model):
    __tablename__ = 'coaching_tips'

    id           = db.Column(db.Integer, primary_key=True)
    session_id   = db.Column(db.Integer, db.ForeignKey('sessions.id'), nullable=False)
    question_num = db.Column(db.Integer, nullable=True)
    timestamp    = db.Column(db.DateTime, default=datetime.utcnow)
    trigger      = db.Column(db.String(50),  nullable=True)   # 'high_anxiety', 'filler_words' etc
    tip_text     = db.Column(db.Text,        nullable=False)