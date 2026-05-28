require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Health check — proves the server is alive
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    message: 'Field Seller backend is running',
    hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
    sfUsername: process.env.SF_USERNAME || null,
  });
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});