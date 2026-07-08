// Performance intelligence API: daily Training Readiness and race predictions.
// Thin layer over server/ai/performance.js + the existing training analysis.
import { Router } from 'express';
import { authRequired } from './middleware.js';
import { buildTrainingAnalysis } from './ai/trainingAnalysis.js';
import { readinessScore, racePredictions } from './ai/performance.js';
import { now } from './util.js';

export const performanceRouter = Router();
performanceRouter.use(authRequired);

performanceRouter.get('/readiness', (req, res) => {
  const analysis = buildTrainingAnalysis(req.user, now());
  res.json({ readiness: readinessScore(analysis) });
});

performanceRouter.get('/predictions', (req, res) => {
  const analysis = buildTrainingAnalysis(req.user, now());
  res.json({ predictions: racePredictions(analysis) });
});

// Both at once (dashboard + progress consume these together).
performanceRouter.get('/summary', (req, res) => {
  const analysis = buildTrainingAnalysis(req.user, now());
  res.json({ readiness: readinessScore(analysis), predictions: racePredictions(analysis) });
});
