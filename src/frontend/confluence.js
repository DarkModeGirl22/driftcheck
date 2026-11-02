/*
 * Helpers the UI uses to read and write Confluence and Jira as the current user.
 * Text logic (matching, accents, French…) lives in ../lib/text.js, shared with the backend.
 */
import { requestConfluence, requestJira } from '@forge/bridge';
import { decodeEntity, htmlToText, toTicket } from '../lib/text';

export { daysAgo, findRelatedTickets } from '../lib/text';

export const DAYS_BACK = 30;
const DISMISS_KEY = 'driftcheck-dismissed';
const CACHE_KEY = 'driftcheck-cache';
// Bump when the AI prompt changes, so old saved results are not reused.
const CACHE_VERSION = 'v5';

async function json(res, what) {
  if (!res.ok) throw new Error(`Couldn't ${what} (error ${res.status}).`);
  return res.status === 204 ? null : res.json();
}

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

/** Page title, plain text, raw storage HTML and version number. */
export async function fetchPage(pageId) {
  const page = await json(
    await requestConfluence(`/wiki/api/v2/pages/${pageId}?body-format=storage`, {
      headers: { Accept: 'application/json' },
    }),
    'read this page'
  );
  return {
    id: page.id,
    title: page.title || '',
    html: page.body?.storage?.value || '',
    text: htmlToText(page.body?.storage?.value),
    version: page.version?.number,
    updated: page.version?.createdAt,
    link: page._links?.webui ? `/wiki${page._links.webui}` : '',
  };
}

/** Jira tickets that moved to Done in the last DAYS_BACK days (with their last comments). */
export async function fetchRecentDoneTickets() {
  const params = new URLSearchParams({
    jql:
      `statusCategory = Done AND statusCategoryChangedDate >= -${DAYS_BACK}d ` +
      'ORDER BY statusCategoryChangedDate DESC',
    fields: 'summary,description,comment,resolutiondate,statuscategorychangedate',
    maxResults: '50',
  });
  const data = await json(
    await requestJira(`/rest/api/3/search/jql?${params}`, { headers: { Accept: 'application/json' } }),
    'read Jira tickets'
  );
  return (data.issues || []).map(toTicket);
}

/** All pages of a space (first 100), with their text. */
export async function fetchSpacePages(spaceKey) {
  const spaces = await json(
    await requestConfluence(`/wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}`, {
      headers: { Accept: 'application/json' },
    }),
    'read this space'
  );
  const spaceId = spaces.results?.[0]?.id;
  if (!spaceId) throw new Error(`Space ${spaceKey} not found.`);
  const data = await json(
    await requestConfluence(
      `/wiki/api/v2/spaces/${spaceId}/pages?body-format=storage&limit=100&status=current`,
      { headers: { Accept: 'application/json' } }
    ),
    'list the pages of this space'
  );
  return (data.results || []).map((page) => ({
    id: page.id,
    title: page.title || '',
    text: htmlToText(page.body?.storage?.value),
    version: page.version?.number,
    updated: page.version?.createdAt,
    link: page._links?.webui ? `/wiki${page._links.webui}` : '',
  }));
}

/* ---------- page properties (small JSON values stored on the page itself) ---------- */

async function readProperty(pageId, key) {
  const data = await json(
    await requestConfluence(`/wiki/api/v2/pages/${pageId}/properties?key=${key}`, {
      headers: { Accept: 'application/json' },
    }),
    'read page data'
  );
  return data.results?.[0] || null;
}

async function writeProperty(pageId, key, value, existing) {
  if (existing) {
    return json(
      await requestConfluence(`/wiki/api/v2/pages/${pageId}/properties/${existing.id}`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ key, value, version: { number: (existing.version?.number || 1) + 1 } }),
      }),
      'save page data'
    );
  }
  return json(
    await requestConfluence(`/wiki/api/v2/pages/${pageId}/properties`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ key, value }),
    }),
    'save page data'
  );
}

/* ---------- saved results (so the AI only runs again when something changed) ---------- */

/** Identifies one situation: page version + the related tickets and when they finished. */
export function cacheKey(page, related, others = []) {
  const tickets = related.map((t) => `${t.key}@${t.resolved}`).sort().join(',');
  const rest = others.map((t) => t.key).sort().join(',');
  return `${CACHE_VERSION}|${page.version}|${tickets}|${rest}`;
}

/** Recent tickets that are not in "related", trimmed: the AI decides if any matter anyway. */
export function otherTickets(tickets, related) {
  const keys = new Set(related.map((t) => t.key));
  return tickets
    .filter((t) => !keys.has(t.key))
    .slice(0, 40)
    .map((t) => ({
      key: t.key,
      summary: t.summary,
      description: String(t.description || '').slice(0, 1500),
      comments: t.comments || [],
      resolved: t.resolved,
    }));
}

/** Returns saved findings for this exact situation, or null. Never throws. */
export async function readCachedResult(pageId, key) {
  try {
    const property = await readProperty(pageId, CACHE_KEY);
    return property?.value?.key === key ? property.value.findings || [] : null;
  } catch (e) {
    return null;
  }
}

/**
 * The last AI verdict saved for this page, if it still matches the page and the recent tickets:
 * an array of findings (without dismissed ones), or null when the page was never checked
 * (or changed since). Free: no AI call. Never throws.
 */
export async function savedVerdict(page, related, others = []) {
  if (related.length === 0 && others.length === 0) return null; // nothing to check against
  const [findings, dismissed] = await Promise.all([
    readCachedResult(page.id, cacheKey(page, related, others)),
    fetchDismissed(page.id).catch(() => new Set()),
  ]);
  return findings ? findings.filter((f) => !dismissed.has(findingId(f))) : null;
}

/** Saves findings for this situation. Never throws (viewers without edit rights simply don't save). */
export async function saveCachedResult(pageId, key, findings) {
  try {
    const existing = await readProperty(pageId, CACHE_KEY);
    await writeProperty(pageId, CACHE_KEY, { key, findings, at: new Date().toISOString() }, existing);
  } catch (e) {
    // not important
  }
}

/* ---------- Apply fix ---------- */

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const BLOCK_TAG = /<\/?(p|li|ul|ol|h[1-6]|tr|td|th|table|tbody|div|br|ac:)[\s>/]/i;

/**
 * Finds a plain-text sentence inside storage HTML even when formatting (bold, links…)
 * is in the middle of it. Returns { start, end } HTML positions, or null.
 */
export function locateSentence(html, sentence) {
  const chars = []; // visible characters (spaces collapsed, lower-cased)
  const starts = []; // HTML index where each visible character starts
  const ends = []; // HTML index just after it
  let i = 0;
  let lastWasSpace = true;
  const push = (ch, s, e) => {
    const isSpace = /\s/.test(ch);
    if (isSpace && lastWasSpace) return;
    chars.push(isSpace ? ' ' : ch.toLowerCase());
    starts.push(s);
    ends.push(e);
    lastWasSpace = isSpace;
  };
  while (i < html.length) {
    if (html[i] === '<') {
      const close = html.indexOf('>', i);
      if (close === -1) break;
      if (BLOCK_TAG.test(html.slice(i, close + 1))) {
        push(' ', i, i); // a block boundary counts as a space
      }
      i = close + 1;
      continue;
    }
    if (html[i] === '&') {
      const semi = html.indexOf(';', i);
      const entity = semi > i && semi - i < 10 ? html.slice(i, semi + 1) : null;
      if (entity) {
        // "&egrave;" counts as one visible character "è" (or a space if unknown)
        const decoded = decodeEntity(entity) ?? ' ';
        for (const ch of decoded) push(ch === '\u00a0' ? ' ' : ch, i, semi + 1);
        i = semi + 1;
        continue;
      }
    }
    push(html[i], i, i + 1);
    i += 1;
  }
  const visible = chars.join('');
  const needle = sentence.toLowerCase().replace(/\s+/g, ' ').trim();
  const at = visible.indexOf(needle);
  if (at === -1 || visible.indexOf(needle, at + 1) !== -1) return null; // missing or ambiguous
  const start = starts[at];
  const end = ends[at + needle.length - 1];
  if (BLOCK_TAG.test(html.slice(start, end))) return null; // spans two paragraphs: too risky
  return { start, end };
}

/**
 * Replaces the out-of-date sentence with the suggested one and saves a new page version.
 * Formatting tags inside the sentence are kept (empty), so the page stays valid.
 */
export async function applyFix(pageId, finding) {
  const page = await fetchPage(pageId);
  const where = locateSentence(page.html, finding.sentence);
  if (!where) {
    throw new Error("Driftcheck couldn't find this exact sentence on the page anymore. Edit the page by hand.");
  }
  const oldPart = page.html.slice(where.start, where.end);
  const keptTags = (oldPart.match(/<[^>]+>/g) || []).join('');
  const newHtml =
    page.html.slice(0, where.start) + escapeHtml(finding.suggestion) + keptTags + page.html.slice(where.end);
  await json(
    await requestConfluence(`/wiki/api/v2/pages/${pageId}`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        id: pageId,
        status: 'current',
        title: page.title,
        body: { representation: 'storage', value: newHtml },
        version: { number: page.version + 1, message: `Driftcheck: updated after ${finding.ticket}` },
      }),
    }),
    'update the page'
  );
}

/* ---------- "Still correct" (dismissals stored on the page itself) ---------- */

/** Key that identifies one finding, so a dismissal survives future checks. */
export const findingId = (f) => `${f.ticket}::${f.sentence}`;

export async function fetchDismissed(pageId) {
  try {
    const property = await readProperty(pageId, DISMISS_KEY);
    return new Set(property?.value?.items || []);
  } catch (error) {
    return new Set(); // never block the check because of this
  }
}

export async function dismissFinding(pageId, finding) {
  const existing = await readProperty(pageId, DISMISS_KEY);
  const items = new Set(existing?.value?.items || []);
  items.add(findingId(finding));
  await writeProperty(pageId, DISMISS_KEY, { items: [...items] }, existing);
}

/**
 * The whole check for one page, used by the byline box and the dashboard:
 * saved result if nothing changed, otherwise the AI (and the result is saved).
 */
export async function checkPage(page, related, invoke, others = []) {
  if (related.length === 0 && others.length === 0) return { findings: [] };
  const key = cacheKey(page, related, others);
  const cached = await readCachedResult(page.id, key);
  if (cached) return { findings: cached, cached: true };
  const ai = await invoke('analyzeDrift', {
    page: { title: page.title, text: page.text },
    tickets: related,
    others,
  });
  if (ai?.error) return { error: ai.error };
  if (!ai?.partial) await saveCachedResult(page.id, key, ai.findings || []);
  return { findings: ai.findings || [] };
}
