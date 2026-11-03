import { distanceMeters } from './engine.mjs';

const SESSION_KEY = 'runrank.active.v1';
const MAX_POINTS = 50000;
const freshState = () => ({ status: 'idle', distanceKm: 0, durationSec: 0, route: [], startedAt: null, accuracy: null, message: 'Ready when you are.' });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const validPoint = p => p && finite(p.lat) && Math.abs(p.lat) <= 90 && finite(p.lng) && Math.abs(p.lng) <= 180 && finite(p.t) && p.t > 0;

function trackTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value || '');
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second, zone] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (Number(year) < 1970 || Number(year) > 2100 || date.getUTCFullYear() !== Number(year) ||
      date.getUTCMonth() + 1 !== Number(month) || date.getUTCDate() !== Number(day) ||
      Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return NaN;
  if (zone !== 'Z') {
    const [hours, minutes] = zone.slice(1).split(':').map(Number);
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return NaN;
  }
  return Date.parse(value);
}

/** Foreground-only recorder. finish() retains the paused session until discard(). */
export class RunTracker {
  constructor({ onUpdate = () => {}, onNotice = () => {} } = {}) {
    this.onUpdate = onUpdate;
    this.onNotice = onNotice;
    this.state = freshState();
    this._elapsedMs = 0;
    this._activeSince = null;
    this._watchId = null;
    this._timer = null;
    this._wakeLock = null;
    this._generation = 0;
    this._lastFixAt = null;
    this._lastTimestamp = null;
    this._segment = 0;
    this._lastAccepted = null;
    this._storageWarned = false;
    this._restore();
    this._visibilityHandler = () => {
      if (globalThis.document?.visibilityState === 'hidden' && ['recording', 'acquiring'].includes(this.state.status)) {
        this.pause('Paused because the app left the screen. Keep Run Rank open and your screen unlocked, then tap Resume.');
      }
    };
    this._unloadHandler = () => {
      if (['recording', 'acquiring'].includes(this.state.status)) this.pause('Your run was saved as paused. Tap Resume when you are ready.');
      else this._persist();
    };
    globalThis.document?.addEventListener('visibilitychange', this._visibilityHandler);
    globalThis.addEventListener?.('pagehide', this._unloadHandler);
  }

  snapshot() {
    const activeMs = this._activeSince === null ? 0 : Math.max(0, Date.now() - this._activeSince);
    return { ...this.state, durationSec: Math.floor((this._elapsedMs + activeMs) / 1000), route: this.state.route.slice() };
  }

  start() {
    if (this.state.status !== 'idle') {
      this.onNotice('A run is already in progress. Resume it, save it, or discard it first.');
      return false;
    }
    this.state = freshState();
    this._elapsedMs = 0;
    this._segment = 0;
    return this._acquire();
  }

  resume() {
    if (this.state.status !== 'paused') return false;
    this._segment += 1;
    return this._acquire();
  }

  _acquire() {
    if (!globalThis.navigator?.geolocation) {
      this.state.status = 'paused';
      this.state.message = 'GPS is not available in this browser. Use Safari over HTTPS, or add your run manually.';
      this._emit();
      this.onNotice(this.state.message);
      return false;
    }
    if (globalThis.document?.visibilityState === 'hidden') {
      this.state.status = 'paused';
      this.state.message = 'Open Run Rank on screen to begin recording.';
      this._emit();
      return false;
    }
    this._stopWatch();
    this.state.status = 'acquiring';
    this.state.message = 'Finding a GPS signal. Step outside and allow location access.';
    this.state.accuracy = null;
    this._lastAccepted = null;
    this._lastFixAt = null;
    this._lastTimestamp = null;
    this._activeSince = null;
    const generation = ++this._generation;
    this._emit();
    try {
      this._watchId = navigator.geolocation.watchPosition(
        position => { if (generation === this._generation) this._position(position); },
        error => { if (generation === this._generation) this._error(error); },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
      );
    } catch {
      this.pause('Location access could not start. Open this app in Safari, allow location access, and try again.');
      return false;
    }
    this._timer = setInterval(() => {
      if (this.state.status === 'recording' && this._lastFixAt && Date.now() - this._lastFixAt > 30000) {
        this.pause('GPS signal lost. Recording is paused. Move to an open area and tap Resume.');
      } else this._emit();
    }, 1000);
    this._requestWakeLock(generation);
    return true;
  }

  _position(position) {
    if (!['acquiring', 'recording'].includes(this.state.status)) return;
    const { latitude: lat, longitude: lng, accuracy } = position.coords ?? {};
    const t = position.timestamp;
    if (!validPoint({ lat, lng, t }) || !finite(accuracy) || accuracy < 0) return;
    if (t < Date.now() - 15000 || t > Date.now() + 5000 || (this._lastTimestamp !== null && t <= this._lastTimestamp)) return;
    this._lastTimestamp = t;
    this.state.accuracy = Math.round(accuracy);
    if (accuracy > 50) {
      this.state.message = `GPS accuracy is ±${Math.round(accuracy)} m. Waiting for a clearer signal.`;
      this._emit();
      return;
    }
    const now = Date.now();
    if (this._lastFixAt && now - this._lastFixAt > 30000) {
      this.pause('GPS signal was interrupted. Recording is paused; tap Resume to start a new route segment.');
      return;
    }
    const point = { lat, lng, t, segment: this._segment };
    if (this.state.status === 'acquiring') {
      this.state.status = 'recording';
      this.state.startedAt ||= new Date(now).toISOString();
      this._activeSince = now;
      this._lastFixAt = now;
      this._lastAccepted = point;
      this.state.route.push(point);
    } else {
      const previous = this._lastAccepted;
      const meters = previous ? distanceMeters(previous, point) : 0;
      const seconds = previous ? (t - previous.t) / 1000 : 0;
      if (previous && meters / seconds > 12) {
        this.state.message = 'GPS jump ignored. Waiting for a stable location.';
        this._emit();
        return;
      }
      this._lastFixAt = now;
      if (!previous || meters >= 3) {
        if (this.state.route.length >= MAX_POINTS) {
          this.pause('This recording has reached its route limit. Save this run before starting another.');
          return;
        }
        this.state.distanceKm += meters / 1000;
        this.state.route.push(point);
        this._lastAccepted = point;
      }
    }
    this.state.message = `Recording · GPS accuracy ±${Math.round(accuracy)} m`;
    this._emit();
  }

  _error(error) {
    const messages = {
      1: 'Location permission was denied. Allow location for this site in Safari settings, then tap Resume. You can also log a run manually.',
      2: 'Your location is unavailable. Step outside or check Location Services, then tap Resume.',
      3: 'GPS took too long to respond. Move to an open area, then tap Resume.'
    };
    this.pause(messages[error?.code] || 'GPS recording was interrupted. Check location access, then tap Resume.');
  }

  pause(reason = 'Run paused. Take your time.') {
    if (this.state.status === 'idle') return this.snapshot();
    if (this._activeSince !== null) {
      this._elapsedMs += Math.max(0, Date.now() - this._activeSince);
      this._activeSince = null;
    }
    this.state.durationSec = Math.floor(this._elapsedMs / 1000);
    this.state.status = 'paused';
    this.state.message = reason;
    this._stopWatch();
    this._emit();
    if (reason !== 'Run paused. Take your time.') this.onNotice(reason);
    return this.snapshot();
  }

  finish() {
    if (this.state.status !== 'idle') this.pause('Run finished. Review and save your activity.');
    return this.snapshot();
  }

  discard() {
    this._stopWatch();
    this.state = freshState();
    this._elapsedMs = 0;
    this._activeSince = null;
    this._lastAccepted = null;
    this._segment = 0;
    try { globalThis.sessionStorage?.removeItem(SESSION_KEY); } catch { /* UI still remains usable. */ }
    this.onUpdate(this.snapshot());
  }

  destroy() {
    if (this.state.status !== 'idle') this.pause();
    this._stopWatch();
    globalThis.document?.removeEventListener('visibilitychange', this._visibilityHandler);
    globalThis.removeEventListener?.('pagehide', this._unloadHandler);
  }

  _stopWatch() {
    this._generation += 1;
    if (this._watchId !== null) globalThis.navigator?.geolocation?.clearWatch(this._watchId);
    this._watchId = null;
    if (this._timer !== null) clearInterval(this._timer);
    this._timer = null;
    const lock = this._wakeLock;
    this._wakeLock = null;
    if (lock) Promise.resolve(lock.release()).catch(() => {});
  }

  async _requestWakeLock(generation) {
    if (!globalThis.navigator?.wakeLock?.request) return;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (generation !== this._generation || !['recording', 'acquiring'].includes(this.state.status)) await lock.release();
      else this._wakeLock = lock;
    } catch { /* Foreground requirement remains visible in the recording UI. */ }
  }

  _emit() {
    this._persist();
    this.onUpdate(this.snapshot());
  }

  _persist() {
    if (this.state.status === 'idle') return;
    try {
      globalThis.sessionStorage?.setItem(SESSION_KEY, JSON.stringify({ version: 1, ...this.snapshot() }));
    } catch {
      if (!this._storageWarned) {
        this._storageWarned = true;
        this.onNotice('This browser could not save a recovery copy. Keep this tab open until you save your run.');
      }
    }
  }

  _restore() {
    try {
      const raw = globalThis.sessionStorage?.getItem(SESSION_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved.version !== 1 || !finite(saved.distanceKm) || saved.distanceKm < 0 || saved.distanceKm > 1000 ||
          !finite(saved.durationSec) || saved.durationSec < 0 || saved.durationSec > 604800 ||
          !Array.isArray(saved.route) || saved.route.length > MAX_POINTS || !saved.route.every(validPoint) ||
          (saved.startedAt && !Number.isFinite(Date.parse(saved.startedAt)))) throw new Error('Invalid recovery data');
      this.state = { ...freshState(), status: 'paused', distanceKm: saved.distanceKm, durationSec: saved.durationSec,
        route: saved.route.map(p => ({ lat: p.lat, lng: p.lng, t: p.t, segment: Number.isInteger(p.segment) && p.segment >= 0 ? p.segment : 0 })),
        startedAt: saved.startedAt || null, message: 'Recovered your unfinished run. It is paused; tap Resume when you are ready.' };
      this._elapsedMs = saved.durationSec * 1000;
      this._segment = this.state.route.reduce((max, p) => Math.max(max, p.segment), 0);
    } catch {
      try { globalThis.sessionStorage?.removeItem(SESSION_KEY); } catch { /* unavailable storage */ }
    }
  }
}

/** Import timed GPX tracks without connecting separate segments or missing points. */
export function parseGPX(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) throw new Error('Choose a GPX file containing a recorded run.');
  if (xmlText.length > 10 * 1024 * 1024) throw new Error('This GPX file is too large. Choose a file smaller than 10 MB.');
  if (/<!DOCTYPE|<!ENTITY/i.test(xmlText)) throw new Error('This file contains unsupported XML declarations. Export a standard GPX file and try again.');
  if (typeof DOMParser === 'undefined') throw new Error('GPX import requires a browser.');
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror') || doc.documentElement?.localName !== 'gpx') throw new Error('This is not a valid GPX file. Export your activity as GPX and try again.');
  const tracks = Array.from(doc.getElementsByTagNameNS('*', 'trk'));
  if (!tracks.length) throw new Error('No recorded track was found. Choose a GPX activity file, or add distance and time manually.');
  const route = [];
  let segmentIndex = 0;
  let distance = 0;
  let duration = 0;
  let firstTime = null;
  let lastTime = null;
  for (const track of tracks) {
    for (const segment of Array.from(track.getElementsByTagNameNS('*', 'trkseg'))) {
      let previous = null;
      for (const element of Array.from(segment.children).filter(el => el.localName === 'trkpt')) {
        if (route.length >= MAX_POINTS) throw new Error('This GPX file contains too many route points. Export a simplified activity and try again.');
        const latText = element.getAttribute('lat');
        const lngText = element.getAttribute('lon');
        const timeText = Array.from(element.children).find(el => el.localName === 'time')?.textContent?.trim();
        const point = { lat: Number(latText), lng: Number(lngText), t: trackTimestamp(timeText), segment: segmentIndex };
        if (!latText?.trim() || !lngText?.trim() || !validPoint(point)) throw new Error('The GPX file has missing coordinates or timestamps. Add this run manually with its distance and time.');
        if (lastTime !== null && point.t <= lastTime) throw new Error('The GPX timestamps are out of order. Export one activity with increasing timestamps, or add the run manually.');
        if (point.t > Date.now() + 60000) throw new Error('This GPX activity has a future timestamp. Check the file or add the run manually.');
        if (previous) {
          const seconds = (point.t - previous.t) / 1000;
          const meters = distanceMeters(previous, point);
          if (meters / seconds > 15) throw new Error('This track contains a GPS jump or a speed outside a running activity. Add the verified distance and time manually.');
          distance += meters;
          duration += seconds;
        }
        firstTime ??= point.t;
        lastTime = point.t;
        route.push(point);
        previous = point;
      }
      segmentIndex += 1;
    }
  }
  if (route.length < 2 || duration <= 0 || distance <= 0) throw new Error('This GPX file needs at least two timed points with a recorded distance. Add the run manually instead.');
  if (duration > 604800 || distance > 1000000) throw new Error('This GPX file exceeds the size of a single running activity. Export one run and try again.');
  const name = Array.from(tracks[0].children).find(el => el.localName === 'name')?.textContent?.trim();
  return { title: (name || 'Imported run').slice(0, 100), date: new Date(firstTime).toISOString(), distanceKm: distance / 1000,
    durationSec: Math.max(1, Math.round(duration)), route, source: 'gpx' };
}
