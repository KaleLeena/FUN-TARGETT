import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import type {NextFunction, Request, Response} from 'express';
import {createServer as createViteServer} from 'vite';
import {WebSocketServer} from 'ws';
import {
  adjustUserNumberPoints,
  adminAdjustPoints,
  adminResetDemoSession,
  authenticateCustomer,
  cancelUserRoundSelections,
  claimAdminPassword,
  createCustomerAccount,
  db,
  getAdminAuthStatus,
  getAdminControlData,
  getUserById,
  getUserHistory,
  getUserRoundSelections,
  initSchema,
  logAdminAction,
  placeRoundSelections,
  signToken,
  touchUserActive,
  verifyAdminPassword,
  verifyToken,
} from './server/db.ts';
import type {TokenPayload} from './server/db.ts';
import {gameEngine} from './server/gameEngine.ts';
import type {ResultRuleMode} from './src/types/game.ts';

initSchema();

const app = express();
app.disable('x-powered-by');
app.use(express.json({limit: '256kb'}));

interface AuthedRequest extends Request {
  auth?: TokenPayload;
}

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice(7).trim();
}

function requireCustomer(req: AuthedRequest, res: Response, next: NextFunction): void {
  const token = extractBearer(req);
  if (!token) {
    res.status(401).json({error: 'Customer profile session required.'});
    return;
  }
  const payload = verifyToken(token);
  if (!payload || payload.role !== 'customer') {
    res.status(401).json({error: 'Invalid or expired customer session.'});
    return;
  }
  const user = getUserById(payload.sub);
  if (!user || user.status === 'suspended') {
    res.status(403).json({error: 'Customer profile is inactive or suspended.'});
    return;
  }
  req.auth = payload;
  next();
}

function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  const token = extractBearer(req);
  if (!token) {
    res.status(401).json({error: 'Owner authorization required.'});
    return;
  }
  const payload = verifyToken(token);
  if (!payload || payload.role !== 'admin') {
    res.status(403).json({error: 'Owner privileges required.'});
    return;
  }
  req.auth = payload;
  next();
}

app.get('/api/health', (_req, res) => {
  res.json({ok: true, roundNumber: gameEngine.getRoundNumber()});
});

app.get('/api/game/state', (_req, res) => {
  res.json({round: gameEngine.getPublicState()});
});

// ---------- Customer Profiles ----------
app.post('/api/auth/register', (req, res) => {
  const {username, email, password} = req.body as {
    username?: unknown;
    email?: unknown;
    password?: unknown;
  };
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_.-]{3,24}$/.test(username.trim())) {
    res.status(400).json({error: 'Username must be 3–24 characters (letters, numbers, _, ., -).'});
    return;
  }
  if (typeof password !== 'string' || password.length < 6 || password.length > 128) {
    res.status(400).json({error: 'Password must be between 6 and 128 characters.'});
    return;
  }
  let cleanEmail: string | null = null;
  if (typeof email === 'string' && email.trim().length > 0) {
    cleanEmail = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 120) {
      res.status(400).json({error: 'Please enter a valid email address.'});
      return;
    }
  }

  const existing = db.prepare(`SELECT id FROM users WHERE username = ?`).get(username.trim());
  if (existing) {
    res.status(409).json({error: 'Username is already registered.'});
    return;
  }

  const user = createCustomerAccount({
    username: username.trim(),
    email: cleanEmail,
    password,
    isGuest: false,
  });
  const token = signToken(user.id, 'customer');
  res.status(201).json({token, user});
});

app.post('/api/auth/login', (req, res) => {
  const {identifier, password} = req.body as {identifier?: unknown; password?: unknown};
  if (typeof identifier !== 'string' || typeof password !== 'string') {
    res.status(400).json({error: 'Username and password are required.'});
    return;
  }
  const result = authenticateCustomer(identifier, password);
  if (!result.user) {
    res.status(result.error?.includes('suspended') ? 403 : 401).json({
      error: result.error || 'Authentication failed.',
    });
    return;
  }
  const token = signToken(result.user.id, 'customer');
  res.json({token, user: result.user});
});

app.post('/api/auth/guest', (_req, res) => {
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  const username = `Player_${suffix}`;
  const randomPw = crypto.randomBytes(16).toString('hex');
  const user = createCustomerAccount({
    username,
    email: null,
    password: randomPw,
    isGuest: true,
  });
  const token = signToken(user.id, 'customer');
  res.status(201).json({token, user});
});

app.get('/api/auth/me', requireCustomer, (req: AuthedRequest, res) => {
  const userId = req.auth!.sub;
  touchUserActive(userId);
  const user = getUserById(userId);
  const currentSelections = getUserRoundSelections(gameEngine.getRoundNumber(), userId);
  const history = getUserHistory(userId, 50);
  res.json({user, currentSelections, history});
});

// ---------- Game Selection Routes ----------
app.post('/api/game/select', requireCustomer, (req: AuthedRequest, res) => {
  if (!gameEngine.isSelectionOpen()) {
    res.status(409).json({
      error: 'Round is locked or paused. Wait for the next active 60-second countdown.',
    });
    return;
  }
  const {entries} = req.body as {
    entries?: Array<{selectedNumber: number; pointsStaked: number}>;
  };
  const result = placeRoundSelections({
    roundNumber: gameEngine.getRoundNumber(),
    userId: req.auth!.sub,
    entries: Array.isArray(entries) ? entries : [],
    ruleMode: gameEngine.getRuleMode(),
  });
  if (result.error) {
    res.status(400).json({error: result.error});
    return;
  }
  gameEngine.broadcastState();
  res.json({
    user: result.user,
    currentSelections: result.selections,
    history: getUserHistory(req.auth!.sub, 50),
    round: gameEngine.getPublicState(),
  });
});

app.post('/api/game/cancel', requireCustomer, (req: AuthedRequest, res) => {
  if (!gameEngine.isSelectionOpen()) {
    res.status(409).json({
      error: 'Round is already locked; confirmed selections cannot be cancelled.',
    });
    return;
  }
  const result = cancelUserRoundSelections(gameEngine.getRoundNumber(), req.auth!.sub);
  gameEngine.broadcastState();
  res.json({
    refunded: result.refunded,
    user: result.user,
    currentSelections: result.selections,
    history: getUserHistory(req.auth!.sub, 50),
    round: gameEngine.getPublicState(),
  });
});

app.post('/api/game/adjust-number', requireCustomer, (req: AuthedRequest, res) => {
  if (!gameEngine.isSelectionOpen()) {
    res.status(409).json({
      error: 'Round is already locked; confirmed selections cannot be changed.',
    });
    return;
  }
  const {selectedNumber, delta} = req.body as {
    selectedNumber?: unknown;
    delta?: unknown;
  };
  if (typeof selectedNumber !== 'number' || typeof delta !== 'number') {
    res.status(400).json({error: 'selectedNumber and delta must be numbers.'});
    return;
  }
  const result = adjustUserNumberPoints({
    roundNumber: gameEngine.getRoundNumber(),
    userId: req.auth!.sub,
    selectedNumber,
    delta,
    ruleMode: gameEngine.getRuleMode(),
  });
  if (result.error) {
    res.status(400).json({error: result.error});
    return;
  }
  gameEngine.broadcastState();
  res.json({
    adjustedBy: result.adjustedBy,
    user: result.user,
    currentSelections: result.selections,
    history: getUserHistory(req.auth!.sub, 50),
    round: gameEngine.getPublicState(),
  });
});

// ---------- Owner Control Panel Routes ----------
app.get('/api/admin/status', (_req, res) => {
  res.json(getAdminAuthStatus());
});

app.post('/api/admin/claim', (req, res) => {
  const {password} = req.body as {password?: unknown};
  if (typeof password !== 'string') {
    res.status(400).json({error: 'Password is required.'});
    return;
  }
  const result = claimAdminPassword(password);
  if (!result.ok) {
    res.status(400).json({error: result.error || 'Could not claim owner password.'});
    return;
  }
  const token = signToken('OWNER_ADMIN', 'admin');
  res.status(201).json({token});
});

app.post('/api/admin/login', (req, res) => {
  const {password} = req.body as {password?: unknown};
  if (typeof password !== 'string' || password.length === 0) {
    res.status(400).json({error: 'Owner passcode is required.'});
    return;
  }
  if (!verifyAdminPassword(password)) {
    res.status(401).json({error: 'Invalid owner passcode.'});
    return;
  }
  logAdminAction('Owner', 'OWNER_LOGIN', null, 'Owner unlocked administrative controls.');
  const token = signToken('OWNER_ADMIN', 'admin');
  res.json({token});
});

app.get('/api/admin/controls', requireAdmin, (_req, res) => {
  res.json(getAdminControlData());
});

app.post('/api/admin/game-control', requireAdmin, (req, res) => {
  const {action} = req.body as {action?: unknown};
  if (action === 'start') {
    gameEngine.startEngine();
    logAdminAction('Owner', 'GAME_STARTED', null, 'Owner started the round timer.');
  } else if (action === 'stop') {
    gameEngine.stopEngine();
    logAdminAction('Owner', 'GAME_STOPPED', null, 'Owner stopped the round timer.');
  } else if (action === 'reset_game') {
    adminResetDemoSession('Owner');
    gameEngine.resetCurrentRound();
    logAdminAction('Owner', 'GAME_RESET', null, 'Owner reset active round and demo session.');
  } else if (action === 'reset_session') {
    adminResetDemoSession('Owner');
    gameEngine.startEngine();
  } else {
    res.status(400).json({error: 'Unknown control action.'});
    return;
  }

  res.json({
    round: gameEngine.getPublicState(),
    controls: getAdminControlData(),
  });
});

app.post('/api/admin/rule-mode', requireAdmin, (req, res) => {
  const {ruleMode} = req.body as {ruleMode?: unknown};
  if (
    ruleMode !== 'fair_rng' &&
    ruleMode !== 'demo_two_round' &&
    ruleMode !== 'demo_lowest_points'
  ) {
    res.status(400).json({error: 'Invalid ruleMode.'});
    return;
  }
  gameEngine.setRuleMode(ruleMode as ResultRuleMode);
  logAdminAction(
    'Owner',
    'RULE_MODE_CHANGED',
    null,
    ruleMode === 'demo_lowest_points'
      ? 'Switched to Lowest / Zero Points Demo Rule (virtual simulation).'
      : ruleMode === 'demo_two_round'
        ? 'Switched to Demo Two-Round Unselected Number Rule (virtual simulation).'
        : 'Switched to Fair Verifiable RNG (all 0–9 numbers equally eligible).'
  );
  res.json({
    round: gameEngine.getPublicState(),
    controls: getAdminControlData(),
  });
});

app.post('/api/admin/customers/:userId/points', requireAdmin, (req, res) => {
  const userId = String(req.params.userId || '');
  const {amount, reason} = req.body as {amount?: unknown; reason?: unknown};
  if (typeof amount !== 'number' || !Number.isInteger(amount)) {
    res.status(400).json({error: 'Amount must be a whole number.'});
    return;
  }
  const result = adminAdjustPoints(
    userId,
    amount,
    typeof reason === 'string' ? reason : '',
    'Owner'
  );
  if (result.error) {
    res.status(400).json({error: result.error});
    return;
  }
  res.json({customer: result.user, controls: getAdminControlData()});
});

// ---------- HTTP + WebSocket + Vite / Static Hosting ----------
const PORT = Number(process.env.PORT || 3000);
const server = http.createServer(app);
const wss = new WebSocketServer({noServer: true});

server.on('upgrade', (req, socket, head) => {
  try {
    const reqUrl = new URL(req.url || '/', 'http://localhost');
    if (reqUrl.pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
  } catch {
    socket.destroy();
  }
});

gameEngine.attachWebSocketServer(wss);
gameEngine.start();

async function startServer(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: {server},
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`FUN TARGET offline/local server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start FUN TARGET server:', err);
  process.exit(1);
});
