import pytest
from app import app, db

@pytest.fixture
def client():
    app.config['TESTING'] = True
    app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///:memory:'
    with app.app_context():
        db.create_all()
        yield app.test_client()
        db.drop_all()

def test_register_requires_all_fields(client):
    res = client.post('/register', json={'email': 'a@b.com'})
    assert res.status_code == 400

def test_register_and_login(client):
    client.post('/register', json={'name': 'Test User', 'email': 'a@b.com', 'password': 'pass123'})
    res = client.post('/login', json={'email': 'a@b.com', 'password': 'pass123'})
    assert res.status_code == 200
    assert res.get_json()['name'] == 'Test User'

def test_login_wrong_password(client):
    client.post('/register', json={'name': 'Test User', 'email': 'a@b.com', 'password': 'pass123'})
    res = client.post('/login', json={'email': 'a@b.com', 'password': 'wrong'})
    assert res.status_code == 401

def test_duplicate_email_rejected(client):
    client.post('/register', json={'name': 'A', 'email': 'a@b.com', 'password': 'pass123'})
    res = client.post('/register', json={'name': 'B', 'email': 'a@b.com', 'password': 'pass456'})
    assert res.status_code == 409