/*
 * Resolver for the Driftcheck UI (byline box and space dashboard).
 * The frontend reads the page and tickets itself, then asks us for links and the AI check.
 */
import Resolver from '@forge/resolver';
import { analyzeWithAI } from '../lib/drift';
import { issueKeysLinkedFromPage, linkedPagesForTickets } from '../lib/graph';

const resolver = new Resolver();

resolver.define('analyzeDrift', async ({ payload }) =>
  analyzeWithAI(payload?.page || {}, payload?.tickets || [], payload?.others || [])
);

// Jira tickets this page links to (Teamwork Graph). [] when unavailable.
resolver.define('linkedIssues', async ({ payload, context }) =>
  issueKeysLinkedFromPage(String(payload?.pageId || ''), context?.cloudId)
);

// { pageId: [ticket keys] } for the recently finished tickets (dashboard).
resolver.define('linkedPages', async ({ payload, context }) =>
  linkedPagesForTickets(payload?.tickets || [], context?.cloudId)
);

export const handler = resolver.getDefinitions();
