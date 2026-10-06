# Demo video script (target 2:45, hard limit under 3:00)

Recorded on https://hearthhandoff.quirkworksllc.com using a real Ring camera or doorbell. Every on-screen Ring event must come from Ring itself, not a local replay. If any shot must use a replay, the on-screen "Local replay, not from Ring" badge stays visible and the narration says so.

| Time | Screen | Narration (approx.) |
|---|---|---|
| 0:00–0:15 | Title card, then June's household page | "When someone lives on their own, a few trusted people share the work of checking in. HearthHandoff makes the handoff explicit: what was planned, what Ring saw at the door, and what the visitor confirmed." |
| 0:15–0:40 | Schedule a visit: Dana, 2–3 PM, confirm by 3:30, Front door, shared with Sam, Sam follows up | "June owns the Ring account and decides who sees each visit. Dana is visiting; Sam is the backup if it isn't confirmed." |
| 0:40–1:05 | Ring app on phone (HearthHandoff connected), then press the real doorbell / walk past the camera | "HearthHandoff is linked through Ring's one-way account linking. Here's a real doorbell press…" |
| 1:05–1:25 | Visit timeline shows "Doorbell pressed · Front door · Ring webhook (signature verified)" with the caveat | "The event arrives as a signed Ring webhook. Notice what it doesn't claim: it shows activity at the door, not who it was or whether care happened." |
| 1:25–1:45 | Dana's phone view: "How did it go?" → Visit done + note | "Only Dana's explicit confirmation closes the visit." |
| 1:45–2:15 | A second visit passes confirm-by with no confirmation. Sam's view shows "Follow-up needed" with call/text links; the SES email arrives | "When nobody confirms, Sam gets a calm, actionable follow-up by email. If Ring saw no activity, we say why that can be normal. There's no alarm and no automatic dispatch." |
| 2:15–2:35 | Activity log showing a duplicate delivery and a late event; Ring setup page | "Ring retries are deduplicated, late events land where they happened, and unattached activity is deleted after seven days by DynamoDB TTL." |
| 2:35–2:45 | Architecture slide: Ring → API Gateway → Lambda → DynamoDB, EventBridge Scheduler, SES, Secrets Manager | "Built on the Ring Partner API and AWS. HearthHandoff, by QuirkWorks." |

## Pre-recording checklist
- [ ] Doorbell charged and on Wi-Fi; camera motion zones cover the walkway.
- [ ] Linked through the Ring mobile app (not just the portal); the setup page shows *Connected*.
- [ ] Sam's demo email set to a real inbox you control (currently the SES mailbox simulator).
- [ ] Two visits created about 10 minutes ahead of recording.
- [ ] Browser zoom at 125% for legibility; the demo banner is visible.
