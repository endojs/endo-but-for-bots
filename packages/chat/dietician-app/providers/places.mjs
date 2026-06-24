// providers/places.mjs — the ONLY impure dependency on Google: the Places API (New) text search + geocode.
// Mirrors voice-agent/brave-search.mjs cap-hygiene EXACTLY: the API key is read server-side from our named
// secret registry (getSecret('google-places-api-key'), env GOOGLE_PLACES_API_KEY first — the same var the
// persona's sweep.py read), put into the X-Goog-Api-Key HEADER, and NEVER returned to the program/agent/LLM/
// client. Callers get results only. This file is what replaces the persona's ~/.env + SSH: same Google call,
// now in-process. Plain node (no Endo/harden) so it's headless-testable.
import { getSecret } from '../../voice-agent/asks-store.mjs';

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = 'places.id,places.displayName,places.formattedAddress,places.businessStatus,places.location,places.primaryType,places.outdoorSeating';
const GEO_MASK = 'places.displayName,places.location,places.formattedAddress,places.types';

// env GOOGLE_PLACES_API_KEY → named vault 'google-places-api-key'. Never logged, never returned.
const getKey = () => {
  if (process.env.GOOGLE_PLACES_API_KEY) return process.env.GOOGLE_PLACES_API_KEY.trim();
  return getSecret('google-places-api-key');
};

const NO_KEY = 'no Google Places key yet. Raise an in-chat SECRET ask whose key is "google-places-api-key" (e.g. {q:"Your Google Places API key", type:"secret", key:"google-places-api-key"}) so dan can paste it securely — it lands in the key vault and the sweep works immediately. (Keys: Google Cloud → Places API (New).)';

const post = async (mask, body) => {
  const key = getKey();
  if (!key) return { ok: false, error: NO_KEY };
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': mask },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) return { ok: false, error: `Places ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}` };
    return { ok: true, json: await r.json() };
  } catch (e) { return { ok: false, error: e.message }; }
};

const mapPlace = p => ({
  place_id: p.id,
  name: (p.displayName && p.displayName.text) || '',
  address: p.formattedAddress || '',
  lat: p.location && p.location.latitude,
  lng: p.location && p.location.longitude,
  primary_type: p.primaryType || '',
  outdoor_seating: p.outdoorSeating ?? null,
});

// the sweep's per-query call: textQuery biased to a circle (center + radius m). Returns mapped places.
export const searchText = async (query, { center, radius } = {}) => {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'empty query' };
  const r = await post(FIELD_MASK, { textQuery: q, maxResultCount: 20, locationBias: { circle: { center, radius: Number(radius) } } });
  if (!r.ok) return r;
  return { ok: true, query: q, places: ((r.json && r.json.places) || []).map(mapPlace) };
};

// geocode a city NAME → its center (for addCity). Reuses the SAME Places API + key — no separate Geocoding
// API to enable. Picks the first locality/administrative result so a business named like the city can't win.
export const geocode = async cityName => {
  const q = String(cityName || '').trim();
  if (!q) return { ok: false, error: 'empty city name' };
  const r = await post(GEO_MASK, { textQuery: q, maxResultCount: 5 });
  if (!r.ok) return r;
  const ps = (r.json && r.json.places) || [];
  const isLocality = p => (p.types || []).some(t => /^(locality|administrative_area_level_[123]|political|postal_town|sublocality)/.test(t));
  const pick = ps.find(isLocality) || ps[0];
  if (!pick) return { ok: false, error: `no place found for "${q}"` };
  return {
    ok: true,
    name: (pick.displayName && pick.displayName.text) || q,
    lat: pick.location && pick.location.latitude,
    lng: pick.location && pick.location.longitude,
    address: pick.formattedAddress || '',
    types: pick.types || [],
  };
};

// whether a key is available (for status/onboarding UIs) — boolean only, never the value.
export const hasKey = () => !!getKey();
