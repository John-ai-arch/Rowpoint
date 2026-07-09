// Auto-generated data dictionary (Feature D). Documents every exported field —
// its meaning, unit, type (measured/derived/estimate), collection method, and
// missing-value coding — and stays synchronized with the software because the
// derived-variable definitions are read straight out of the computation engine
// (server/research/variables.js). Ships with every export for reproducibility.
import { computeResearchVariables } from './variables.js';
import { QUALITY_FLAG_DOCS } from './quality.js';
import { config } from '../config.js';

// Raw per-workout columns (the source measurements + provenance). Explicit
// because these are stored, not computed.
const RAW_FIELDS = {
  research_id: { type: 'identifier', unit: null, method: 'HMAC pseudonym of the account id under a dedicated secret', definition: 'Stable pseudonymous participant id. NOT linkable to an account, name, or email.' },
  study_tag: { type: 'measured', unit: null, method: 'assigned at contribution', definition: 'Study/experiment this record belongs to.' },
  started_at: { type: 'measured', unit: 'unix_seconds_utc', method: 'device clock', definition: 'Workout start time (UTC).' },
  tz_offset_min: { type: 'measured', unit: 'minutes', method: 'client', definition: 'Local timezone offset from UTC at capture.' },
  total_distance_m: { type: 'measured', unit: 'm', method: 'erg/monitor or manual entry', definition: 'Total distance rowed.' },
  total_time_s: { type: 'measured', unit: 's', method: 'erg/monitor or manual entry', definition: 'Total elapsed time.' },
  avg_split_s: { type: 'measured', unit: 's/500m', method: 'erg/monitor', definition: 'Average 500 m split.' },
  avg_stroke_rate: { type: 'measured', unit: 'spm', method: 'erg/monitor', definition: 'Average stroke rate.' },
  avg_heart_rate: { type: 'measured', unit: 'bpm', method: 'BLE HR strap (SIG HRM)', definition: 'Average heart rate (when recorded).' },
  avg_power_watts: { type: 'measured', unit: 'W', method: 'erg/monitor', definition: 'Average power (when recorded).' },
  device_type: { type: 'measured', unit: null, method: 'client user-agent bucket', definition: 'Coarse client platform: web | ios | android.' },
  sensor_source: { type: 'measured', unit: null, method: 'client', definition: 'How the workout was measured: ble_pm | ble_ftms | hr_strap | manual.' },
  sw_version: { type: 'measured', unit: null, method: 'server', definition: 'Software version that produced the record.' },
  schema_version: { type: 'measured', unit: null, method: 'server', definition: 'Research schema version at write time.' },
  measurement_confidence: { type: 'derived', unit: '0..1', method: 'share of core measures present', definition: 'Data-completeness score for the record.' },
  missing_flags: { type: 'derived', unit: 'list', method: 'automatic', definition: 'Which core measures were absent.' },
  quality_flags: { type: 'derived', unit: 'list', method: 'automatic QC', definition: 'Quality-control flags (see qualityFlags).' },
  age_range: { type: 'measured', unit: 'band', method: 'consented, coarsened', definition: 'Broad age band (e.g. 25-34). Only present with demographics consent.' },
  sex: { type: 'measured', unit: null, method: 'consented, optional', definition: 'Self-reported biological sex. Optional.' },
  weight_class: { type: 'measured', unit: null, method: 'consented', definition: 'Lightweight / heavyweight / openweight.' },
  height_band_cm: { type: 'measured', unit: 'cm (5 cm band)', method: 'consented, coarsened', definition: 'Height rounded to a 5 cm band.' },
  years_rowing: { type: 'measured', unit: 'years', method: 'consented', definition: 'Self-reported years of rowing.' },
  competition_level: { type: 'measured', unit: null, method: 'consented', definition: 'Recreational … elite.' },
  club_type: { type: 'measured', unit: null, method: 'consented', definition: 'Community / school / university / masters / national / none.' },
  training_environment: { type: 'measured', unit: null, method: 'consented', definition: 'Erg / water / mixed.' },
  country: { type: 'measured', unit: null, method: 'consented', definition: 'Country (coarse).' },
};

/** Read the derived-variable definitions straight from the engine (stays in sync). */
function derivedVariableDictionary() {
  const nowS = 8 * 86400;
  const sample = [
    { started_at: 0, total_distance_m: 2000, total_time_s: 480, avg_split_s: 120, avg_stroke_rate: 24, avg_heart_rate: 150, hr_zones_json: JSON.stringify({ zoneSeconds: [120, 120, 60, 20, 10] }) },
    { started_at: 7 * 86400, total_distance_m: 6000, total_time_s: 1500, avg_split_s: 125, avg_stroke_rate: 22, avg_heart_rate: 145, hr_zones_json: JSON.stringify({ zoneSeconds: [400, 300, 100, 30, 10] }) },
  ];
  const vars = computeResearchVariables(sample, nowS);
  const out = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v && typeof v === 'object' && 'type' in v) out[k] = { type: v.type, unit: v.unit, definition: v.definition };
  }
  return out;
}

export function dataDictionary() {
  return {
    softwareVersion: config.softwareVersion,
    researchSchemaVersion: config.researchSchemaVersion,
    generatedAt: Math.floor(Date.now() / 1000),
    missingValueCoding: 'Empty cell / null = not measured or not consented. List fields use "|" as a separator; an empty list means none.',
    valueTypes: {
      measured: 'A direct reading from the device or the participant.',
      derived: 'Computed from measured values by a documented formula.',
      estimate: 'A heuristic estimate — explicitly NOT a measurement or diagnosis.',
      identifier: 'A pseudonymous grouping key; never linkable to a person.',
    },
    rawWorkoutFields: RAW_FIELDS,
    derivedVariables: derivedVariableDictionary(),
    qualityFlags: QUALITY_FLAG_DOCS,
    limitations: [
      'Observational data: associations do not imply causation.',
      'Self-reported demographics and 2k times are unverified.',
      'Sensor availability varies (HR/power missing on many manual entries) — see missing_flags and measurement_confidence.',
      'Coarsened demographics reduce identifiability but also reduce granularity.',
      'Convenience sample of app users who opted into research — not a random population sample (selection bias).',
    ],
  };
}
