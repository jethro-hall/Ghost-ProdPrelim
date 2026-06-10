import express from 'express';
import axios from 'axios';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const app = express();
app.use(cors());
app.use(express.json());
app.set('json spaces', 2);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Explicitly define the project root where index.html and index.tsx live
const PROJECT_ROOT = __dirname;

const HUBTIGER_BASE_URL = 'https://api.hubtiger.com/v1'; 
const HUBTIGER_API_KEY = process.env.HUBTIGER_API_KEY;
const INTERNAL_KEY = process.env.INTERNAL_KEY || 'ride-ai-secret-2024';

// Simple logging
app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url}`);
  next();
});

const authCheck = (req, res, next) => {
  const clientKey = req.headers['x-internal-key'];
  if (!clientKey || clientKey !== INTERNAL_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
};

// --- API Endpoints ---
app.post('/jobs/search', authCheck, async (req, res) => {
  try {
    const { phone, email, firstName, lastName } = req.body;
    const query = phone || email || `${firstName || ''} ${lastName || ''}`.trim();
    if (!query) return res.status(400).json({ ok: false, error: 'Query required' });

    const response = await axios.get(`${HUBTIGER_BASE_URL}/jobs/search`, {
      params: { q: query, all_stores: true },
      headers: { 'Authorization': `Bearer ${HUBTIGER_API_KEY}` }
    });

    const matches = response.data.map(job => ({
      id: job.id,
      jobCardNo: job.job_card_number,
      customerName: job.customer ? `${job.customer.first_name} ${job.customer.last_name}` : 'Unknown',
      bike: job.bike ? `${job.bike.make} ${job.bike.model}` : 'Unknown',
      status: job.status?.name || 'Unknown'
    }));
    res.json({ ok: true, matches });
  } catch (error) {
    console.error('Search Error:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/jobs/:id/messages', authCheck, async (req, res) => {
  try {
    const response = await axios.get(`${HUBTIGER_BASE_URL}/jobs/${req.params.id}/messages`, {
      headers: { 'Authorization': `Bearer ${HUBTIGER_API_KEY}` }
    });
    res.json({ ok: true, messages: response.data });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// --- Static and Catch-all ---

// Serve static files (index.tsx, components, etc)
app.use(express.static(PROJECT_ROOT));

// Express 5 compatible catch-all using .use middleware
// This avoids using a string-based route like '*' which causes PathErrors in v5
app.use((req, res, next) => {
  // If the request is for a specific file (has an extension) but it wasn't found in static, 404 it.
  const ext = path.extname(req.path);
  if (ext && ext !== '.html') {
    return res.status(404).send('Not Found');
  }
  
  // Otherwise, treat it as a navigation request and serve index.html
  res.sendFile(path.join(PROJECT_ROOT, 'index.html'));
});

const PORT = process.env.PORT || 8095;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('---------------------------------------------');
  console.log(`🚀 RIDEAI PROXY RUNNING AT PORT ${PORT}`);
  console.log(`🌍 URL: http://agents.rideai.com.au:${PORT}`);
  console.log(`📂 ROOT: ${PROJECT_ROOT}`);
  console.log('---------------------------------------------');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`❌ FATAL: Port ${PORT} is busy.`);
    process.exit(1);
  }
});