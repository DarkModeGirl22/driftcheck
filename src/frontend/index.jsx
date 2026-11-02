/*
 * Driftcheck byline box (shown under every Confluence page title).
 *
 *   1. read the page and Jira tickets that moved to Done in the last 30 days,
 *   2. keep tickets that share words with the page,
 *   3. ask the backend AI which sentences those tickets made wrong,
 *   4. show each wrong sentence with its proof and a suggested fix,
 *      plus "Apply fix" and "Still correct" buttons.
 */
import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  ButtonGroup,
  Em,
  Inline,
  Link,
  LoadingButton,
  Lozenge,
  SectionMessage,
  Spinner,
  Stack,
  Strong,
  Text,
  useProductContext,
} from '@forge/react';
import { invoke, router } from '@forge/bridge';
import {
  DAYS_BACK,
  applyFix,
  checkPage,
  daysAgo,
  dismissFinding,
  fetchDismissed,
  fetchPage,
  fetchRecentDoneTickets,
  findRelatedTickets,
  otherTickets,
  findingId,
} from './confluence';

/** One out-of-date sentence: what the page says, the proof, the fix, and actions. */
const Finding = ({ finding, ticket, pageId, onDone }) => {
  const [busy, setBusy] = useState(null); // 'apply' | 'dismiss' | null
  const [result, setResult] = useState(null); // 'applied' | 'dismissed' | null
  const [error, setError] = useState(null);

  const run = async (kind, action) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
      setResult(kind === 'apply' ? 'applied' : 'dismissed');
      onDone();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  if (result === 'applied') {
    return (
      <SectionMessage appearance="success" title="Page updated">
        <Text>
          Replaced with: <Em>{finding.suggestion}</Em> (saved in the page history as "updated after{' '}
          {finding.ticket}").
        </Text>
        <Button onClick={() => router.reload()}>Reload page</Button>
      </SectionMessage>
    );
  }
  if (result === 'dismissed') {
    return (
      <SectionMessage appearance="information" title="Marked as still correct">
        <Text>Driftcheck won't flag this sentence for {finding.ticket} again.</Text>
      </SectionMessage>
    );
  }

  const high = finding.confidence === 'high';
  return (
    <Box padding="space.150" backgroundColor="color.background.neutral.subtle">
      <Stack space="space.100">
        <Inline space="space.100" alignBlock="center">
          <Lozenge appearance={high ? 'removed' : 'moved'} maxWidth={200}>
            {high ? 'Outdated' : 'Likely outdated'}
          </Lozenge>
          <Text>{finding.problem}</Text>
        </Inline>
        <Text>
          <Strong>Page says:</Strong> <Em>{finding.sentence}</Em>
        </Text>
        <Text>
          <Strong>But </Strong>
          <Link href={`/browse/${finding.ticket}`} openNewTab>
            {finding.ticket}
          </Link>
          {ticket ? ` (done ${daysAgo(ticket.resolved)})` : ''}
          <Strong> says:</Strong> <Em>{finding.evidence}</Em>
        </Text>
        <Text>
          <Strong>Suggested fix:</Strong> {finding.suggestion}
        </Text>
        {error && <Text>⚠️ {error}</Text>}
        <ButtonGroup>
          <LoadingButton
            appearance="primary"
            isLoading={busy === 'apply'}
            isDisabled={busy !== null}
            onClick={() => run('apply', () => applyFix(pageId, finding))}
          >
            Apply fix
          </LoadingButton>
          <LoadingButton
            isLoading={busy === 'dismiss'}
            isDisabled={busy !== null}
            onClick={() => run('dismiss', () => dismissFinding(pageId, finding))}
          >
            Still correct
          </LoadingButton>
        </ButtonGroup>
      </Stack>
    </Box>
  );
};

/** Word-matching result, used as a fallback when the AI can't run. */
const RelatedList = ({ related }) => (
  <Stack space="space.100">
    {related.map((ticket) => (
      <Box key={ticket.key}>
        <Text>
          <Link href={`/browse/${ticket.key}`} openNewTab>
            {ticket.key}
          </Link>{' '}
          {ticket.summary}
        </Text>
        <Inline space="space.050">
          <Text>Done {daysAgo(ticket.resolved)} ·{ticket.shared.length ? ' shared words:' : ''}</Text>
          {ticket.linked ? <Lozenge appearance="inprogress">linked from this page</Lozenge> : null}
          {ticket.shared.map((word) => (
            <Lozenge key={word}>{word}</Lozenge>
          ))}
        </Inline>
      </Box>
    ))}
  </Stack>
);

const App = () => {
  const context = useProductContext();
  const pageId = context?.extension?.content?.id;
  const [state, setState] = useState({ status: 'loading', step: 'Reading the page and Jira…' });

  useEffect(() => {
    if (!pageId) return;
    (async () => {
      try {
        const [page, tickets, dismissed, linkedKeys] = await Promise.all([
          fetchPage(pageId),
          fetchRecentDoneTickets(),
          fetchDismissed(pageId),
          // Tickets this page links to (Teamwork Graph): related even without shared words.
          invoke('linkedIssues', { pageId }).catch(() => []),
        ]);
        const related = findRelatedTickets(page, tickets, 8, linkedKeys || []);
        if (tickets.length === 0) {
          setState({ status: 'done', findings: [], related, checked: 0 });
          return;
        }
        setState({ status: 'loading', step: `Comparing the page with ${tickets.length} recent ticket(s)…` });
        // Uses the saved result when neither the page nor the recent tickets changed.
        const result = await checkPage(page, related, invoke, otherTickets(tickets, related));
        const all = result.findings || [];
        const findings = all.filter((f) => !dismissed.has(findingId(f)));
        setState({
          status: 'done',
          findings,
          hidden: all.length - findings.length,
          aiError: result.error,
          cached: result.cached,
          related,
          checked: tickets.length,
        });
      } catch (error) {
        setState({ status: 'error', message: error.message });
      }
    })();
  }, [pageId]);

  if (!pageId || state.status === 'loading') {
    return (
      <Inline space="space.100" alignBlock="center">
        <Spinner size="small" />
        <Text>{state.step || 'Loading…'}</Text>
      </Inline>
    );
  }

  if (state.status === 'error') {
    return (
      <SectionMessage appearance="error" title="Driftcheck couldn't run">
        <Text>{state.message}</Text>
      </SectionMessage>
    );
  }

  if (state.aiError) {
    return (
      <Stack space="space.150">
        <SectionMessage appearance="warning" title="Related Jira work found">
          <Text>{state.aiError} These recently finished tickets touch the same topics as this page:</Text>
        </SectionMessage>
        <RelatedList related={state.related} />
      </Stack>
    );
  }

  if (state.findings.length === 0) {
    return (
      <SectionMessage appearance="success" title="No drift found">
        <Text>
          Checked against {state.checked} Jira ticket{state.checked === 1 ? '' : 's'} finished in the
          last {DAYS_BACK} days
          {state.related.length > 0
            ? `. ${state.related.length} touch this page's topics, but none make it wrong.`
            : '. None touch this page.'}
          {state.hidden > 0 ? ` (${state.hidden} warning(s) marked as still correct.)` : ''}
          {state.cached ? ' Result saved from the last check.' : ''}
        </Text>
      </SectionMessage>
    );
  }

  const byKey = Object.fromEntries(state.related.map((t) => [t.key, t]));
  const count = state.findings.length;
  return (
    <Stack space="space.150">
      <SectionMessage
        appearance="warning"
        title={`${count} sentence${count > 1 ? 's' : ''} on this page may be out of date`}
      >
        <Text>Recently finished Jira work changed what this page describes.</Text>
      </SectionMessage>
      {state.findings.map((finding) => (
        <Finding
          key={findingId(finding)}
          finding={finding}
          ticket={byKey[finding.ticket]}
          pageId={pageId}
          onDone={() => {}}
        />
      ))}
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
