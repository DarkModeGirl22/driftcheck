# Driftcheck

**Your Confluence pages say one thing. Your Jira work says another. Driftcheck notices.**

Built on Atlassian Forge for Codegeist 2026.

## The problem

Every team's wiki goes stale silently. A runbook still describes a server that was removed.
An onboarding guide points to a tool nobody uses anymore. Nothing turns red when that happens,
so people follow wrong instructions, and now AI assistants like Rovo repeat them with confidence.

Existing tools look at a page's **age**. But age is a bad clue:

- "Our company was founded in 2010" hasn't been edited in five years, and it's still true.
- "Press the red button on the coffee machine" was edited last week for a typo, and it's wrong,
  because the machine was replaced in ticket KAN-1.

## What Driftcheck does

Driftcheck reads the **work that actually happened** (Jira tickets moved to Done) and checks it
against what the **documentation says**. When a finished ticket contradicts a sentence, it shows:

> **Page says:** 2. Press the red button and wait 30 seconds.
> **But KAN-1 (done 2 days ago) says:** The old red button no longer exists.
> **Suggested fix:** 2. Press the blue start button and wait 30 seconds.
> [Apply fix] [Still correct]

Pages that are old but still true are left alone.

## Features

| Where | What |
|---|---|
| **Under every page title** | "Driftcheck" opens the check for that page: each out-of-date sentence, the ticket that proves it, and a suggested rewrite. |
| **Apply fix** | Rewrites the sentence in one click and records "Driftcheck: updated after KAN-1" in the page history. |
| **Still correct** | Dismisses a warning for good (stored on the page itself), so Driftcheck never cries wolf twice. |
| **Space dashboard** | Every page of the space with its status: **Out of date** (with the sentences), **Checked ✓**, or **Not checked** ranked by a quick guess, with a "Check with AI" button. Saved AI verdicts show instantly, at no AI cost. |
| **Automatic check on Done** | Move a Jira ticket to Done and Driftcheck comments on it: *"⚠️ this change makes 2 Confluence pages out of date"*, quoting each wrong sentence and its fix, and **@mentions each page's owner** so the right person is notified. Silent when nothing is affected. |
| **Knows what's linked** | A page that links to a ticket is checked against it even when they share no words (*"open the PD app"* on a page linking the PagerDuty → Opsgenie ticket). Uses the **Teamwork Graph** and Jira's "mentioned in" links. Linked pages get a 🔗 on the dashboard. |
| **Rovo agent** | Ask in chat: *"Is this page still up to date?"* or *"Which pages did KAN-1 make out of date?"* |

## How it works

1. **Read:** the page (Confluence REST v2) and Jira tickets that moved to Done in the last 30 days
   (JQL on `statusCategoryChangedDate`, which works even in simple Kanban projects), including
   each ticket's last comments, where decisions often live.
2. **Narrow down:** keep tickets the page links to (Teamwork Graph: `ConfluencePage
   -[content_entity_links_entity]-> JiraWorkItem`) plus tickets that share meaningful words with the
   page, so the AI only sees relevant work (cheaper, faster, fewer false alarms).
3. **Judge:** Claude Sonnet 4.6 via the **Forge LLMs API** decides, sentence by sentence, whether a
   ticket makes it untrue. Long pages are split into parts checked in parallel. The AI must quote the
   page and the ticket exactly; quotes that aren't really on the page are thrown away, and unsure
   findings are dropped, so it doesn't cry wolf.
4. **Remember:** results are saved on the page, so the AI only runs again when the page or its
   related tickets change (faster, cheaper).
5. **Act:** the user applies the fix or dismisses it. Every change is visible in the page history.
   Apply fix works through bold text, links, tables and accented characters, and refuses to touch
   anything ambiguous.

## Does it actually work? (measured, failures included)

We tested Driftcheck in a real Confluence + Jira site, through the app itself (no mocks):
**49 test pages and 41 finished Jira tickets**, in three rounds. Each round was built to break it.

### Round 1: the basics (18 pages)

Plain drift, a drift hidden at the bottom of a 14,000-character page, a decision written only in a
ticket **comment**, sentences inside **tables** and in **bold**, French pages, old-but-true pages,
general rules that survive a change. The first version scored **14/18**. The misses led to reading
ticket comments, checking long pages in parts, and a stricter definition of "out of date". After
that: **18/18**, plus the "no shared words, but the page links the ticket" case (**19/19**).

### Round 2: traps (16 pages, 24 sentences)

| Trap | Example | Result |
|---|---|---|
| Change **rolled back** in a comment | "Errors are reported to Sentry" (move to Datadog, then rolled back) | ✅ not flagged |
| **Spike** that decided to change nothing | "Team chat happens in Slack" | ✅ not flagged |
| **Other instance** of the same thing | Lyon printer moved, Paris printer didn't | ✅ only Lyon flagged |
| New **option added**, old one still works | Apple Pay added, "customers pay by card" | ✅ not flagged |
| Page **already up to date** | "Mockups are made in Figma" | ✅ not flagged |
| Same word, **different meaning** | "Release notes…" vs. the "Release" button moved | ✅ not flagged |
| Different **units / wording** | "three months" vs. "90 → 30 days" | ✅ flagged, fix says 30 days |
| **Abbreviation** | "e-sign with **DS**" vs. DocuSign → Yousign | ✅ flagged |
| Changed **twice** | demo Tuesday → Wednesday → Thursday | ✅ fix says **Thursday** |
| Server **deleted**, no replacement given | "run it on staging-2 first" | ✅ flagged |

**What failed in round 2 (10/11 caught, 1 false alarm):**
1. ❌ A **history** sentence ("in 2025 we moved our status page from Statuspage to Instatus") was flagged.
   It is still true.
2. ❌ A **French page vs. an English ticket** with no shared words was missed: word matching never
   showed that ticket to the AI.
3. ❌ The automatic Jira comment flagged "write what you see in **the incident channel**" after the
   channel was renamed. It doesn't name the old channel, so it is still true.
4. ⚠️ One page sometimes failed with "AI couldn't run" (the AI's answer wasn't always clean JSON).

**How we fixed it:**
- Clearer rules for the AI: history, general wording and a *different* office, region or meeting are not drift.
- **AI triage:** tickets that share no words with the page are now sorted by meaning (other language,
  abbreviation, synonym), so the AI can still pick the right ones.
- A tolerant JSON reader, one automatic retry, and a guard that drops a "fix" identical to the sentence.

### Round 3: unseen cases, written *after* the fixes (14 pages, 17 sentences)

To avoid grading our own homework, round 3 was written after the fixes, with new traps:
a change **cancelled after legal review**, a **plan** for next March ("nothing changes before then"),
an IT contact changed **twice** (Tom → Ana → Leo), a **French page / English ticket** with no shared words,
an office that **closed**, a free-shipping threshold that changed for **France only**, and history next to
a current fact ("We adopted Pipedrive in 2022" / "Log every call in Pipedrive").

### Final run (all of rounds 2 and 3, final version)

| | Result |
|---|---|
| Out-of-date sentences caught | **20 / 20** |
| Suggested fixes that are correct | **20 / 20** (Leo, not Ana; French fix written in French; Belgium kept at 50€) |
| True sentences wrongly flagged | **2 / 21** |

The 2 false alarms, so you know where it can still be wrong:
- "You can work remotely on Mondays", after Fridays were **added**. The AI reasoned the sentence implies
  Mondays are the only day. A grey area, but we count it as wrong.
- "…and file it in **the CRM**" was flagged for the CRM switch, on a sentence that *was* out of date for
  another reason (DocuSign). The generic words "the CRM" stay true.

Every result was produced by the deployed app; the test pages and tickets are in our test site.

## Built with

- Forge UI Kit: `confluence:contentBylineItem`, `confluence:spacePage`
- Forge LLMs API (`@forge/llm`): Atlassian-hosted Claude, no external API keys,
  data never leaves Atlassian. The app is eligible for **Runs on Atlassian**.
- Rovo: `rovo:agent` with two `action` modules (`check-page-drift`, `find-pages-for-ticket`)
- Forge `trigger` on `avi:jira:updated:issue` for the automatic check, with Forge storage for
  safety limits (each move to Done checked once, at most 20 automatic checks per day)
- **Teamwork Graph** (`requestTeamworkGraph`, persisted Cypher queries) to find which pages and
  tickets link to each other, with Jira remote links as a fallback for the automatic check
- Confluence and Jira REST APIs, called as the current user, so permissions are always respected

## Privacy and safety

- Runs entirely on Atlassian infrastructure (Forge functions + Forge LLMs). No egress.
- All reads and writes happen **as the user**: Driftcheck can only see or edit what that user can.
- Nothing is changed without a click. "Apply fix" creates a normal page version you can roll back.

## Install and run (developers)

```bash
npm install
forge deploy
forge install --product confluence --site <your-site>.atlassian.net
forge install --product jira --site <your-site>.atlassian.net
```

Note: the Teamwork Graph queries Driftcheck uses are registered for our app ID. If you deploy your own
copy (a new app ID), Driftcheck still works: it falls back to Jira "mentioned in" links and word search.

Open any Confluence page and click **Driftcheck** under the title. To try it, create a page that
says "Press the red button", then a Jira ticket saying the red button was replaced, and move it to Done.

## Big sites

On a real company site (our demo site has hundreds of sample pages), a plain word search returns noise:
"engineers" or "October" are on half the pages. For the automatic check, Driftcheck runs one search per
main word of the ticket to collect candidates, then the AI picks the pages that are really about what
the ticket changed. Driftcheck also ignores its own Jira comments when it reads a ticket.

## What's next

- Known limit: the automatic check on Done finds pages by search, so a page in another language that
  doesn't link the ticket can be missed there (the page check itself handles it via AI triage).

- Check code changes too (Bitbucket pull requests), not only Jira tickets.
- Notify the page owner directly, not only the ticket.
