/*
 * Driftcheck space dashboard (a page inside each Confluence space).
 *
 * Status of every page of the space:
 *  - pages already checked by the AI show its saved verdict ("Out of date" or "Checked ✓"), for free,
 *  - pages not checked yet are ranked by a quick guess (words shared with recently finished work),
 *    with a "Check with AI" button.
 * Real problems come first, then unchecked pages by guessed risk, then pages that are fine.
 */
import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  DynamicTable,
  Heading,
  Inline,
  Link,
  LoadingButton,
  Lozenge,
  SectionMessage,
  Spinner,
  Stack,
  Text,
  useProductContext,
} from '@forge/react';
import { invoke } from '@forge/bridge';
import {
  DAYS_BACK,
  checkPage,
  daysAgo,
  fetchRecentDoneTickets,
  fetchSpacePages,
  findRelatedTickets,
  otherTickets,
  savedVerdict,
} from './confluence';

/**
 * Quick guess, before any AI: how much recently finished work touches the page.
 * Tickets finished AFTER the page's last edit count fully: nobody has updated the page since.
 * A ticket the page links to weighs as much as 4 shared words: the page is certainly about it.
 */
function guess(page, related) {
  const edited = page.updated ? new Date(page.updated).getTime() : 0;
  const after = related.filter((t) => !t.resolved || new Date(t.resolved).getTime() > edited);
  const score = after.reduce((sum, t) => sum + t.shared.length + (t.linked ? 4 : 0), 0);
  if (score >= 4) return { label: 'Not checked · likely', score };
  if (score >= 2) return { label: 'Not checked · maybe', score };
  if (score >= 1 || related.length > 0) return { label: 'Not checked · unlikely', score };
  return null; // nothing recent touches this page
}

/** What the Status column shows, from the AI verdict when there is one. */
function status(row, verdict) {
  if (verdict && verdict.length > 0) {
    return { label: `Out of date · ${verdict.length}`, appearance: 'removed', rank: 3, score: verdict.length };
  }
  if (verdict) return { label: 'Checked ✓', appearance: 'success', rank: 0, score: 0 };
  if (row.guess) return { label: row.guess.label, appearance: 'default', rank: 2, score: row.guess.score };
  return { label: 'Nothing recent', appearance: 'success', rank: 1, score: 0 };
}

const sortRows = (rows, verdicts) =>
  [...rows].sort((x, y) => {
    const a = status(x, verdicts[x.page.id]);
    const b = status(y, verdicts[y.page.id]);
    return b.rank - a.rank || b.score - a.score;
  });

/** The AI cell: the saved verdict, or a "Check with AI" button. */
const AiCheck = ({ page, related, others, verdict, onVerdict }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (verdict) {
    if (verdict.length === 0) return <Text>No out-of-date sentence.</Text>;
    return (
      <Stack space="space.050">
        <Link href={page.link}>{`${verdict.length} outdated sentence${verdict.length > 1 ? 's' : ''} → open to fix`}</Link>
        {verdict.slice(0, 2).map((f) => (
          <Text key={`${f.ticket}${f.sentence}`}>
            “{f.sentence}” ({f.ticket})
          </Text>
        ))}
      </Stack>
    );
  }
  if (related.length === 0 && others.length === 0) return <Text>—</Text>;
  return (
    <Stack space="space.050">
      <LoadingButton
        isLoading={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const result = await checkPage(page, related, invoke, others);
            if (result.error) setError(result.error);
            else onVerdict(result.findings || []);
          } catch (e) {
            setError(e.message);
          }
          setBusy(false);
        }}
      >
        Check with AI
      </LoadingButton>
      {error ? <Text>{error}</Text> : null}
    </Stack>
  );
};

const head = {
  cells: [
    { key: 'page', content: 'Page' },
    { key: 'status', content: 'Status' },
    { key: 'tickets', content: 'Recent work' },
    { key: 'edited', content: 'Last edited' },
    { key: 'ai', content: 'AI check' },
  ],
};

const App = () => {
  const context = useProductContext();
  const spaceKey = context?.extension?.space?.key;
  const [state, setState] = useState({ status: 'loading' });

  useEffect(() => {
    if (!spaceKey) return;
    (async () => {
      try {
        const [pages, tickets] = await Promise.all([fetchSpacePages(spaceKey), fetchRecentDoneTickets()]);
        // Which pages link to which finished tickets (Teamwork Graph + Jira links). {} when unavailable.
        const links = await invoke('linkedPages', {
          tickets: tickets.map(({ id, key }) => ({ id, key })),
        }).catch(() => ({}));
        const rows = pages.map((page) => {
          const related = findRelatedTickets(page, tickets, 8, (links || {})[page.id] || []);
          return { page, related, others: otherTickets(tickets, related), guess: guess(page, related) };
        });
        // Saved AI verdicts (free): pages checked before show their real status right away.
        const verdictList = await Promise.all(
          rows.map((r) => savedVerdict(r.page, r.related, r.others).catch(() => null))
        );
        const verdicts = Object.fromEntries(rows.map((r, i) => [r.page.id, verdictList[i]]));
        setState({ status: 'done', rows: sortRows(rows, verdicts), verdicts, ticketCount: tickets.length });
      } catch (error) {
        setState({ status: 'error', message: error.message });
      }
    })();
  }, [spaceKey]);

  if (!spaceKey || state.status === 'loading') {
    return (
      <Inline space="space.100" alignBlock="center">
        <Spinner size="small" />
        <Text>Ranking this space's pages against recent Jira work…</Text>
      </Inline>
    );
  }
  if (state.status === 'error') {
    return (
      <SectionMessage appearance="error" title="Driftcheck couldn't load this space">
        <Text>{state.message}</Text>
      </SectionMessage>
    );
  }

  const { verdicts } = state;
  const setVerdict = (pageId, findings) =>
    setState((prev) => ({ ...prev, verdicts: { ...prev.verdicts, [pageId]: findings } }));

  const counts = state.rows.reduce(
    (c, r) => {
      const v = verdicts[r.page.id];
      if (v && v.length > 0) c.outdated += 1;
      else if (v) c.ok += 1;
      else if (r.guess) c.unchecked += 1;
      return c;
    },
    { outdated: 0, ok: 0, unchecked: 0 }
  );

  const rows = state.rows.map((row) => {
    const { page, related, others } = row;
    const verdict = verdicts[page.id];
    const st = status(row, verdict);
    // Once the AI has spoken, show the tickets it actually found; otherwise the guessed ones.
    const shown = verdict
      ? [...new Set(verdict.map((f) => f.ticket))].map((key) => related.find((t) => t.key === key) || { key })
      : related.slice(0, 3);
    return {
      key: page.id,
      cells: [
        { key: 'page', content: <Link href={page.link}>{page.title}</Link> },
        {
          key: 'status',
          content: (
            <Lozenge appearance={st.appearance} maxWidth={220}>
              {st.label}
            </Lozenge>
          ),
        },
        {
          key: 'tickets',
          content:
            shown.length === 0 ? (
              <Text>—</Text>
            ) : (
              <Inline space="space.050">
                {shown.map((t) => (
                  <Link key={t.key} href={`/browse/${t.key}`} openNewTab>
                    {t.linked ? `🔗 ${t.key}` : t.key}
                  </Link>
                ))}
              </Inline>
            ),
        },
        { key: 'edited', content: <Text>{daysAgo(page.updated) || '—'}</Text> },
        {
          key: 'ai',
          content: (
            <AiCheck
              page={page}
              related={related}
              others={others}
              verdict={verdict}
              onVerdict={(findings) => setVerdict(page.id, findings)}
            />
          ),
        },
      ],
    };
  });

  return (
    <Stack space="space.200">
      <Heading size="medium">Driftcheck: which pages are out of date?</Heading>
      <Text>
        {state.rows.length} pages compared with {state.ticketCount} Jira ticket
        {state.ticketCount === 1 ? '' : 's'} finished in the last {DAYS_BACK} days: {counts.outdated} out of
        date, {counts.ok} checked and correct, {counts.unchecked} not checked yet.
      </Text>
      <DynamicTable head={head} rows={rows} rowsPerPage={20} />
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
