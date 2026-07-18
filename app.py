from flask import Flask, jsonify
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

# Test route
@app.route('/')
def hello():
    return jsonify({'message': 'Interview Coach API is running!'})

if __name__ == '__main__':
    app.run(debug=True, port=5000)