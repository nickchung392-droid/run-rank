import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceMeters, runXP, getProgress, getMilestones, weeklyStats, validateRun, validateBackup, formatDuration, formatPace } from '../dist/engine.mjs';

const activity = (changes = {}) => ({ id: 'run-1', title: 'Park run', date: '2026-10-20T08:00:00.000Z', distanceKm: 3, durationSec: 1200, source: 'manual', notes: '', route: [], ...changes });

test('XP rewards completion and distance; zero and invalid runs earn nothing', () => {
  assert.equal(runXP(activity()), 350);
  assert.equal(runXP(activity({ distanceKm: 0.29 })), 79);
  assert.equal(runXP(activity({ distanceKm: 0 })), 0);
  assert.equal(runXP(activity({ durationSec: Infinity })), 0);
  assert.equal(runXP(activity({ distanceKm: NaN })), 0);
  assert.equal(runXP(activity({ distanceKm: Number.MAX_VALUE })), 0);
});

test('level and game rank thresholds have no off-by-one error', () => {
  assert.deepEqual(getProgress([]), { totalXP: 0, level: 1, levelXP: 0, nextLevelXP: 500, progressPct: 0, rank: 'Trailhead', totalKm: 0, totalRuns: 0, totalSeconds: 0 });
  assert.equal(getProgress([activity({ distanceKm: 4.49 })]).levelXP, 499);
  const atLevel = getProgress([activity({ distanceKm: 4.5 })]);
  assert.equal(atLevel.level, 2);
  assert.equal(atLevel.levelXP, 0);
  assert.equal(atLevel.rank, 'Strider');
  for (const [xp, rank] of [[1500, 'Pathfinder'], [3500, 'Explorer'], [7000, 'Vanguard'], [12000, 'Legend']]) {
    assert.equal(getProgress([activity({ distanceKm: (xp - 50) / 100 })]).rank, rank);
  }
});

test('milestones recognize consistency and distance, independent of speed', () => {
  const runs = Array.from({ length: 5 }, (_, i) => activity({ id: String(i), distanceKm: 2, durationSec: 1800 }));
  const milestones = getMilestones(runs);
  assert.equal(milestones.find(m => m.id === 'five-runs').unlocked, true);
  assert.equal(milestones.find(m => m.id === 'ten-km').unlocked, true);
  assert.equal(milestones.find(m => m.id === 'five-km').unlocked, false);
  assert.equal(getMilestones([activity({ distanceKm: 5 })]).find(m => m.id === 'five-km').unlocked, true);
});

test('Monday-based weeks cross year boundaries using local calendar days', () => {
  const localRun = (day, km) => activity({ date: new Date(2025, 11, day, 12).toISOString(), distanceKm: km });
  const stats = weeklyStats([localRun(28, 9), localRun(29, 2), localRun(31, 3), localRun(32, 4), localRun(35, 6), localRun(36, 8)], new Date(2026, 0, 1, 12));
  assert.equal(stats.days[0].date, '2025-12-29');
  assert.equal(stats.days[6].date, '2026-01-04');
  assert.equal(stats.distanceKm, 15);
  assert.equal(stats.runCount, 4);
});

test('Sunday remains in the current Monday-based week', () => {
  assert.equal(weeklyStats([], new Date(2026, 9, 25, 23, 59)).days[0].date, '2026-10-19');
});

test('calendar weeks retain seven unique days across a daylight-saving transition', () => {
  const stats = weeklyStats([], new Date(2026, 2, 8, 23, 59));
  assert.deepEqual(stats.days.map(day => day.date), ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08']);
});

test('validates leap days, timezone-qualified dates, ranges, and scalar types', () => {
  assert.equal(validateRun(activity({ date: '2024-02-29' })).date, new Date(2024, 1, 29, 12).toISOString());
  assert.equal(validateRun(activity({ date: '2026-10-20T08:00:00+08:00' })).date, '2026-10-20T00:00:00.000Z');
  for (const date of ['2026-02-29', '2026-04-31', 'October 20 2026', '2026-10-20T08:00:00', '2026-10-20T24:00Z', '2026-10-20T08:00+14:30']) {
    assert.throws(() => validateRun(activity({ date })), undefined, date);
  }
  for (const distanceKm of [NaN, Infinity, -1, 0, 1001, '3']) assert.throws(() => validateRun(activity({ distanceKm })));
  for (const durationSec of [NaN, Infinity, 0, 604801]) assert.throws(() => validateRun(activity({ durationSec })));
  assert.throws(() => validateRun(activity({ id: '' })));
  assert.throws(() => validateRun(activity({ source: 'strava' })));
});

test('preserves separate route segments and checks coordinate/time validity', () => {
  const route = [
    { lat: 25, lng: 121, t: 1, segment: 0 },
    { lat: 25.001, lng: 121, t: 2, segment: 0 },
    { lat: 25.1, lng: 121.1, t: 100, segment: 1 },
  ];
  assert.deepEqual(validateRun(activity({ route })).route, route);
  assert.throws(() => validateRun(activity({ route: [{ lat: 91, lng: 0, t: 1 }] })));
  assert.throws(() => validateRun(activity({ route: [{ lat: 0, lng: 0, t: NaN }] })));
  assert.throws(() => validateRun(activity({ route: [route[1], route[0]] })));
  assert.throws(() => validateRun(activity({ route: [{ ...route[0], segment: 2 }, route[2]] })));
});

test('backup rejects duplicates, unknown formats, and invalid goals while dropping extra properties', () => {
  const backup = { version: 1, profile: { name: '  Runner  ', weeklyGoal: 10, extra: true }, runs: [activity()], extra: true };
  const clean = validateBackup(backup);
  assert.deepEqual(clean.profile, { name: 'Runner', weeklyGoal: 10 });
  assert.equal(clean.extra, undefined);
  assert.throws(() => validateBackup({ ...backup, version: 2 }));
  assert.throws(() => validateBackup({ ...backup, runs: [activity(), activity()] }));
  assert.throws(() => validateBackup({ ...backup, profile: { name: 'Runner', weeklyGoal: Infinity } }));
  assert.throws(() => validateBackup({ ...backup, runs: new Array(10001) }));
});

test('haversine distance remains finite at zero, poles, and the dateline', () => {
  assert.equal(distanceMeters({ lat: 25, lng: 121 }, { lat: 25, lng: 121 }), 0);
  assert.ok(Math.abs(distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) - 111194.9266) < 0.1);
  assert.ok(distanceMeters({ lat: 0, lng: 179.999 }, { lat: 0, lng: -179.999 }) < 223);
  assert.ok(Number.isFinite(distanceMeters({ lat: 90, lng: 0 }, { lat: -90, lng: 180 })));
  assert.throws(() => distanceMeters({ lat: NaN, lng: 0 }, { lat: 1, lng: 1 }));
});

test('duration and pace formatting handle carry and invalid metrics', () => {
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(61), '01:01');
  assert.equal(formatDuration(3601), '1:00:01');
  assert.equal(formatDuration(NaN), '00:00');
  assert.equal(formatPace(1799, 5), '6:00');
  assert.equal(formatPace(1800, 0), '—');
  assert.equal(formatPace(Infinity, 3), '—');
  assert.equal(formatPace(1, Number.MIN_VALUE), '—');
});
