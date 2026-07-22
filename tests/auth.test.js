const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-ci';

// Minimal requireAuth middleware extracted for unit testing
function requireAuth(req, res, next) {
  const authHeader = req.headers && req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : (req.query && req.query._token);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function makeRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

describe('requireAuth middleware', () => {
  const payload = { id: 'usr-1', username: 'admin', role: 'admin' };
  let validToken;

  beforeAll(() => {
    validToken = jwt.sign(payload, JWT_SECRET, { expiresIn: '1h' });
  });

  test('accepts valid Bearer token', () => {
    const req = { headers: { authorization: `Bearer ${validToken}` }, query: {} };
    const res = makeRes();
    const next = jest.fn();
    requireAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user.username).toBe('admin');
  });

  test('accepts valid _token query param', () => {
    const req = { headers: {}, query: { _token: validToken } };
    const res = makeRes();
    const next = jest.fn();
    requireAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('rejects missing token with 401', () => {
    const req = { headers: {}, query: {} };
    const res = makeRes();
    const next = jest.fn();
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('rejects expired token with 401', () => {
    const expired = jwt.sign(payload, JWT_SECRET, { expiresIn: '-1s' });
    const req = { headers: { authorization: `Bearer ${expired}` }, query: {} };
    const res = makeRes();
    const next = jest.fn();
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('rejects token signed with wrong secret', () => {
    const bad = jwt.sign(payload, 'wrong-secret');
    const req = { headers: { authorization: `Bearer ${bad}` }, query: {} };
    const res = makeRes();
    const next = jest.fn();
    requireAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
