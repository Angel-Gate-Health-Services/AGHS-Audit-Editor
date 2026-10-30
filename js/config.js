// Everything that shapes the audit lives here: organisation details, sites,
// the questions asked per shift, and the fixed text printed in every PDF.

// Semantic version: MAJOR.MINOR.PATCH (breaking changes, features, fixes).
export const APP_VERSION = '1.0.0';
export const GITHUB_URL = ''; // Add the repository URL when it is created.

export const ORG = {
  name: 'Angel Gate Health Services',
  department: 'Auditing Department',
  version: `AGHS Audit v${APP_VERSION}`,
  reportTitle: 'Internal DSP Documentation Audit',
};

// Sites shipped with the website. Leave this empty: everything in this folder is
// public once hosted, so resident names belong in a sites file imported in the app.
export const DEFAULT_SITES = [];

// AGHS pay schedule: 14-day periods, Sunday to Saturday, paid the Friday after.
// This is the start of pay period 1 of 2026 (12/21/2025 – 01/03/2026, paid 01/09/2026);
// every later period, in 2026 and beyond, follows from it.
export const PAY_PERIOD_ANCHOR = '2025-12-21';

// Printed word-for-word on the first page of every audit.
export const OVERVIEW = [
  'The DSP submissions listed below have been deemed insufficient for professional use cases. The audit log below provides details about each submission and the rationale behind the decision.',
  'The information provided below is based on the information given to the auditing department by the company’s official managers and provided information platforms. The audit log below contains no speculative or alleged information. It highlights repetitive inconsistencies within specific timeframes, clock-ins that do not align with scheduling, and other recorded data such as vague, empty, or incoherent submissions. Additionally, specific notes are included below.',
  'If a single box lists multiple dates or shift times, the infraction applies to the submitted document that matches all of those times and dates, as well as the author. Submissions from a specific DSP official that has repetitive and consistent plagiarism will not be recorded in the audit log but specified in the notes below.',
];

// `flagOn` is the answer that means something is wrong and asks "why".
// Each reason's `text` is the sentence written into the audit log's Reason column.
export const QUESTIONS = [
  {
    key: 'progress',
    short: 'Progress notes',
    title: 'Are the progress notes complete?',
    help: 'Every PCP progress note should be answered, and each answer should relate to its question.',
    flagOn: 'no',
    why: 'Why are the progress notes incomplete?',
    reasons: [
      { key: 'missing', label: 'Progress notes are missing', text: 'The submitted documentation is missing progress notes.' },
      { key: 'copy', label: 'Copy and pasted text', text: 'The submitted documentation contains copy and pasted text within the progress notes.' },
      { key: 'na', label: 'Answers given as “n/a”', text: 'The submitted documentation contains documented PCP progress notes, yet answers given by staff prompt “n/a”.' },
      { key: 'unrelated', label: 'Answers don’t match the questions', text: 'The submitted documentation contains PCP progress note answers that do not correlate with the questions provided.' },
    ],
  },
  {
    key: 'summary',
    short: 'Daily summary',
    title: 'Is the daily summary complete?',
    help: 'The daily summary should be present and describe, in detail, how staff helped the individual.',
    flagOn: 'no',
    why: 'Why is the daily summary incomplete?',
    reasons: [
      { key: 'missing', label: 'No daily summary', text: 'The submitted documentation does not contain a daily summary.' },
      { key: 'vague', label: 'Lacks detail or context', text: 'The daily summary lacks further detailed context.' },
      { key: 'copy', label: 'Copy and pasted text', text: 'The daily summary contains copy and pasted text.' },
      { key: 'help', label: '“How did you help” not answered', text: 'The daily summary does not describe how staff helped the individual.' },
    ],
  },
  {
    key: 'missing',
    short: 'Required documentation',
    title: 'Is any required documentation missing?',
    help: 'Attendance, outcomes, or any other part of the submission that should be there.',
    flagOn: 'yes',
    why: 'What is missing?',
    reasons: [
      { key: 'attendance', label: 'Attendance data', text: 'The submitted documentation is missing attendance data.' },
      { key: 'outcomes', label: 'Outcomes not documented', text: 'The submitted documentation does not document all required outcomes.' },
      { key: 'empty', label: 'Submission is empty', text: 'The submitted documentation does not contain any information.' },
      { key: 'clockin', label: 'Clock-in doesn’t match the schedule', text: 'The clock-in for this shift does not align with scheduling.' },
    ],
  },
];

// Placeholder examples for the General Notes page; never saved as audit text.
export const GENERAL_EXAMPLES = {
  recommendations: [
    {
      title: 'Recommendation for Progress notes',
      text: 'If an activity is offered but did not occur, or a different activity is done in place of the chosen activity, it is recommended to state under the outcome that the activity may have not occurred, and what other activity took place. When documenting “Did you offer this on {Date}”: Choose yes, and type your answer.',
    },
    {
      title: 'Recommendation for daily summary',
      text: 'Under the “How did you help this individual” section, please give every answer thoroughly with 1-2 detailed sentences. If you did not help the individual do not choose any options. Although it is expected that every documenting DSP staff has helped the individual in some way.',
    },
  ],
  closing: 'These recommendations should be given to all locations within AGHS.',
};
