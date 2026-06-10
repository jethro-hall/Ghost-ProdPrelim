import express from 'express';

const PORT = Number(process.env.PORT || 3001);
const app = express();

app.use(express.json({ limit: '1mb' }));

// Capture x-trace-id from incoming requests and log it; echo in response for debugging
app.use((req, res, next) => {
  const traceId = req.headers['x-trace-id'] || null;
  if (traceId) {
    console.log(JSON.stringify({ level: 'info', service: 'hubtiger', x_trace_id: traceId, route: `${req.method} ${req.path}` }));
    res.setHeader('x-trace-id', traceId);
  }
  next();
});

// Request logging: latency and status (optional structured log on finish)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const latency_ms = Date.now() - start;
    console.log(JSON.stringify({
      level: 'info',
      service: 'hubtiger',
      route: `${req.method} ${req.path}`,
      status: res.statusCode,
      latency_ms,
    }));
  });
  next();
});

// Health
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'hubtiger' });
});

// Minimal stub for proxy integration tests (and ElevenLabs-style tool parity)
app.post('/jobs/search', (req, res) => {
  const q = (req.body && req.body.q) || (req.body && req.body.query) || '';
  const allStores = !!(req.body && req.body.allStores);
  res.json({ results: [], q, allStores, message: 'Stub: no real search' });
});

app.get('/jobs/:id', (req, res) => {
  res.json({ id: req.params.id, StatusDescription: null, message: 'Stub: no real job' });
});

app.get('/jobs/:id/messages', (req, res) => {
  res.json({ jobId: req.params.id, messages: [], message: 'Stub: no real messages' });
});

app.get('/availability/technicians', (req, res) => {
  const from = req.query.from || null;
  const to = req.query.to || null;
  const store = req.query.store || null;
  res.json({
    technicians: [],
    from,
    to,
    store,
    message: 'Stub: no real availability',
  });
});

app.post('/quotes/find-add', (req, res) => {
  const payload = req.body || {};
  res.json({
    quoteId: null,
    dryRun: payload.dryRun !== false,
    accepted: true,
    payload,
    message: 'Stub: no real quote',
  });
});

// 404 and error handler: always JSON
app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

app.use((err, _req, res, _next) => {
  console.error(JSON.stringify({ level: 'error', service: 'hubtiger', error: String(err && err.message) }));
  res.status(500).json({ error: err && err.message ? String(err.message) : 'internal_error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ level: 'info', msg: 'hubtiger listening', port: PORT }));
});
