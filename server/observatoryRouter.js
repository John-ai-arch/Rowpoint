// Research Observatory API. Read-only, aggregate-only; a viewer sees their own
// percentile within an anonymous cohort. Never returns individual rows.
import { Router } from 'express';
import { authRequired } from './middleware.js';
import { observe } from './observatory.js';

export const observatoryRouter = Router();
observatoryRouter.use(authRequired);

observatoryRouter.get('/', (req, res) => {
  const q = req.query || {};
  const filters = {
    weightClass: q.weightClass || null,
    birthDecade: q.birthDecade || null,
    goalType: q.goalType || null,
    best2kMin: q.best2kMin || null,
    best2kMax: q.best2kMax || null,
    weeklyMetersMin: q.weeklyMetersMin || null,
  };
  res.json({ observatory: observe(req.user, filters) });
});
