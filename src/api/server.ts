import express from 'express';
import cors from 'cors';
import routes from './routes';
import { requestLogger } from '../middleware/requestLogger';
import { securityHeaders } from '../middleware/securityHeaders';
import { apiRateLimiter } from '../middleware/rateLimiter';
import { projectContextMiddleware } from '../middleware/projectContext';

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// Security headers (apply first)
app.use(securityHeaders);

// Request logging
app.use(requestLogger);

// CORS Configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000', 'http://localhost:3001'];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`⚠️  Blocked CORS request from origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-project-id'],
}));

app.use(express.json());

// Project context middleware
app.use(projectContextMiddleware);

// Global rate limiting (100 requests per minute per IP)
app.use('/api', apiRateLimiter);

// Routes
app.use('/api', routes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Vesting API server running on port ${PORT}`);
});

export default app;
