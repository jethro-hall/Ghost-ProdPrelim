
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Configuration
const HUBTIGER_BASE_URL = 'https://api.hubtiger.com/v1'; 
const HUBTIGER_API_KEY = process.env.HUBTIGER_API_KEY;
const INTERNAL_KEY = process.env.INTERNAL_KEY || 'ride-ai-secret-2024';

// 1. SERVE FRONTEND FILES
// This allows you to see the dashboard when you visit the server URL
app.use(express.static(path.join(__dirname, '../')));

// Middleware: Security Check for API endpoints
const authCheck = (req, res, next) => {
  const clientKey = req.headers['x-internal-key'];
  if (!clientKey || clientKey !== INTERNAL_KEY) {
    console.warn(`[AUTH] Unauthorized access attempt from ${req.ip}`);
    return res.status(401).json({ ok: false, error: 'Unauthorized: Missing or invalid X-Internal-Key' });
  }
  next();
};

// 2. API ENDPOINTS
app.post('/jobs/search', authCheck, async (req, res) => {
  console.log('[API] Search Request Received:', req.body);
  try {
    const { firstName, lastName, email, phone, allStores = true } = req.body;
    const query = phone || email || `${firstName || ''} ${lastName || ''}`.trim();

    if (!query) {
      return res.status(400).json({ ok: false, error: 'No search parameters provided' });
    }

    const response = await axios.get(`${HUBTIGER_BASE_URL}/jobs/search`, {
      params: { q: query, all_stores: allStores },
      headers: { 'Authorization': `Bearer ${HUBTIGER_API_KEY}` }
    });

    const matches = response.data.map(job => ({
      id: job.id,
      jobCardNo: job.job_card_number,
      customerName: job.customer ? `${job.customer.first_name} ${job.customer.last_name}` : 'Unknown',
      bike: job.bike ? `${job.bike.make} ${job.bike.model}` : 'Unknown Bike',
      status: job.status?.name || 'Unknown',
      lastUpdated: job.updated_at
    }));

    res.json({ ok: true, matches, count: matches.length });
  } catch (error) {
    console.error('[ERROR] Search Failed:', error.response?.data || error.message);
    res.status(500).json({ ok: false, error: 'Hubtiger API search failed' });
  }
});

app.get('/jobs/:id', authCheck, async (req, res) => {
  const { id } = req.params;
  try {
    const response = await axios.get(`${HUBTIGER_BASE_URL}/jobs/${id}`, {
      headers: { 'Authorization': `Bearer ${HUBTIGER_API_KEY}` }
    });
    const job = response.data;
    res.json({
      ok: true,
      data: {
        id: job.id,
        jobCardNo: job.job_card_number,
        status: job.status?.name,
        technician: job.technician?.name || 'Unassigned',
        estimatedReady: job.estimated_completion_date,
        totalCost: job.total_price,
        mechanicNotes: job.internal_notes || 'No notes found.',
        isReadyForCollection: job.status?.is_completed || false,
        bike: job.bike ? `${job.bike.make} ${job.bike.model}` : 'Unknown'
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: 'Could not fetch job details' });
  }
});

// 3. CATCH-ALL ROUTE (Serves the Dashboard)
// If the request isn't for an API, send the index.html file
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../index.html'));
});

const PORT = process.env.PORT || 8095;
app.listen(PORT, '0.0.0.0', () => {
  console.log('---------------------------------------------');
  console.log(`🚀 RIDEAI DASHBOARD & PROXY IS LIVE`);
  console.log(`🌍 URL: http://agents.rideai.com.au:${PORT}`);
  console.log('---------------------------------------------');
});
