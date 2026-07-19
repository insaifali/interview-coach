from flask import Flask, jsonify, render_template
from flask_cors import CORS
from config import Config
from models import db
from routes.auth import auth_bp
from routes.session import session_bp

app = Flask(__name__)
app.config.from_object(Config)

CORS(app)
db.init_app(app)

# Register routes
app.register_blueprint(auth_bp)
app.register_blueprint(session_bp)

# Create all database tables
with app.app_context():
    db.create_all()
    print("✅ Database tables created successfully")

@app.route('/')
def hello():
    return render_template('index.html')

@app.route('/setup')
def setup():
    return render_template('setup.html')

@app.route('/interview')
def interview():
    return render_template('interview.html')

@app.route('/register')
def register_page():
    return render_template('register.html')

@app.route('/dashboard')
def dashboard():
    return render_template('dashboard.html')


if __name__ == '__main__':
    app.run(debug=True, port=5000)