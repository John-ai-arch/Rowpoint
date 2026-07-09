// Research Observatory API. Read-only, aggregate-only; a viewer sees their own
// percentile within an anonymous cohort. Never returns individual rows.
import { Router } from 'express';
import { authRequired } from './middleware.js';
import { observe, benchmark } from './observatory.js';

export const observatoryRouter = Router();
observatoryRouter.use(authRequired);

function readFilters(q = {}) {
  return {
    weightClass: q.weightClass || null,
    birthDecade: q.birthDecade || null,
    goalType: q.goalType || null,
    best2kMin: q.best2kMin || null,
    best2kMax: q.best2kMax || null,
    weeklyMetersMin: q.weeklyMetersMin || null,
  };
}

// Benchmark Explorer (moat #3) — population benchmarks for an explored cohort.
observatoryRouter.get('/benchmark', (req, res) => {
  res.json({ benchmark: benchmark(readFilters(req.query)) });
});

observatoryRouter.get('/', (req, res) => {
  res.json({ observatory: observe(req.user, readFilters(req.query)) });
});
