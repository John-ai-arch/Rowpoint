// Stage 3 — data cleaning. Builds the in-memory cleaned view the extractors
// consume: values flagged implausible by stage 2 become null (missing), the
// stored workout rows are never modified. Cleaning means refusing to learn
// from bad data, not rewriting history.
export const cleanStage = {
  name: 'clean',
  version: '1.0',
  run(ctx) {
    const cleaned = new Map(); // workoutId → { workout, splits }
    let nulledValues = 0;
    for (const w of ctx.workouts) {
      const flags = ctx.sensorFlags[w.id] || [];
      const cw = { ...w };
      if (flags.includes('hr_implausible') || flags.includes('hr_avg_exceeds_max')) { cw.avg_heart_rate = null; nulledValues++; }
      if (flags.includes('hr_max_implausible')) { cw.max_heart_rate = null; nulledValues++; }
      if (flags.includes('power_implausible')) { cw.avg_power_watts = null; nulledValues++; }
      if (flags.includes('rate_implausible')) { cw.avg_stroke_rate = null; nulledValues++; }
      const splits = (ctx.splitsByWorkout.get(w.id) || []).map(s => {
        const cs = { ...s };
        const hr = Number(cs.avg_heart_rate);
        if (hr && (hr < 30 || hr > 230)) { cs.avg_heart_rate = null; nulledValues++; }
        const watts = Number(cs.avg_power_watts);
        if (watts && (watts < 0 || watts > 2000)) { cs.avg_power_watts = null; nulledValues++; }
        const pace = Number(cs.avg_pace_s_per_500m);
        if (pace && (pace < 55 || pace > 900)) { cs.avg_pace_s_per_500m = null; nulledValues++; }
        return cs;
      });
      cleaned.set(w.id, { workout: cw, splits });
    }
    ctx.cleaned = cleaned;
    return { workouts: cleaned.size, nulledValues };
  },
};
