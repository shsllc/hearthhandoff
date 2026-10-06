# Demo walkthrough (about 5 minutes)

Everything below runs on localhost after `npm run seed && npm start`, and the same steps work on the AWS URL. Replayed events are labeled **Local replay, not from Ring**. With a linked Ring account, press the real doorbell instead of step 3.

1. **Sign in as June (household owner).** Two labeled seeded visits are already there.
2. **Schedule a visit.** Choose *Schedule a visit or delivery* and fill it in:
   - Visitor: Dana.
   - Share with: Sam.
   - Follow-up contact: Sam.
   - Window start: about 10 minutes ago.
   - Confirm by: about 2 minutes from now.

   The visit page shows the plan, who can see it, and a calm "no door activity recorded" note.
3. **Door event.** Back on the household page, open *Demo tools*:
   - Send a *Doorbell press* with *Deliver twice* checked. The confirmation reads "stored, shown on 1 visit; duplicate delivery → duplicate".
   - Optionally send another with *Happened 20 minutes ago*. It's placed by when it happened, not when it arrived.
   - Send *Motion: vehicle*. It isn't attached, and appears only in the owner's unattached list.
4. **Visit timeline.** Each door event shows its source, the Ring caveat, and the exact match-v1 reason.
5. **Visibility.** Sign out and sign in as **Priya**. She can't see Dana's visit.
6. **Missed confirmation.** Wait for confirm-by (or, as June, use *Run deadline check now*). Sign in as **Sam**: a *Follow-up needed* card offers *Call/Text Dana*, *I'm checking in*, and *Resolve with a note*. With SES configured, Sam also gets an email.
7. **Late confirmation.** Sign in as **Dana** and open the visit. Choose *Visit done* and add a note. The follow-up resolves itself with "Dana confirmed after the follow-up opened".
8. **Audit.** As June, open the *Activity log*. Every step is there, including the duplicate delivery and the late arrival.
