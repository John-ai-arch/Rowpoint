// Stage 1 — workout validation. Decides which workouts are structurally
// sound enough to learn from. Invalid ones are excluded WITH a recorded
// reason — never silently dropped, never "fixed" by guessing.
export const validateStage = {
  name: 'validate',
  version: '1.0',
  run(ctx) {
    const valid = [];
    const issues = [];
    for (const w of ctx.candidateWorkouts) {
      const problems = [];
      if (!(Number(w.total_time_s) > 0)) problems.push('no recorded time');
      if (!(Number(w.total_distance_m) > 0)) problems.push('no recorded distance');
      const split = Number(w.avg_split_s);
      // Plausible human erg pace: 1:00 to 10:00 per 500m.
      if (Number.isFinite(split) && split > 0 && (split < 60 || split > 600)) problems.push(`implausible avg split ${split}s/500m`);
      if (!Number.isFinite(Number(w.started_at))) problems.push('missing start time');
      if (problems.length) issues.push({ workoutId: w.id, problems });
      else valid.push(w);
    }
    ctx.workouts = valid;
    return { validated: valid.length, excluded: issues.length, issues };
  },
};
