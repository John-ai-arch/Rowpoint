// Stage 2 — sensor validation. Flags physiologically implausible sensor
// readings per workout so cleaning (stage 3) can null exactly those values
// and inference knows which channels to distrust. Flags, not deletions.
export const sensorValidateStage = {
  name: 'sensor-validate',
  version: '1.0',
  run(ctx) {
    const flagsByWorkout = {};
    for (const w of ctx.workouts) {
      const flags = [];
      const hr = Number(w.avg_heart_rate);
      if (hr && (hr < 30 || hr > 230)) flags.push('hr_implausible');
      const maxHr = Number(w.max_heart_rate);
      if (maxHr && (maxHr < 40 || maxHr > 240)) flags.push('hr_max_implausible');
      if (hr && maxHr && hr > maxHr) flags.push('hr_avg_exceeds_max');
      const watts = Number(w.avg_power_watts);
      if (watts && (watts < 0 || watts > 2000)) flags.push('power_implausible');
      const rate = Number(w.avg_stroke_rate);
      if (rate && (rate < 8 || rate > 70)) flags.push('rate_implausible');
      for (const s of ctx.splitsByWorkout.get(w.id) || []) {
        const shr = Number(s.avg_heart_rate);
        if (shr && (shr < 30 || shr > 230)) { flags.push('split_hr_implausible'); break; }
      }
      if (flags.length) flagsByWorkout[w.id] = flags;
    }
    ctx.sensorFlags = flagsByWorkout;
    return { workoutsFlagged: Object.keys(flagsByWorkout).length, flagsByWorkout };
  },
};
