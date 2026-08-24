from functools import wraps
from flask import Flask, jsonify, render_template, session, redirect
from flask_cors import CORS
from flask_session import Session
from config import Config
from models import db
from routes.auth import auth_bp
from routes.session import session_bp

app = Flask(__name__)
app.config.from_object(Config)

CORS(app, supports_credentials=True)
Session(app)
db.init_app(app)

# Register routes
app.register_blueprint(auth_bp)
app.register_blueprint(session_bp)

# Create all database tables
with app.app_context():
    db.create_all()
    print("✅ Database tables created successfully")

    # db.create_all() only creates missing tables, it never alters existing
    # ones — no Alembic/Flask-Migrate in this project, so patch new columns
    # onto pre-existing tables here.
    from sqlalchemy import text as _sql_text
    try:
        db.session.execute(_sql_text(
            'ALTER TABLE session_questions ADD COLUMN answer_text TEXT'
        ))
        db.session.commit()
        print("✅ Added answer_text column to session_questions")
    except Exception:
        db.session.rollback()  # column already exists — fine


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get('user_id'):
            return redirect('/')
        return view(*args, **kwargs)
    return wrapped


@app.route('/')
def hello():
    return render_template('index.html')

@app.route('/setup')
@login_required
def setup():
    return render_template('setup.html')

@app.route('/interview')
@login_required
def interview():
    return render_template('interview.html')

@app.route('/register')
def register_page():
    return render_template('register.html')

@app.route('/dashboard')
@login_required
def dashboard():
    return render_template('dashboard.html')

@app.route('/history')
@login_required
def history():
    return render_template('history.html')


if __name__ == '__main__':
    app.run(debug=True, port=5000, threaded=True)