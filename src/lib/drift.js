/*
 * Driftcheck backend logic, shared by the byline/dashboard resolver and the Rovo actions.
 *
 * - reads Confluence pages and recently finished Jira tickets (as the current user),
 * - asks an Atlassian-hosted Claude model which page sentences a ticket makes wrong.
 *   Long pages are split into parts that are checked in parallel, so nothing is cut off
 *   and the check stays within Forge's time limit.
 */
import api, { route } from '@forge/api';
import { chat } from '@forge/llm';
import { linkedPageIdsForTicket } from './graph';
import { chunkText, findRelatedTickets, htmlToText, keywords, ticketText, toTicket } from './text';

export { findRelatedTickets } from './text';

// Sonnet 4.6 stays available until at least February 2027 (after Codegeist ends).
const MODEL = 'claude-sonnet-4-6';

export const DAYS_BACK = 30;
const MAX_TICKETS = 8;
const MAX_TICKET_CHARS = 1500;
const CHUNK_CHARS = 6000;
const MAX_CHUNKS = 6; // up to ~36,000 characters of page text
const TICKET_FIELDS = 'summary,description,comment,resolutiondate,statuscategorychangedate';

function clip(text, max) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)} [...]` : value;
}

/* ---------- reading Confluence and Jira ---------- */
// "user": as the person looking at the page (respects their permissions).
// "app": as Driftcheck itself, used by the automatic check when nobody is looking.
const as = (who) => (who === 'app' ? api.asApp() : api.asUser());

export async function fetchPage(pageId, who = 'user') {
  const res = await as(who)
    .requestConfluence(route`/wiki/api/v2/pages/${pageId}?body-format=storage`, {
      headers: { Accept: 'application/json' },
    });
  if (!res.ok) throw new Error(`Couldn't read page ${pageId} (error ${res.status}).`);
  const page = await res.json();
  return {
    id: page.id,
    title: page.title || '',
    ownerId: page.ownerId || page.authorId || null,
    text: htmlToText(page.body?.storage?.value),
    link: page._links?.webui ? `/wiki${page._links.webui}` : '',
    // Full address (needed in Jira comments, which live on another product).
    url: page._links?.base && page._links?.webui ? `${page._links.base}${page._links.webui}` : '',
  };
}

export async function fetchRecentDoneTickets(who = 'user') {
  const jql =
    `statusCategory = Done AND statusCategoryChangedDate >= -${DAYS_BACK}d ` +
    'ORDER BY statusCategoryChangedDate DESC';
  const res = await as(who)
    .requestJira(route`/rest/api/3/search/jql?jql=${jql}&fields=${TICKET_FIELDS}&maxResults=50`, {
      headers: { Accept: 'application/json' },
    });
  if (!res.ok) throw new Error(`Couldn't read Jira tickets (error ${res.status}).`);
  const data = await res.json();
  return (data.issues || []).map(toTicket);
}

export async function fetchTicket(issueKey, who = 'user') {
  const res = await as(who)
    .requestJira(route`/rest/api/3/issue/${issueKey}?fields=${TICKET_FIELDS}`, {
      headers: { Accept: 'application/json' },
    });
  if (!res.ok) throw new Error(`Couldn't read Jira ticket ${issueKey} (error ${res.status}).`);
  return toTicket(await res.json());
}

/** Pages containing one word: [{ id, title, excerpt }]. [] when the search fails. */
async function searchWord(word, who) {
  try {
    const cql = `type = page AND text ~ "${word}"`;
    const res = await as(who).requestConfluence(route`/wiki/rest/api/search?cql=${cql}&limit=5`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results || [])
      .filter((r) => r.content?.id)
      .map((r) => ({ id: r.content.id, title: r.content.title || r.title || '', excerpt: r.excerpt || '' }));
  } catch (e) {
    return [];
  }
}

const PAGE_TRIAGE_PROMPT = `A Jira ticket was just finished. Below are Confluence pages found by a word search.
Pick the pages that probably describe the thing this ticket changed (the same tool, process, place, person,
schedule or system), so that the page may now be out of date. Ignore pages that only share a common word.
Answer with JSON only: {"ids":["123"]}. If none fit, answer {"ids":[]}.`;

/**
 * Confluence pages about a ticket, in two steps:
 * 1. a wide word search (one search per main word of the ticket, summary words first),
 * 2. the AI picks the pages that are really about what the ticket changed.
 * On a big site, a plain word search returns noise ("engineers", "October" are everywhere).
 */
export async function searchPagesForTicket(ticket, limit = 4, who = 'user') {
  const fromSummary = [...keywords(ticket.summary || '')];
  const longest = [...keywords(ticketText(ticket))].sort((a, b) => b.length - a.length);
  const words = [...new Set([...fromSummary, ...longest])].slice(0, 8);
  if (words.length === 0) return [];

  const found = await Promise.all(words.map((w) => searchWord(w, who)));
  const pool = new Map();
  found.forEach((pages) =>
    pages.forEach((p) => {
      const entry = pool.get(p.id) || { ...p, hits: 0 };
      entry.hits += 1;
      pool.set(p.id, entry);
    })
  );
  const ranked = [...pool.values()].sort((x, y) => y.hits - x.hits).slice(0, 15);
  if (ranked.length <= limit) return ranked.map((p) => p.id);

  try {
    const list = ranked
      .map((p) => `${p.id}: ${clip(p.title, 120)} | ${clip(String(p.excerpt).replace(/\s+/g, ' '), 200)}`)
      .join('\n');
    const response = await chat({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: `${PAGE_TRIAGE_PROMPT}\n\nTICKET: ${clip(ticket.summary, 300)}\n${clip(
            ticket.description,
            800
          )}\n\nPAGES:\n${list}`,
        },
      ],
    });
    const known = new Set(ranked.map((p) => p.id));
    const ids = (parseJson(replyText(response)).ids || []).map(String).filter((id) => known.has(id));
    return ids.slice(0, limit);
  } catch (e) {
    console.warn('Driftcheck page triage failed, using word matches:', e?.message);
    return ranked.slice(0, limit).map((p) => p.id);
  }
}

/**
 * Pages to check for one ticket: pages that link to it first (certainly related),
 * then pages found by word search. Returns [{ id, linked }].
 */
export async function candidatePagesForTicket(ticket, { limit = 4, who = 'user', cloudId } = {}) {
  const [linked, found] = await Promise.all([
    linkedPageIdsForTicket(ticket, { who, cloudId }),
    searchPagesForTicket(ticket, limit, who).catch(() => []),
  ]);
  const seen = new Set();
  return [...linked.slice(0, limit).map((id) => ({ id, linked: true })), ...found.map((id) => ({ id, linked: false }))]
    .filter((p) => !seen.has(p.id) && seen.add(p.id))
    .slice(0, limit * 2);
}

/* ---------- the AI check ---------- */

const SYSTEM_PROMPT = `You check whether a Confluence page has become out of date because of recently finished Jira work.

You get part of a page (title + text) and some Jira tickets that were recently moved to Done (with description and last comments).
For each sentence of the page text, decide if a ticket shows that the sentence is NO LONGER TRUE.

Flag a sentence only when ALL of these hold:
1. The ticket changes the exact thing the sentence describes (a tool, button, step, server, time, place, person, number or process that was replaced, removed or changed).
2. Someone following the sentence today would do something wrong or fail.
3. You can quote the words in the ticket that prove it.

Do NOT flag:
- general rules or advice that stay true after the change (for example "never share your password" stays true even if the login system changed),
- sentences about the past that stay true (history, "in 2025 we moved from A to B", "we used to..."),
- sentences that refer to the thing in general words without the old name or value (for example "post in the incident channel" stays true when the channel is renamed),
- sentences about a different instance of the same kind of thing (another office, region, team, product or meeting than the one the ticket changed),
- sentences that already describe the new situation,
- changes that only add an option while the old way still works,
- tickets whose comments say the change was rolled back, cancelled or not done,
- sentences that only mention the same topic,
- pages that are old but still true,
- anything you are unsure about.

Formatting rules:
- "sentence": copied exactly from the page text, one line only.
- "evidence": a short exact quote from the ticket (description or comment).
- "suggestion": the sentence rewritten so it is true again, in the same language, style and format as the page.
- "confidence": "high" if the ticket states the change explicitly, otherwise "medium". Leave out anything that would be "low".
- Pages and tickets may be in different languages (for example a French page and an English ticket); that is fine.
- When several tickets change the same thing, the most recently finished one wins.

Answer with JSON only, no other text, in this exact shape:
{"findings":[{"ticket":"KAN-1","sentence":"...","problem":"one short line","evidence":"...","suggestion":"...","confidence":"high|medium"}]}
If nothing is out of date, answer {"findings":[]}.`;

/**
 * Reads the first JSON object in the AI's answer.
 * Tolerates text or code fences around it, and raw line breaks inside strings.
 */
function parseJson(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('The AI did not return JSON.');
  let depth = 0;
  let inString = false;
  let escaped = false;
  let out = '';
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      else if (ch === '\n') { out += '\\n'; continue; }
      else if (ch === '\r') continue;
      else if (ch === '\t') { out += '\\t'; continue; }
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(out + ch);
    }
    out += ch;
  }
  throw new Error('The AI answer was cut off.');
}

function replyText(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part?.text || '').join('');
  return '';
}

function describeTickets(list) {
  return list
    .map((t) => {
      const comments = (t.comments || []).length
        ? `\nLast comments:\n${t.comments.map((c) => `- ${clip(c, 500)}`).join('\n')}`
        : '';
      const linkNote = t.linked ? '\nNote: the page links directly to this ticket.' : '';
      return `[${t.key}] ${clip(t.summary, 300)}${linkNote}\nFinished: ${t.resolved || 'recently'}\nDescription: ${clip(
        t.description,
        MAX_TICKET_CHARS
      )}${comments}`;
    })
    .join('\n\n');
}

/** Checks one part of a page. Throws on failure. */
async function checkPart(title, partText, partLabel, ticketBlock) {
  const userMessage = `PAGE TITLE: ${clip(title, 300)}${partLabel}

PAGE TEXT:
${partText}

RECENTLY FINISHED JIRA TICKETS:
${ticketBlock}`;
  const ask = async () => {
    const response = await chat({
      model: MODEL,
      messages: [{ role: 'user', content: `${SYSTEM_PROMPT}\n\n${userMessage}` }],
    });
    return parseJson(replyText(response)).findings || [];
  };
  try {
    return await ask();
  } catch (e) {
    // One retry: the model sometimes times out or answers in a broken format.
    return ask();
  }
}

/* ---------- triage: tickets that word matching missed ---------- */

const TRIAGE_PROMPT = `You help decide which Jira tickets to compare with a Confluence page.
You get the start of the page and a list of recently finished tickets (key, summary, short description).
Pick the tickets whose change could make something written on this page untrue.
The page and the tickets may use different languages, abbreviations or synonyms: judge the meaning, not the words.
Pick at most 4. If none fit, pick none.
Answer with JSON only: {"keys":["KAN-1"]}`;

/** Asks the AI which of the "other" tickets (no shared words) concern the page. Never throws. */
async function triage(page, others) {
  try {
    const list = others
      .slice(0, 40)
      .map((t) => `${t.key}: ${clip(t.summary, 200)} | ${clip(t.description, 200)}`)
      .join('\n');
    const response = await chat({
      model: MODEL,
      messages: [
        {
          role: 'user',
          content: `${TRIAGE_PROMPT}\n\nPAGE TITLE: ${clip(page.title, 300)}\nPAGE START:\n${clip(page.text, 3000)}\n\nTICKETS:\n${list}`,
        },
      ],
    });
    const keys = new Set((parseJson(replyText(response)).keys || []).slice(0, 4));
    return others.filter((t) => keys.has(t.key));
  } catch (e) {
    console.warn('Driftcheck triage failed:', e?.message);
    return [];
  }
}

/** Lower-case, single spaces, straight quotes: tolerant comparison of quoted sentences. */
const loose = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Returns { findings: [...] } or { error: '...' }. Never throws.
 * tickets: tickets related by links or shared words. others: the remaining recent tickets;
 * the AI picks the ones that matter anyway (other language, abbreviation, synonym).
 */
export async function analyzeWithAI(page, tickets, others = []) {
  const extra = others.length ? await triage(page, others) : [];
  const list = [...(tickets || []), ...extra].slice(0, MAX_TICKETS);
  if (list.length === 0) return { findings: [] };

  const ticketBlock = describeTickets(list);
  const parts = chunkText(page.text, CHUNK_CHARS, MAX_CHUNKS);
  if (parts.length === 0) return { findings: [] };

  // All parts in parallel: a long page takes about as long as a short one.
  const results = await Promise.allSettled(
    parts.map((part, i) =>
      checkPart(page.title, part, parts.length > 1 ? ` (part ${i + 1} of ${parts.length})` : '', ticketBlock)
    )
  );
  const failed = results.filter((r) => r.status === 'rejected');
  failed.forEach((r) => console.error('Driftcheck AI part failed:', r.reason?.context?.responseText || r.reason?.message));
  if (failed.length === results.length) {
    const reason = String(failed[0].reason?.message || '').slice(0, 120);
    return { error: `The AI check couldn't run right now${reason ? ` (${reason})` : ''}.` };
  }

  // Keep well-formed findings that point to a ticket we sent and to a sentence really on the page.
  const known = new Set(list.map((t) => t.key));
  const seen = new Map();
  const findings = results
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value)
    .filter(
      (f) =>
        f &&
        known.has(f.ticket) &&
        f.sentence &&
        f.suggestion &&
        f.confidence !== 'low' &&
        // A "fix" identical to the sentence means the AI itself found nothing wrong.
        loose(f.suggestion) !== loose(f.sentence) &&
        // The AI must quote a sentence that really is on the page (protects against made-up findings).
        loose(page.text).includes(loose(f.sentence))
    )
    // One card per sentence: when two tickets hit the same sentence, keep the first and note the other.
    .filter((f) => {
      const id = loose(f.sentence);
      const first = seen.get(id);
      if (first) {
        if (first.ticket !== f.ticket) first.alsoTickets = [...(first.alsoTickets || []), f.ticket];
        return false;
      }
      seen.set(id, f);
      return true;
    });
  return { findings, partial: failed.length > 0 };
}
