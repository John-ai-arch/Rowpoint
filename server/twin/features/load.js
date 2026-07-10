// Training-load features: session size, relative intensity against the
// athlete's 2k anchor, and a TRIMP-style load score (duration × intensity²)
// that later models (fatigue, optimizer) consume.
import { wattsFromSplit } from './power.js';

export const loadExtractor = {
  name: 'load',
  version: '1.0',
  features: ['duration_min', 'distance_m', 'intensity_factor', 'training_load', 'work_kj'],
  extract({ workout, best2kSeconds, maxHr }) {
    const timeS = Number(workout.total_time_s);
    const dist = Number(workout.total_distance_m);
    if (!(timeS > 0)) return {};
    const minutes = timeS / 60;

    // Relative intensity, best grounding first: pace vs 2k pace, then HR%.
    let intensity = null;
    const avgSplit = Number(workout.avg_split_s);
    if (best2kSeconds > 0 && avgSplit > 0) {
      intensity = (best2kSeconds / 4) / avgSplit; // 1.0 = at 2k pace
    } else if (maxHr > 0 && Number(workout.avg_heart_rate) > 0) {
      intensity = Number(workout.avg_heart_rate) / maxHr;
    }

    // Mechanical work from average power (measured or pace-derived).
    const watts = Number(workout.avg_power_watts) > 0 ? Number(workout.avg_power_watts) : wattsFromSplit(avgSplit);

    return {
      duration_min: minutes,
      distance_m: dist > 0 ? dist : null,
      intensity_factor: intensity,
      training_load: intensity !== null ? minutes * intensity ** 2 * 100 : null,
      work_kj: watts !== null ? (watts * timeS) / 1000 : null,
    };
  },
};
