import { firebaseConfig } from './firebase-config.js';

const REST_BASE = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents:runQuery?key=${firebaseConfig.apiKey}`;
const CACHE_TTL_MS = 15000;
const cache = new Map();

function decodeValue(value) {
  if (!value || typeof value !== 'object') return null;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('booleanValue' in value) return Boolean(value.booleanValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('nullValue' in value) return null;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in value) return decodeFields(value.mapValue.fields || {});
  return null;
}

function decodeFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]));
}

export function stripPublicPersonMedia(person = {}) {
  const { photoData, photo, photoUrl, imageData, avatar, ...safePerson } = person;
  return safePerson;
}

export async function fetchPublicCollectionFields(collectionId, fieldPaths, { orderBy = '__name__' } = {}) {
  const key = JSON.stringify({ collectionId, fieldPaths, orderBy });
  const cached = cache.get(key);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) return cached.rows;
  const body = {
    structuredQuery: {
      from: [{ collectionId }],
      select: { fields: fieldPaths.map(fieldPath => ({ fieldPath })) },
      orderBy: [{ field: { fieldPath: orderBy }, direction: 'ASCENDING' }]
    }
  };
  const response = await fetch(REST_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`Unable to fetch ${collectionId} public fields (${response.status})`);
  const payload = await response.json();
  const rows = payload.filter(item => item.document).map(item => {
    const nameParts = String(item.document.name || '').split('/');
    return { id: nameParts[nameParts.length - 1], ...decodeFields(item.document.fields || {}) };
  }).map(stripPublicPersonMedia);
  cache.set(key, { time: Date.now(), rows });
  return rows;
}
