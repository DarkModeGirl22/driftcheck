/*
 * Links between Confluence pages and Jira tickets.
 *
 * A page that links to a ticket is certainly about it, even when it shares no words with it
 * (for example "open the PD app" on a page linking the "PagerDuty → Opsgenie" ticket).
 *
 * Two sources:
 *  - Atlassian Teamwork Graph (when a person is using the app: byline, dashboard, Rovo),
 *  - Jira "mentioned in" remote links (always available, also for the automatic check).
 * Every function here returns an empty result instead of throwing: links are a bonus signal,
 * word matching still works without them.
 */
import api, { route } from '@forge/api';

// Persisted Teamwork Graph queries registered for this app (Cypher is fixed, values are parameters).
const QUERY = {
  // MATCH (p:ConfluencePage)-[:content_entity_links_entity]->(i:JiraWorkItem {ari: $issueId}) RETURN p
  pagesLinkingIssue: '76db3df6-d467-4fd7-b867-2cc4da07fb42',
  // MATCH (p:ConfluencePage {ari: $pageId})-[:content_entity_links_entity]->(i:JiraWorkItem) RETURN i
  issuesLinkedFromPage: '26f4e61a-64c8-435f-a172-661a4c5a1e97',
};

const GRAPHQL = `query driftcheck_linkedEntities($queryKey: String!, $queryParams: CypherRequestParams) {
  customQuery(queryKey: $queryKey, queryParams: $queryParams, first: 25) {
    edges { node { columns { value {
      ... on CypherQueryResultNode { data {
        __typename
        ... on ConfluencePage { pageId title webUrl owner { ... on AtlassianUser { accountId } } }
        ... on JiraWorkItem { issueId key }
      } }
    } } } }
  }
}`;

const pageAri = (cloudId, pageId) => `ari:cloud:confluence:${cloudId}:page/${pageId}`;
const issueAri = (cloudId, issueId) => `ari:cloud:jira:${cloudId}:issue/${issueId}`;

/** Runs a persisted graph query as the current user; returns the result objects. */
async function graphQuery(queryKey, queryParams) {
  const res = await api
    .asUser()
    .requestTeamworkGraph(GRAPHQL, { queryKey, queryParams }, 'driftcheck_linkedEntities');
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return (json.data?.customQuery?.edges || [])
    .flatMap((e) => e.node?.columns || [])
    .map((c) => c.value?.data)
    .filter(Boolean);
}

/** Keys of the Jira tickets a page links to (Teamwork Graph). */
export async function issueKeysLinkedFromPage(pageId, cloudId) {
  if (!pageId || !cloudId) return [];
  try {
    const rows = await graphQuery(QUERY.issuesLinkedFromPage, { pageId: pageAri(cloudId, pageId) });
    return [...new Set(rows.map((r) => r.key).filter(Boolean))];
  } catch (e) {
    console.warn('Driftcheck graph (page → tickets) unavailable:', e.message);
    return [];
  }
}

/** Ids of the Confluence pages that link to one ticket (Teamwork Graph). */
export async function pageIdsLinkingIssue(issueId, cloudId) {
  if (!issueId || !cloudId) return [];
  try {
    const rows = await graphQuery(QUERY.pagesLinkingIssue, { issueId: issueAri(cloudId, issueId) });
    return [...new Set(rows.map((r) => r.pageId).filter(Boolean))];
  } catch (e) {
    console.warn('Driftcheck graph (ticket → pages) unavailable:', e.message);
    return [];
  }
}

/** Ids of the Confluence pages Jira lists as "mentioned in" for a ticket (works as the app too). */
export async function pageIdsFromRemoteLinks(issueKey, who = 'user') {
  try {
    const client = who === 'app' ? api.asApp() : api.asUser();
    const res = await client.requestJira(route`/rest/api/3/issue/${issueKey}/remotelink`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];
    const links = await res.json();
    return [
      ...new Set(
        (Array.isArray(links) ? links : [])
          .filter((l) => l.application?.type === 'com.atlassian.confluence')
          .map((l) => (String(l.globalId || '').match(/pageId=(\d+)/) || String(l.object?.url || '').match(/pageId=(\d+)/) || [])[1])
          .filter(Boolean)
      ),
    ];
  } catch (e) {
    console.warn('Driftcheck remote links unavailable:', e.message);
    return [];
  }
}

/** Every page linked to a ticket, from both sources. */
export async function linkedPageIdsForTicket(ticket, { who = 'user', cloudId } = {}) {
  const [fromGraph, fromJira] = await Promise.all([
    who === 'user' ? pageIdsLinkingIssue(ticket.id, cloudId) : Promise.resolve([]),
    pageIdsFromRemoteLinks(ticket.key, who),
  ]);
  return [...new Set([...fromGraph, ...fromJira])];
}

/** For the dashboard: { pageId: [ticket keys] } for a list of tickets ({ id, key }). */
export async function linkedPagesForTickets(tickets, cloudId) {
  const map = {};
  await Promise.all(
    (tickets || []).slice(0, 20).map(async (t) => {
      const ids = await linkedPageIdsForTicket(t, { who: 'user', cloudId });
      ids.forEach((id) => {
        map[id] = [...new Set([...(map[id] || []), t.key])];
      });
    })
  );
  return map;
}
