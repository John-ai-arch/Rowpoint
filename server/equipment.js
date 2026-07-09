// Equipment management (vision #8): the athlete's gear log — ergs, HR monitors,
// boats, oars, shoes — with maintenance and battery-reminder notes, plus
// per-erg usage totals derived from workouts.machine_id (no duplicate storage).
import { Router } from 'express';
import { db } from './db.js';
import { authRequired } from './middleware.js';
import { uuid, now, badRequest, ApiError } from './util.js';

export const equipmentRouter = Router();
equipmentRouter.use(authRequired);

const TYPES = ['erg', 'hrm', 'boat', 'oars', 'shoes', 'other'];

function present(e) {
  return {
    id: e.id, type: e.type, name: e.name, brand: e.brand, model: e.model, serial: e.serial,
    machineId: e.machine_id, purchasedOn: e.purchased_on, batteryChangedOn: e.battery_changed_on,
    maintenanceNote: e.maintenance_note, retired: !!e.retired, createdAt: e.created_at,
  };
}

// Per-BLE-machine usage from the workout history (meters, sessions, last used).
function machineUsage(userId) {
  return db.prepare(
    `SELECT machine_id AS machineId, machine_type AS machineType,
            COUNT(*) AS sessions, ROUND(COALESCE(SUM(total_distance_m),0)) AS meters,
            MAX(started_at) AS lastUsed
     FROM workouts WHERE user_id = ? AND machine_id IS NOT NULL
     GROUP BY machine_id ORDER BY meters DESC`).all(userId);
}

equipmentRouter.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM equipment WHERE user_id = ? ORDER BY retired, type, created_at DESC').all(req.user.id);
  res.json({ equipment: rows.map(present), machineUsage: machineUsage(req.user.id) });
});

function readBody(b) {
  if (b.type && !TYPES.includes(b.type)) throw badRequest('Unknown equipment type.', 'bad_type');
  const s = (v, n = 120) => (v === undefined || v === null ? null : String(v).slice(0, n) || null);
  return {
    type: b.type, name: s(b.name), brand: s(b.brand), model: s(b.model), serial: s(b.serial, 80),
    machine_id: s(b.machineId, 120), purchased_on: s(b.purchasedOn, 20),
    battery_changed_on: s(b.batteryChangedOn, 20), maintenance_note: s(b.maintenanceNote, 1000),
  };
}

equipmentRouter.post('/', (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.type) throw badRequest('Name and type are required.', 'missing_field');
  const f = readBody(b);
  const id = uuid();
  db.prepare(`INSERT INTO equipment
      (id, user_id, type, name, brand, model, serial, machine_id, purchased_on,
       battery_changed_on, maintenance_note, retired, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)`)
    .run(id, req.user.id, f.type, f.name, f.brand, f.model, f.serial, f.machine_id,
      f.purchased_on, f.battery_changed_on, f.maintenance_note, now(), now());
  res.status(201).json({ equipment: present(db.prepare('SELECT * FROM equipment WHERE id = ?').get(id)) });
});

equipmentRouter.patch('/:id', (req, res) => {
  const e = db.prepare('SELECT * FROM equipment WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!e) throw new ApiError(404, 'Equipment not found.', 'not_found');
  const b = req.body || {};
  const f = readBody({ type: b.type ?? e.type, ...b });
  const retired = b.retired !== undefined ? (b.retired ? 1 : 0) : e.retired;
  db.prepare(`UPDATE equipment SET type=?, name=COALESCE(?,name), brand=?, model=?, serial=?,
      machine_id=?, purchased_on=?, battery_changed_on=?, maintenance_note=?, retired=?, updated_at=?
      WHERE id=?`)
    .run(f.type, f.name, f.brand, f.model, f.serial, f.machine_id, f.purchased_on,
      f.battery_changed_on, f.maintenance_note, retired, now(), e.id);
  res.json({ equipment: present(db.prepare('SELECT * FROM equipment WHERE id = ?').get(e.id)) });
});

equipmentRouter.delete('/:id', (req, res) => {
  const e = db.prepare('SELECT id FROM equipment WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!e) throw new ApiError(404, 'Equipment not found.', 'not_found');
  db.prepare('DELETE FROM equipment WHERE id = ?').run(e.id);
  res.json({ ok: true });
});
