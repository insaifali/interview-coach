from flask_sqlalchemy import SQLAlchemy
from datetime import datetime

db = SQLAlchemy()

class User(db.Model):
    __tablename__ = 'users'
    id            = db.Column(db.Integer, primary_key=True)
    name          = db.Column(db.String(100), nullable=False)
    email         = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    created_at    = db.Column(db.DateTime, default=datetime.utcnow)
    sessions      = db.relationship('InterviewSession', backref='user', lazy=True)

class InterviewSession(db.Model):
    __tablename__ = 'sessions'
    id            = db.Column(db.Integer, primary_key=True)
    user_id       = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=False)
    started_at    = db.Column(db.DateTime, default=datetime.utcnow)
    ended_at      = db.Column(db.DateTime, nullable=True)
    overall_score = db.Column(db.Float, nullable=True)
    emotion_events = db.relationship('EmotionEvent', backref='session', lazy=True)

class EmotionEvent(db.Model):
    __tablename__ = 'emotion_events'
    id            = db.Column(db.Integer, primary_key=True)
    session_id    = db.Column(db.Integer, db.ForeignKey('sessions.id'), nullable=False)
    timestamp     = db.Column(db.DateTime, default=datetime.utcnow)
    face_score    = db.Column(db.Float, nullable=True)
    speech_score  = db.Column(db.Float, nullable=True)
    filler_count  = db.Column(db.Integer, default=0)
    anxiety_level = db.Column(db.Float, nullable=True)