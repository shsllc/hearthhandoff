// Deadline evaluation. Pure: given a visit's state at `now`, decide whether a follow-up is due and
// what it should say. Only a person closes a visit: the visitor's or household owner's confirmation or problem
// report, or the follow-up contact's resolution note.
// Ring activity (or its absence) adjusts the wording, never the decision, and is never framed as an emergency.

export type VisitStatus = 'scheduled' | 'confirmed' | 'problem' | 'unconfirmed' | 'resolved' | 'cancelled';

export interface DeadlineInput {
  status: VisitStatus;
  confirmBy: number;
  hasConfirmation: boolean;
  hasOpenFollowup: boolean;
  matchedEventCount: number;
  deviceOfflineSince: number | null;
  caregiverName: string;
  residentName: string;
}

export type DeadlineDecision =
  | { action: 'none' }
  | { action: 'open_followup'; reason: string; context: string[] };

export function evaluateDeadline(input: DeadlineInput, now: number): DeadlineDecision {
  if (input.status !== 'scheduled') return { action: 'none' };
  if (input.hasConfirmation || input.hasOpenFollowup) return { action: 'none' };
  if (now < input.confirmBy) return { action: 'none' };

  const reason = `${input.caregiverName} has not confirmed this visit, and the confirm-by time has passed.`;
  const context: string[] = [];
  if (input.matchedEventCount > 0) {
    context.push(
      `Ring recorded ${input.matchedEventCount} door event${input.matchedEventCount === 1 ? '' : 's'} near the visit time. ` +
        'That shows activity at the door, not who it was or whether the visit happened.',
    );
  } else {
    context.push(
      'Ring recorded no door activity near the visit time. That alone does not mean anything is wrong: ' +
        'visitors may use another door, motion zones may not cover them, or events may arrive late.',
    );
  }
  if (input.deviceOfflineSince !== null) {
    context.push('The selected Ring device reported itself offline, so door activity may be missing.');
  }
  context.push(`Next step: contact ${input.caregiverName}, or check in with ${input.residentName} directly.`);
  return { action: 'open_followup', reason, context };
}
