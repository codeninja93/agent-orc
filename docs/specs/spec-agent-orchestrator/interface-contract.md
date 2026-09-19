# Interface Contract

Rules governing every user-facing surface. These bend design decisions and are part of the contract, not style guidance.

## The governing exchange rate

An interruption costs roughly fifteen minutes of the user's focus. Model usage is prepaid by subscription and costs nothing at the margin. **The system should spend compute freely to avoid a question.** Every rule below follows from that ratio, and any future trade-off between cost and clarity resolves against it.

This supersedes the original premise that subagents should minimize output to save tokens: attention is orders of magnitude more expensive than tokens, and terse handoffs that cause rework cost more than verbose ones.

## Question rules

| # | Rule |
|---|---|
| Q1 | Every question carries a recommended default and at most three concrete options plus an escape. Never open-ended. |
| Q2 | Every question states what happens if ignored, and the window before that happens. |
| Q3 | Every question carries a self-contained mini-brief; it must be answerable without reloading the feature into the user's head. |
| Q4 | A question must first be attempted against repository, git history and decision ledger. Deflection rate is reported. |
| Q5 | Questions are answered in the terminal. Never require a browser to reply. |
| Q6 | Answers are free text; the system parses. Never impose a format on the human. |
| Q7 | A question answered once becomes a ledger rule and is never asked again. |
| Q8 | Questions batch to natural boundaries. A do-not-disturb window queues rather than fires. |
| Q9 | Never interrupt for anything unresolvable in ten seconds. |
| Q10 | Never ask approval for a reversible action. |

## Reporting rules

| # | Rule |
|---|---|
| R1 | Silence means success. Notify only on exception, decision point, or completion. |
| R2 | One line by default; detail on request. Never dump reasoning unprompted. |
| R3 | Inverted pyramid: every message opens with a headline that stands alone. |
| R4 | Answer first, reasoning only if asked. |
| R5 | A stable, learnable grammar of message types — the user pattern-matches rather than reads. |
| R6 | Address everything by feature name. Never require the user to know an agent name or run id. |
| R7 | Progress is the current step name and the next gate. Never a percentage. |
| R8 | Every completion states what was verified **and what was not**. |
| R9 | Review requests point at the lines that need eyes and say why. Never dump a diff. |
| R10 | Consumed rate-limit budget and step count are always visible without issuing a command. Cost is subscription usage, never currency. |
| R11 | Elapsed-versus-estimate is always visible, so abandoning early is easy. |
| R12 | Uncertainty is surfaced as uncertainty, never as a confident wrong answer. |
| R13 | Quiet hours are honoured; delivery is async by default. |
| R14 | The active question occupies a persistent slot that does not scroll away. |

## Mode and control

Mode confusion — the human believing the system is in one mode while it is in another — is a known accident class in aviation and the primary interface hazard of a system with autonomy tiers.

- The current mode is displayed permanently in the prompt line.
- Disengagement is instant, obvious, and always available via a single gesture that always means stop.
- Standard callouts are emitted at every phase transition.
- The system is interruptible at every step, leaving clean resumable state.
- `just-do-it` is a first-class command: stop asking, use judgment, review at the end.
- Rejection is one keystroke plus a reason, and the reason becomes a ledger entry.

## Register

Colleague — not butler, not robot. Warmth is expressed through competence, not pleasantries. No anthropomorphic filler. Information density over friendliness. A question phrased too humanly is unsettling; one phrased too mechanically is ignored.

## Required surfaces

- **Morning brief** — all in-flight features, one screen, what each needs and what it cost.
- **One-question card** — question, recommended answer, consequence of each option, timeout default.
- **Spec echo card** — acceptance criteria, editable line by line, confirmable in one keystroke.
- **Kill card** — usage and elapsed against estimate, with continue / narrow / kill / take over.
- **Completion notice** — what merged, file count, test status, usage, and explicitly that nothing is needed.
- **Handoff document** — written when the system gives up. Reads as a colleague's note, not a stack trace.
- **Ambient status line** — a single always-visible shell or multiplexer segment. Never demanding.
- **Trust record** — per-area history of merged-unchanged versus corrected, used to justify autonomy tiers.
