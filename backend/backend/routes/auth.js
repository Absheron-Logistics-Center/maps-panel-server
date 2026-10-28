import express from 'express';
import jwt from 'jsonwebtoken';

const router = express.Router();

const USERS = [
  {
    // Admin accounts — for each one, the password is just the
    // username itself (e.g. "admin_2" logs in with "admin_2" / "admin_2").
    // To add another admin later, copy this pattern with a new username.
    username: 'admin_2',
    password: 'admin_2',
    role: 'admin'
  },
  {
    username: 'admin_123e123',
    password: 'admin_123e123',
    role: 'admin'
  },
  {
    username: 'user',
    password: 'user123',
    role: 'viewer'
  },
  {
    // Interface-text editor. Can only rename static UI labels (button
    // text, panel-tab names, popup headings, etc.) via the label-editor
    // screen — cannot touch diagram content (that stays admin's job).
    username: 'editor_2',
    password: 'editor_2',
    role: 'editor_2'
  }
];

export function requireAuth(req, res, next) {

  try {

    const authHeader =
      req.headers.authorization || '';

    if (!authHeader.startsWith('Bearer ')) {

      return res.status(401).json({
        error: 'Unauthorized'
      });
    }

    const token =
      authHeader.replace('Bearer ', '');

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || 'absheron-secret'
    );

    req.user = decoded;

    next();

  } catch (e) {

    return res.status(401).json({
      error: 'Invalid token'
    });
  }
}

router.post('/login', (req, res) => {

  const { username, password } = req.body;

  const user = USERS.find(
    x =>
      x.username === username &&
      x.password === password
  );

  if (!user) {

    return res.status(401).json({
      error: 'Bad credentials'
    });
  }

  const token = jwt.sign(
    {
      username: user.username,
      role: user.role
    },
    process.env.JWT_SECRET || 'absheron-secret'
  );

  res.json({
    token,
    role: user.role,
    username: user.username
  });
});

router.get(
  '/me',
  requireAuth,
  (req, res) => {

    res.json({
      username: req.user.username,
      role: req.user.role
    });
  }
);

export default router;