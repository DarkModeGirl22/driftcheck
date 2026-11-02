/*
 * Automatic check: when a Jira ticket moves to Done, Driftcheck looks for Confluence pages
 * that this change made out of date, and comments on the ticket with what it found.
 *
 * Nobody is looking at a page at that moment, so this runs "as the app".
 * Safety limits: each ticket is checked once per move to Done, at most DAILY_LIMIT
 * automatic checks per day, and at most MAX_PAGES pages per ticket.
 */
import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { analyzeWithAI, candidatePagesForTicket, fetchPage, fetchTicket } from '../lib/drift';

const DAILY_LIMIT = 20;
const MAX_PAGES = 4;

/* ---------- helpers ---------- */

/** True when this update moved the ticket into a Done-type status. */
async function movedToDone(event) {
  const statusChange = (event?.changelog?.items || []).find((i) => i.field === 'status');
  if (!statusChange) return false;
  const key = event.issue?.key;
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${key}?fields=status`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return false;
  const issue = await res.json();
  return issue.fields?.status?.statusCategory?.key === 'done';
}

/** Counts today's automatic checks; returns false when the daily limit is reached. */
async function takeDailySlot() {
  const day = new Date().toISOString().slice(0, 10);
  const counterKey = `auto-checks-${day}`;
  const used = (await kvs.get(counterKey)) || 0;
  if (used >= DAILY_LIMIT) return false;
  await kvs.set(counterKey, used + 1);
  return true;
}

/* ---------- the Jira comment (Atlassian Document Format) ---------- */

const text = (value, marks) => ({ type: 'text', text: value, ...(marks ? { marks } : {}) });
const strong = [{ type: 'strong' }];
const em = [{ type: 'em' }];
const link = (href) => [{ type: 'link', attrs: { href } }];
// @mention of the page owner, so the right person gets notified.
const mention = (accountId) => ({ type: 'mention', attrs: { id: accountId } });

function buildComment(affected, checkedCount) {
  const intro = {
    type: 'paragraph',
    content: [
      text('⚠️ Driftcheck: ', strong),
      text(
        `this change makes ${affected.length} Confluence page${affected.length > 1 ? 's' : ''} out of date ` +
          `(checked ${checkedCount} related page${checkedCount > 1 ? 's' : ''}).`
      ),
    ],
  };
  const items = affected.map(({ page, findings }) => ({
    type: 'listItem',
    content: [
      {
        type: 'paragraph',
        content: [
          text(page.title, page.url ? [...strong, ...link(page.url)] : strong),
          ...(page.ownerId ? [text(' · owner: '), mention(page.ownerId), text(' ')] : []),
        ],
      },
      {
        type: 'bulletList',
        content: findings.map((f) => ({
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                text('Page says: '),
                text(f.sentence, em),
                text(' → suggested: '),
                text(f.suggestion),
              ],
            },
          ],
        })),
      },
    ],
  }));
  const outro = {
    type: 'paragraph',
    content: [text('Open each page and click "Driftcheck" under the title to apply the fix in one click.')],
  };
  return { type: 'doc', version: 1, content: [intro, { type: 'bulletList', content: items }, outro] };
}

async function postComment(issueKey, body) {
  const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}/comment`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) console.error(`Driftcheck couldn't comment on ${issueKey}: ${res.status}`);
}

/* ---------- the trigger ---------- */

export async function onTicketDone(event) {
  try {
    const issueKey = event?.issue?.key;
    if (!issueKey || !(await movedToDone(event))) return;

    // Check each "move to Done" only once (Jira can send several update events).
    const doneAt = event?.changelog?.id || new Date().toISOString().slice(0, 16);
    const onceKey = `checked-${issueKey}-${doneAt}`;
    if (await kvs.get(onceKey)) return;
    await kvs.set(onceKey, true);

    if (!(await takeDailySlot())) {
      console.log(`Driftcheck daily limit reached, skipping ${issueKey}`);
      return;
    }

    const ticket = await fetchTicket(issueKey, 'app');
    // Pages that link to the ticket, then pages found by word search.
    const candidates = await candidatePagesForTicket(ticket, { limit: MAX_PAGES, who: 'app' });
    if (candidates.length === 0) return; // nothing related: stay quiet

    const results = await Promise.all(
      candidates.map(async ({ id, linked }) => {
        try {
          const page = await fetchPage(id, 'app');
          const ai = await analyzeWithAI(page, [{ ...ticket, linked }]);
          return { page, findings: ai.findings || [] };
        } catch (e) {
          return { page: null, findings: [] };
        }
      })
    );
    const affected = results.filter((r) => r.page && r.findings.length > 0);
    // Only comment when something is actually out of date: no noise on every ticket.
    if (affected.length > 0) await postComment(issueKey, buildComment(affected, candidates.length));
  } catch (error) {
    console.error('Driftcheck automatic check failed:', error?.message);
  }
}
