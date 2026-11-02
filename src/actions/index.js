/*
 * Rovo actions: tools the "Driftcheck" Rovo agent can call from chat.
 *
 *  - checkPage:            is this Confluence page out of date?
 *  - findPagesForTicket:   which pages did this Jira ticket make wrong?
 *
 * Values Rovo passes in "context" (current page / issue) are trusted more than
 * values the AI extracted from the conversation, so we prefer them.
 */
import {
  analyzeWithAI,
  fetchPage,
  fetchRecentDoneTickets,
  fetchTicket,
  findRelatedTickets,
  candidatePagesForTicket,
} from '../lib/drift';
import { issueKeysLinkedFromPage } from '../lib/graph';

const PAGE_ID = /^\d+$/;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

/** Short, readable text Rovo can show or summarise. */
function describeFindings(page, findings) {
  if (findings.length === 0) return `"${page.title}": no out-of-date sentences found.`;
  return [
    `"${page.title}" (${page.link}) has ${findings.length} out-of-date sentence(s):`,
    ...findings.map(
      (f) =>
        `- Page says: "${f.sentence}" | ${f.ticket} says: "${f.evidence}" | Suggested fix: "${f.suggestion}" (confidence: ${f.confidence})`
    ),
  ].join('\n');
}

export async function checkPage(payload) {
  try {
    const fromContext = payload?.context?.confluence?.contentId || payload?.context?.contentId;
    const fromInput = String(payload?.pageId || '').trim();
    const pageId = fromContext || (PAGE_ID.test(fromInput) ? fromInput : null);
    if (!pageId) {
      return 'Open the Confluence page you want to check (or give its numeric page id), then ask again.';
    }
    const cloudId = payload?.context?.cloudId;
    const [page, tickets, linkedKeys] = await Promise.all([
      fetchPage(pageId),
      fetchRecentDoneTickets(),
      issueKeysLinkedFromPage(pageId, cloudId),
    ]);
    const related = findRelatedTickets(page, tickets, 8, linkedKeys);
    if (tickets.length === 0) return `"${page.title}": no Jira tickets were finished recently.`;
    const relatedKeys = new Set(related.map((t) => t.key));
    const others = tickets.filter((t) => !relatedKeys.has(t.key));
    const ai = await analyzeWithAI(page, related, others);
    if (ai.error) return `${ai.error} Related tickets: ${related.map((t) => t.key).join(', ')}.`;
    return describeFindings(page, ai.findings);
  } catch (error) {
    return `Driftcheck couldn't check this page: ${error.message}`;
  }
}

export async function findPagesForTicket(payload) {
  try {
    const fromContext = payload?.context?.jira?.issueKey || payload?.context?.issueKey;
    const fromInput = String(payload?.issueKey || '').trim().toUpperCase();
    const issueKey = ISSUE_KEY.test(fromInput) ? fromInput : fromContext;
    if (!issueKey) return 'Tell me which Jira ticket to check (for example KAN-1).';

    const ticket = await fetchTicket(issueKey);
    const candidates = await candidatePagesForTicket(ticket, { cloudId: payload?.context?.cloudId });
    if (candidates.length === 0) return `No Confluence pages link to or mention the topics of ${issueKey}.`;

    // Check the candidate pages in parallel so the whole action stays fast.
    const results = await Promise.all(
      candidates.map(async ({ id, linked }) => {
        const page = await fetchPage(id);
        const ai = await analyzeWithAI(page, [{ ...ticket, linked }]);
        return { page, findings: ai.findings || [] };
      })
    );
    const affected = results.filter((r) => r.findings.length > 0);
    if (affected.length === 0) {
      return `${issueKey} ("${ticket.summary}"): checked ${results.length} related page(s), none became wrong.`;
    }
    return [
      `${issueKey} ("${ticket.summary}") made ${affected.length} page(s) out of date:`,
      ...affected.map((r) => describeFindings(r.page, r.findings)),
    ].join('\n\n');
  } catch (error) {
    return `Driftcheck couldn't check this ticket: ${error.message}`;
  }
}
