/*
 * Pure text helpers shared by the UI (frontend) and the backend.
 * No Forge imports here, so both sides can use this file.
 */

// Words that say nothing about a topic (English + French), ignored when matching.
const STOP_WORDS = new Set(
  (
    // English
    'the and for with that this from have will your you are was were been into ' +
    'when what which who how why where there their them then than they these ' +
    'those about after before over under again also just only some more most ' +
    'very each other such make made need needs page pages team ticket tickets ' +
    'please should would could must does done doing using used use new old ' +
    'like than into onto upon here once while every all any can not but our ours ' +
    'company staff people work working now still always never today ' +
    // French
    'les des une dans pour avec sans sur sous par est sont été être avoir ' +
    'nous vous ils elles leur leurs mais donc ainsi cette ces celui celle tout ' +
    'tous toute toutes plus moins très aussi encore déjà comme quand votre vos ' +
    'notre nos ses son sont fait faire peut doit premier première jour'
  ).split(' ')
);

/** Lower-case, accents removed: "Équipe" -> "equipe". Used only for matching. */
function fold(text) {
  return (text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Named HTML entities Confluence uses for accented and special characters.
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: '–', mdash: '—', hellip: '…',
  laquo: '«', raquo: '»', euro: '€', deg: '°', copy: '©', reg: '®', middot: '·',
  oelig: 'œ', OElig: 'Œ', aelig: 'æ', AElig: 'Æ', szlig: 'ß',
};
const ACCENTS = { acute: '\u0301', grave: '\u0300', circ: '\u0302', uml: '\u0308', tilde: '\u0303', cedil: '\u0327', ring: '\u030A' };

/** Decodes one entity like "&eacute;" -> "é", "&#233;" -> "é". Unknown -> null. */
export function decodeEntity(entity) {
  const name = entity.slice(1, -1);
  if (name[0] === '#') {
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : null;
  }
  if (NAMED[name] !== undefined) return NAMED[name];
  // Accented letters: "eacute" = e + acute accent, "Ccedil" = C + cedilla, …
  const m = name.match(/^([a-zA-Z])(acute|grave|circ|uml|tilde|cedil|ring)$/);
  return m ? (m[1] + ACCENTS[m[2]]).normalize('NFC') : null;
}

/** Replaces every HTML entity in a text by its character. */
export function decodeEntities(text) {
  return (text || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (e) => decodeEntity(e) ?? ' ');
}

/** Confluence "storage" HTML -> plain text, one line per block (paragraph, list item, cell…). */
export function htmlToText(html) {
  return (html || '')
    .replace(/<\/(p|li|h[1-6]|tr|div|td|th)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (e) => decodeEntity(e) ?? ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** Jira "ADF" (a JSON tree) -> plain text. */
export function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  const inner = (node.content || []).map(adfToText).join('');
  return ['paragraph', 'heading', 'listItem', 'tableRow'].includes(node.type) ? `${inner}\n` : inner;
}

/** Meaningful words of a text, accent-free ("Réunions" -> "reunion"). Works for English and French. */
export function keywords(text) {
  const words = fold(text).match(/[a-z0-9]+/g) || [];
  const result = new Set();
  for (let word of words) {
    if (word.length < 4 || STOP_WORDS.has(word)) continue;
    if (word.length > 4 && /[sx]$/.test(word) && !word.endsWith('ss')) word = word.slice(0, -1);
    result.add(word);
  }
  return result;
}
// Stop words are compared after folding too.
for (const w of [...STOP_WORDS]) STOP_WORDS.add(fold(w));

/** Turns a Jira issue (from the REST API) into the small object Driftcheck uses. */
/** True for the comments Driftcheck itself posts on tickets. */
export function isDriftcheckComment(text) {
  return /^\W*Driftcheck:/.test(String(text || '').trim());
}

export function toTicket(issue) {
  // The last few comments often hold the real decision ("we switched to X").
  const comments = (issue.fields?.comment?.comments || [])
    .map((c) => adfToText(c.body).trim())
    // Skip Driftcheck's own comments: they are our output, not part of the decision.
    .filter((text) => text && !isDriftcheckComment(text))
    .slice(-3);
  return {
    id: issue.id,
    key: issue.key,
    summary: issue.fields?.summary || '',
    description: adfToText(issue.fields?.description).trim(),
    comments,
    resolved: issue.fields?.resolutiondate || issue.fields?.statuscategorychangedate,
  };
}

/** All the text of a ticket, used for matching. */
export function ticketText(t) {
  return `${t.summary} ${t.description} ${(t.comments || []).join(' ')}`;
}

/** Tickets sharing at least one meaningful word with the page, best match first. */
export function findRelatedTickets(page, tickets, max = 8, linkedKeys = []) {
  const pageWords = keywords(`${page.title} ${page.text}`);
  const linked = new Set(linkedKeys);
  return tickets
    .map((t) => ({
      ...t,
      linked: linked.has(t.key),
      shared: [...keywords(ticketText(t))].filter((w) => pageWords.has(w)),
    }))
    // A ticket the page links to is related even when they share no words.
    .filter((t) => t.linked || t.shared.length >= 1)
    .sort((a, b) => Number(b.linked) - Number(a.linked) || b.shared.length - a.shared.length)
    .slice(0, max);
}

/**
 * Splits long page text into chunks of whole lines (about maxChars each),
 * so a long page is checked completely instead of being cut off.
 */
export function chunkText(text, maxChars = 6000, maxChunks = 6) {
  const lines = (text || '').split('\n');
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if (current && current.length + line.length + 1 > maxChars) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line.slice(0, maxChars);
  }
  if (current) chunks.push(current);
  return chunks.slice(0, maxChunks);
}

/** Days between now and a date, in words. */
export function daysAgo(dateString) {
  if (!dateString) return '';
  const days = Math.floor((Date.now() - new Date(dateString).getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}
