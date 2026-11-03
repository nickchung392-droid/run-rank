import test from 'node:test';
import assert from 'node:assert/strict';
import { RunTracker, parseGPX } from '../dist/tracker.mjs';

let now = 1800000000000;
const actualNow = Date.now;
Date.now = () => now;
const storage = new Map();
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: key => storage.delete(key)
} });
const listeners = new Map();
globalThis.document = {
  visibilityState: 'visible',
  addEventListener: (name, cb) => listeners.set(name, cb),
  removeEventListener: name => listeners.delete(name)
};
let success;
let failure;
let cleared = 0;
let watchCalls = 0;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { geolocation: {
  watchPosition: (a, b) => { watchCalls += 1; success = a; failure = b; return 1; },
  clearWatch: () => { cleared += 1; }
} } });
const position = (lat = 25, lng = 121, accuracy = 10, timestamp = now) => ({ coords: { latitude: lat, longitude: lng, accuracy }, timestamp });
const reset = () => { storage.clear(); document.visibilityState = 'visible'; now = 1800000000000; };

test('clock starts only on a usable fix; bad fixes and implausible jumps add no distance', () => {
  reset();
  const tracker = new RunTracker();
  tracker.start();
  now += 5000;
  success(position(25, 121, 80));
  assert.equal(tracker.snapshot().status, 'acquiring');
  assert.equal(tracker.snapshot().durationSec, 0);
  now += 1000;
  success(position());
  now += 10000;
  success(position(25.0001));
  assert.equal(tracker.snapshot().status, 'recording');
  assert.equal(tracker.snapshot().durationSec, 10);
  assert.ok(tracker.snapshot().distanceKm > .011 && tracker.snapshot().distanceKm < .012);
  const distance = tracker.snapshot().distanceKm;
  now += 1000;
  success(position(26));
  assert.equal(tracker.snapshot().distanceKm, distance);
  tracker.discard();
  tracker.destroy();
});

test('pause excludes inactive time and resume never bridges the route', () => {
  reset();
  const tracker = new RunTracker();
  tracker.start();
  success(position());
  now += 10000;
  success(position(25.0001));
  tracker.pause();
  const distance = tracker.snapshot().distanceKm;
  now += 3600000;
  assert.equal(tracker.snapshot().durationSec, 10);
  tracker.resume();
  success(position(26));
  assert.equal(tracker.snapshot().distanceKm, distance);
  now += 5000;
  success(position(26.0001));
  assert.equal(tracker.snapshot().durationSec, 15);
  assert.deepEqual(tracker.snapshot().route.map(p => p.segment), [0, 0, 1, 1]);
  tracker.discard();
  tracker.destroy();
});

test('hidden document pauses and reload recovers paused without background time', () => {
  reset();
  const notices = [];
  const tracker = new RunTracker({ onNotice: message => notices.push(message) });
  tracker.start();
  success(position());
  now += 12000;
  success(position(25.0002));
  document.visibilityState = 'hidden';
  listeners.get('visibilitychange')();
  assert.equal(tracker.snapshot().status, 'paused');
  assert.ok(notices.some(message => message.includes('screen')));
  tracker.destroy();
  now += 86400000;
  const recovered = new RunTracker();
  assert.equal(recovered.snapshot().status, 'paused');
  assert.equal(recovered.snapshot().durationSec, 12);
  assert.equal(recovered.snapshot().route.length, 2);
  recovered.discard();
  recovered.destroy();
});

test('permissions and stale positions do not invent activity', () => {
  reset();
  const tracker = new RunTracker();
  tracker.start();
  success(position(25, 121, 10, now - 20000));
  assert.equal(tracker.snapshot().route.length, 0);
  failure({ code: 1 });
  assert.equal(tracker.snapshot().status, 'paused');
  assert.match(tracker.snapshot().message, /permission was denied/);
  assert.equal(tracker.snapshot().durationSec, 0);
  assert.equal(tracker.snapshot().distanceKm, 0);
  assert.ok(cleared > 0);
  tracker.discard();
  tracker.destroy();
});

test('long interruption is paused without connecting a route gap', () => {
  reset();
  const tracker = new RunTracker();
  tracker.start();
  success(position());
  now += 31000;
  success(position(25.001));
  assert.equal(tracker.snapshot().status, 'paused');
  assert.equal(tracker.snapshot().route.length, 1);
  assert.equal(tracker.snapshot().distanceKm, 0);
  tracker.discard();
  tracker.destroy();
});

test('GPX rejects declarations, empty input and oversized input before XML parsing', () => {
  assert.throws(() => parseGPX(''), /Choose a GPX/);
  assert.throws(() => parseGPX('<!DOCTYPE gpx><gpx/>'), /unsupported XML/);
  assert.throws(() => parseGPX('x'.repeat(10 * 1024 * 1024 + 1)), /too large/);
});

test('small movement accumulates from the last accepted point and finish keeps recovery data', () => {
  reset();
  const tracker = new RunTracker();
  tracker.start();
  success(position());
  now += 1000;
  success(position(25.00001));
  assert.equal(tracker.snapshot().distanceKm, 0);
  now += 3000;
  success(position(25.00004));
  assert.ok(tracker.snapshot().distanceKm > .004);
  const finished = tracker.finish();
  assert.equal(finished.status, 'paused');
  assert.ok(storage.has('runrank.active.v1'));
  tracker.discard();
  assert.equal(tracker.snapshot().status, 'idle');
  assert.equal(storage.has('runrank.active.v1'), false);
  tracker.destroy();
});

test('repeated starts and resumes cannot create concurrent GPS watches', () => {
  reset();
  const tracker = new RunTracker();
  const before = watchCalls;
  assert.equal(tracker.start(), true);
  assert.equal(tracker.start(), false);
  assert.equal(tracker.resume(), false);
  assert.equal(watchCalls, before + 1);
  tracker.pause();
  assert.equal(tracker.resume(), true);
  assert.equal(tracker.resume(), false);
  assert.equal(watchCalls, before + 2);
  const empty = tracker.finish();
  assert.equal(empty.distanceKm, 0);
  assert.equal(empty.durationSec, 0);
  tracker.discard();
  tracker.destroy();
});

test('inaccessible session storage does not prevent recording and explains recovery limitation', () => {
  reset();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('Storage blocked'); } });
  const notices = [];
  const tracker = new RunTracker({ onNotice: message => notices.push(message) });
  try {
    tracker.start();
    success(position());
    now += 5000;
    success(position(25.0001));
    assert.equal(tracker.snapshot().status, 'recording');
    assert.ok(notices.some(message => message.includes('recovery copy')));
    assert.equal(notices.filter(message => message.includes('recovery copy')).length, 1);
  } finally {
    tracker.discard();
    tracker.destroy();
    Object.defineProperty(globalThis, 'sessionStorage', descriptor);
  }
});

test.after(() => { Date.now = actualNow; });
