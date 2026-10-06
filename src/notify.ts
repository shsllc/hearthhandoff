// Follow-up delivery. In-app is always on. Email goes out through Amazon SES when SES_FROM is set.
// The email carries no Ring activity details: just that a visit is unconfirmed and a link to act.
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { config } from './config.ts';
import type { Repo } from './repo.ts';
import { dateTimeFormatter } from './time.ts';

let ses: SESv2Client | null = null;

export async function notifyFollowup(repo: Repo, hid: string, visitId: string, followupId: string): Promise<void> {
  if (!config.ses.from) return;
  const [visit, hh] = await Promise.all([repo.getVisit(hid, visitId), repo.getHousehold(hid)]);
  const fu = visit?.followups.find((f) => f.id === followupId);
  if (!visit || !hh || !fu) return;
  const contact = await repo.getPerson(hid, fu.contactPersonId);
  if (!contact?.email) {
    await repo.audit(hid, 'system', 'followup.email_skipped', `${contact?.name ?? 'contact'} has no email on file`);
    return;
  }
  const when = dateTimeFormatter(hh.timezone)(visit.windowStart);
  const link = `${config.publicBaseUrl}/visits/${visit.id}`;
  const text = [
    `Hi ${contact.name},`,
    '',
    `"${visit.title}" (${when}) has not been confirmed, and its confirm-by time has passed.`,
    '',
    ...fu.context,
    '',
    `See the visit and respond: ${link}`,
    '',
    'CareRelay sends this because you are the follow-up contact for this visit. It is not an emergency alert.',
  ].join('\n');

  ses ??= new SESv2Client({ region: config.ses.region });
  await ses.send(new SendEmailCommand({
    FromEmailAddress: config.ses.from,
    Destination: { ToAddresses: [contact.email] },
    Content: { Simple: { Subject: { Data: `Unconfirmed visit: ${visit.title}` }, Body: { Text: { Data: text } } } },
  }));
  await repo.updateVisit(hid, visitId, (v) => {
    const f = v.followups.find((x) => x.id === followupId);
    if (!f || f.notifiedVia.includes('email')) return false;
    f.notifiedVia.push('email');
  });
  await repo.audit(hid, 'system', 'followup.emailed', `Amazon SES → ${contact.name}`);
}
