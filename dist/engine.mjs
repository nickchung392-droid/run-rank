// Run Rank's progression rules. Game ranks measure accumulated effort,
// not athletic ability or placement against other runners.
export const RANKS = Object.freeze([
  { name: 'Trailhead', xp: 0 },
  { name: 'Strider', xp: 500 },
  { name: 'Pathfinder', xp: 1500 },
  { name: 'Explorer', xp: 3500 },
  { name: 'Vanguard', xp: 7000 },
  { name: 'Legend', xp: 12000 },
].map(Object.freeze));

export const MILESTONES = Object.freeze([
  { id: 'first-run', title: 'The first step', description: 'Save your first run.', target: 1, unit: 'runs', metric: 'runs' },
  { id: 'five-runs', title: 'Finding your rhythm', description: 'Complete 5 runs, at your own pace.', target: 5, unit: 'runs', metric: 'runs' },
  { id: 'ten-km', title: 'Double digits', description: 'Build up 10 km across your runs.', target: 10, unit: 'km', metric: 'distance' },
  { id: 'five-km', title: 'Going the distance', description: 'Complete a run of at least 5 km.', target: 5, unit: 'km', metric: 'longest' },
  { id: 'fifty-km', title: 'A path of your own', description: 'Accumulate 50 km, one run at a time.', target: 50, unit: 'km', metric: 'distance' },
  { id: 'twenty-runs', title: 'Part of the routine', description: 'Save 20 runs. Every pace counts.', target: 20, unit: 'runs', metric: 'runs' },
  { id: 'ten-km-run', title: 'A little further', description: 'Complete a run of at least 10 km.', target: 10, unit: 'km', metric: 'longest' },
  { id: 'hundred-km', title: 'One hundred strong', description: 'Reach 100 km in your running history.', target: 100, unit: 'km', metric: 'distance' },
].map(Object.freeze));

const finitePositive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
const validMetrics = (run) => run && finitePositive(run.distanceKm) && run.distanceKm <= 1000 && finitePositive(run.durationSec) && run.durationSec <= 604800;
const eligible = (runs) => Array.isArray(runs) ? runs.filter(validMetrics) : [];
const roundedKm = (n) => Math.round(n * 1e6) / 1e6;

export function distanceMeters(a, b) {
  for (const p of [a, b]) {
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) {
      throw new Error('Route coordinates must be valid latitude and longitude values.');
    }
  }
  const radians = Math.PI / 180;
  const lat = (b.lat - a.lat) * radians;
  const lng = (b.lng - a.lng) * radians;
  const h = Math.sin(lat / 2) ** 2 + Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin(lng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(Math.min(1, h)), Math.sqrt(Math.max(0, 1 - h)));
}

export function runXP(run) {
  if (!validMetrics(run)) return 0;
  return 50 + Math.floor(run.distanceKm * 100 + 1e-8);
}

export function getProgress(runs) {
  const activities = eligible(runs);
  const totalXP = activities.reduce((sum, run) => sum + runXP(run), 0);
  const levelXP = totalXP % 500;
  return {
    totalXP,
    level: 1 + Math.floor(totalXP / 500),
    levelXP,
    nextLevelXP: 500,
    progressPct: levelXP / 5,
    rank: [...RANKS].reverse().find((rank) => totalXP >= rank.xp).name,
    totalKm: roundedKm(activities.reduce((sum, run) => sum + run.distanceKm, 0)),
    totalRuns: activities.length,
    totalSeconds: activities.reduce((sum, run) => sum + run.durationSec, 0),
  };
}

export function getMilestones(runs) {
  const activities = eligible(runs);
  const metrics = {
    runs: activities.length,
    distance: roundedKm(activities.reduce((sum, run) => sum + run.distanceKm, 0)),
    longest: activities.reduce((longest, run) => Math.max(longest, run.distanceKm), 0),
  };
  return MILESTONES.map(({ metric, ...milestone }) => ({
    ...milestone,
    value: metrics[metric],
    unlocked: metrics[metric] >= milestone.target,
  }));
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function weeklyStats(runs, now = new Date()) {
  const current = new Date(now);
  if (!Number.isFinite(current.getTime())) throw new Error('Choose a valid week.');
  // Calendar arithmetic preserves local dates through daylight-saving changes.
  current.setHours(12, 0, 0, 0);
  current.setDate(current.getDate() - (current.getDay() + 6) % 7);
  const labels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const days = labels.map((label, index) => {
    const day = new Date(current);
    day.setDate(current.getDate() + index);
    return { date: localDateKey(day), label, km: 0, runs: 0 };
  });
  const byDate = new Map(days.map((day) => [day.date, day]));
  for (const run of eligible(runs)) {
    const date = new Date(run.date);
    if (!Number.isFinite(date.getTime())) continue;
    const day = byDate.get(localDateKey(date));
    if (day) {
      day.km = roundedKm(day.km + run.distanceKm);
      day.runs += 1;
    }
  }
  return {
    days,
    distanceKm: roundedKm(days.reduce((sum, day) => sum + day.km, 0)),
    runCount: days.reduce((sum, day) => sum + day.runs, 0),
  };
}

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
}

function text(value, label, maxLength, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  const clean = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (clean.length > maxLength) throw new Error(`${label} must be ${maxLength} characters or fewer.`);
  return clean || fallback;
}

function parseDate(value) {
  if (typeof value !== 'string') throw new Error('A run needs a valid date.');
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) throw new Error('Use a full ISO date or date and time with a time zone.');
  const [, y, m, d, hh, mm, ss, , zone] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (year < 1970 || year > 2100 || check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error('Choose a valid calendar date between 1970 and 2100.');
  }
  if (hh !== undefined && (Number(hh) > 23 || Number(mm) > 59 || Number(ss || 0) > 59)) throw new Error('Choose a valid time.');
  if (zone && zone !== 'Z') {
    const [zh, zm] = zone.slice(1).split(':').map(Number);
    if (zh > 14 || zm > 59 || (zh === 14 && zm !== 0)) throw new Error('Choose a valid time zone offset.');
  }
  // A date-only entry belongs to that local day, not UTC midnight.
  const parsed = hh === undefined ? new Date(year, month - 1, day, 12) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('Choose a valid run date.');
  return parsed.toISOString();
}

export function validateRun(input) {
  record(input, 'Run');
  const id = text(input.id, 'Run ID', 128);
  if (!id) throw new Error('A run needs a unique ID.');
  const date = parseDate(input.date);
  const distanceKm = input.distanceKm;
  const durationSec = input.durationSec;
  if (!finitePositive(distanceKm) || distanceKm > 1000) throw new Error('Distance must be greater than 0 and no more than 1,000 km.');
  if (!finitePositive(durationSec) || durationSec > 604800) throw new Error('Duration must be greater than 0 and no more than 7 days.');
  const source = input.source ?? 'manual';
  if (!['manual', 'gps', 'gpx'].includes(source)) throw new Error('Run source must be manual, GPS, or GPX.');
  const rawRoute = input.route ?? [];
  if (!Array.isArray(rawRoute) || rawRoute.length > 50000) throw new Error('A route may contain at most 50,000 points.');
  let previousTime = -Infinity;
  let previousSegment = -1;
  const route = rawRoute.map((point) => {
    record(point, 'Route point');
    const { lat, lng, t } = point;
    const segment = point.segment ?? 0;
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180) {
      throw new Error('A route point has invalid coordinates.');
    }
    if (!Number.isFinite(t) || t < 0 || t > 4133980800000) throw new Error('A route point has an invalid timestamp.');
    if (!Number.isInteger(segment) || segment < 0 || segment > 50000 || segment < previousSegment) throw new Error('Route segments must be nonnegative and in order.');
    if (t < previousTime) throw new Error('Route timestamps must be in order.');
    previousTime = t;
    previousSegment = segment;
    return { lat, lng, t, segment };
  });
  return {
    id,
    title: text(input.title, 'Run title', 100, 'Untitled run'),
    date,
    distanceKm,
    durationSec,
    source,
    notes: text(input.notes, 'Run notes', 2000),
    route,
  };
}

export function validateBackup(input) {
  record(input, 'Backup');
  if (input.version !== 1) throw new Error('This backup format is not supported.');
  if (!Array.isArray(input.runs) || input.runs.length > 10000) throw new Error('A backup may contain at most 10,000 runs.');
  record(input.profile, 'Profile');
  const name = text(input.profile.name, 'Profile name', 48, 'Runner');
  const weeklyGoal = input.profile.weeklyGoal;
  if (!finitePositive(weeklyGoal) || weeklyGoal > 1000) throw new Error('Weekly distance goal must be greater than 0 and no more than 1,000 km.');
  const ids = new Set();
  let pointCount = 0;
  const runs = input.runs.map((run) => {
    if (Array.isArray(run?.route)) pointCount += run.route.length;
    if (pointCount > 250000) throw new Error('This backup contains too many route points (maximum 250,000).');
    const clean = validateRun(run);
    if (ids.has(clean.id)) throw new Error('The backup contains duplicate run IDs.');
    ids.add(clean.id);
    return clean;
  });
  return { version: 1, profile: { name, weeklyGoal }, runs };
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor(total % 3600 / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatPace(durationSec, distanceKm) {
  if (!finitePositive(durationSec) || !finitePositive(distanceKm)) return '—';
  const pace = Math.round(durationSec / distanceKm);
  if (!Number.isFinite(pace)) return '—';
  return `${Math.floor(pace / 60)}:${String(pace % 60).padStart(2, '0')}`;
}
