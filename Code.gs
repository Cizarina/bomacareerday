/**
 * WG2 Boma Career Day 2026 — Team & Task Coordination App
 * Backend: Google Apps Script Web App (JSON API over this Sheet)
 *
 * SETUP (one time):
 *  1. In the Google Sheet this script is bound to, run `setupSheets` once
 *     from the Apps Script editor (select it in the dropdown, click Run).
 *     This creates the "Team" and "Tasks" tabs and seeds them with the
 *     current WG2 roster and task tracker.
 *  2. Deploy > New deployment > type "Web app".
 *     - Execute as: Me
 *     - Who has access: Anyone
 *  3. Copy the deployment URL (ends in /exec) into app.js as API_URL.
 *
 * Re-running `setupSheets` later will NOT wipe existing data — it only
 * creates the tabs/headers if they don't already exist.
 */

const TEAM_SHEET = "Team";
const TASKS_SHEET = "Tasks";
const STUDENTS_SHEET = "Students";
const ATTENDANCE_SHEET = "Attendance";
const CLUSTERS_SHEET = "Clusters";
const CAREERS_SHEET = "Careers";
const LOG_SHEET = "ActivityLog";
const FEEDBACK_SHEET = "Feedback";
const CHAT_SHEET = "Chat";
const SETTINGS_SHEET = "Settings";
const CLASSES_SHEET = "Classes";
const SCHEDULE_SHEET = "Schedule";
const MENTOR_APPLICATIONS_SHEET = "MentorApplications";
const MENTOR_SURVEY_SHEET = "MentorSurvey";
const PRIVATE_CHAT_SHEET = "PrivateChat";
const GROUP_CHAT_SHEET = "GroupChat";
const TEAM_FILES_SHEET = "TeamFiles";
const SESSION_SIGNUPS_SHEET = "SessionSignups";
const POLLS_SHEET = "Polls";
const POLL_VOTES_SHEET = "PollVotes";

// Drive folder chat attachments and Shared Team Files are saved into —
// created automatically on first use (see getAttachmentsFolder_ below), so
// there's no manual Drive setup step. Files are set to "anyone with the
// link can view," since team sign-in is by name+PIN, not a Google account,
// so a file shared only to specific Google accounts would be unopenable for
// most of the team.
const ATTACHMENTS_FOLDER_NAME = "WG2 App Attachments";

// Attachments are capped client-side too (see MAX_ATTACHMENT_BYTES in
// app.js), but this is the real enforcement point — never trust the client
// alone. Keeps a single bad upload from ballooning Drive usage or a request
// past Apps Script's payload limits.
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5MB

// Mentor Database profile photos — deliberately much smaller than the
// general attachment cap above: these are small headshots shown at gallery
// thumbnail size, not documents, so 1MB keeps the shared Drive folder and
// page-load times sane even with 100+ mentors uploading one each.
const MAX_PROFILE_PHOTO_BYTES = 1 * 1024 * 1024; // 1MB

// Every outgoing email from this app (sign-in PINs, mentor confirmations,
// QR codes, class/team broadcast emails) sends AS this address, not as
// whichever Google account happens to own/run the script — so recipients
// always see one consistent official identity.
//
// IMPORTANT — one-time setup this requires: SENDER_EMAIL only works as the
// "from" address once it's added as a verified "Send mail as" alias under
// the SCRIPT-OWNING account's own Gmail settings (that's the account this
// Apps Script project runs as — see "Execute as: Me" in the deployment
// setup notes at the top of this file). In that account's Gmail: Settings
// (gear icon) → See all settings → Accounts and Import → "Send mail as" →
// Add another email address you own → enter SENDER_EMAIL. Google emails a
// one-time verification link TO that inbox, which needs opening/confirming
// once (so whoever owns SENDER_EMAIL's inbox needs to do that one step).
// After that, SENDER_EMAIL itself never needs any access to this Sheet,
// Drive, or the Apps Script project at all — it's purely a "from" identity,
// so it can stay restricted to the working group as intended. Until the
// alias is verified, Apps Script silently falls back to sending as the
// script-owning account instead (it never throws an error) — so nothing
// breaks in the meantime, you'll just see the old sender until setup is
// done.
const SENDER_EMAIL = "boma.alumnae@gmail.com";
const SENDER_NAME = "WG2 Boma Career Day 2026";
// Live GitHub Pages URL for the app itself — used to build "Sign In" /
// "Change My PIN" links in every email that carries a PIN. If the site is
// ever moved to a different URL, update this one constant.
const APP_URL = "https://cizarina.github.io/bomacareerday/";

// Used to sign login tokens (see makeToken_/verifyToken_ below). Change this
// to your own random string before deploying — treat it like a password.
// Anyone who has this string could forge a login token, but they'd need
// direct access to this Apps Script project to see it, not just the app
// link, so this is meaningfully harder to obtain than the API URL itself.
const SESSION_SECRET = "wg2-boma-2026-CHANGE-THIS-BEFORE-DEPLOYING";
// Students/parents can amend career choices up to this instant — 27 Aug
// 2026, 12:00 EAT (UTC+3) = 09:00 UTC. Enforced server-side in
// publicUpdateStudentChoices_ (see doPost "public_update_student_choices"),
// not just hidden client-side, so it can't be bypassed by calling the API
// directly. Only gates EDITS to an existing registration — NOT new
// registrations, which stay open on whatever schedule WG2 sets separately.
const STUDENT_CHOICE_DEADLINE_ISO = "2026-08-27T09:00:00Z";

// accessLevel: "all" (Lead/Asst Lead — see and manage everything, including
// other people's access levels) | "zone" (see/manage their own zone only) |
// "cluster" (see/manage their own cluster only, the default for anyone new) |
// "intern" (Interns — students/team/attendance scoped the same as "cluster"
// (empty by default, since interns aren't tied to one cluster), but Tasks
// are narrowed to only tasks under Interns, rather than the whole event's
// task tracker) | "class" (Class Teachers — scoped to their own class/
// stream's students only, via the classStream field below, instead of a
// cluster; Tasks are narrowed to tasks under WG8/Class Teachers, the same
// way "intern" narrows to Intern tasks). Only a Lead/Assistant Lead ("all")
// can assign any of these to someone ELSE — but "cluster" and "class" are
// each other's equivalent at self-registration time: a Mentor safely
// defaults to "cluster" and a Class Teacher safely defaults to "class",
// neither is a privilege escalation over the other, just scoped along a
// different axis (cluster vs. class/stream).
// pin: a short code (4-6 digits) the person enters alongside their name to
// sign in — set by a Lead/Assistant Lead when adding them, or regenerated
// any time from the Team tab. Blank pin = this person cannot sign in yet.
// mode: "In-person" (default — assigned room, the only option that existed
// before the event went hybrid) | "Live virtual" (mentor runs their session
// as a live online call) | "Pre-recorded" (mentor supplies a video instead
// of a live session). Only meaningful for role "Mentor"; blank is treated
// as "In-person" everywhere in the client. sessionLink: the Zoom/Meet link
// for "Live virtual", or the video link for "Pre-recorded" — blank for
// in-person mentors. classStream: which class/stream a Class Teacher (role
// "Class Teacher") is the point person for — a name from the Classes sheet
// (e.g. "4 East"), NOT a zone/cluster; blank for every other role. All
// three appended at the END on purpose — see the note on STUDENTS_HEADERS
// below on why (migrateHeaders_ preserves position alignment on a live
// sheet that predates these fields).
// shifts: which part of the day a Mentor is actually on-site for — copied
// straight from their Mentor Application's own "shifts" answer (the
// checkbox group on the public registration form: "Morning shift" /
// "Afternoon shift" / "Either / both shifts", comma-joined if more than one
// is picked) at approval time (see approveMentorApplication_). Blank for
// every non-mentor role. This is what the printed mentor ticket shows
// instead of a day-of itinerary, since mentors don't have one — see
// mentorShiftLabel_ in app.js for how it's turned into display text.
// Appended at the very end for the same migrateHeaders_ reason as above.
// leadershipInterest/leadershipStatus — appended at the very end, same
// migrateHeaders_ reason as above. leadershipInterest is a comma-joined
// list of canonical role names ("Cluster Lead" / "Sub-Lead" / "Zone
// Coordinator") someone has expressed interest in, from either the public
// mentor application's "additional role" checkboxes or their own
// self-service request in the app. leadershipStatus is "" (no interest on
// file), "Pending" (raised, not yet reviewed), "Approved" (their `role`
// field has been updated to match), or "Declined" (reviewed, not
// promoted — role left as-is). See requestLeadershipRole_/
// approveLeadershipRole_/declineLeadershipInterest_.
// secondaryCluster/secondaryClusterConfirmed — appended at the very end,
// same migrateHeaders_ reason as above. secondaryCluster is a mentor's
// backup-choice cluster (e.g. "B2 Engineering & Manufacturing"), carried
// over from their application's own secondaryCluster answer at approval
// time (see approveMentorApplication_) — always recorded even when it
// wasn't needed, so "who'd consider helping cluster X" queries work
// regardless of where someone actually ended up. On its own this is JUST a
// listing: it does NOT count toward that cluster's mentor/shift totals
// anywhere (clusterStats/computeClusterCommandData_ in app.js only ever
// count a mentor once, against their real `cluster`). secondaryClusterConfirmed
// is "" (a mere backup listing) or "Yes" (an admin has actively pulled this
// person in as a genuine second, dual-cluster commitment for the day — see
// reassignMentorCluster_ mode "dual") — only when "Yes" does
// computeClusterCommandData_ count them toward the secondary cluster's
// shift coverage too, and only for whichever shift isn't already spoken
// for by their primary cluster.
const TEAM_HEADERS = ["id", "name", "phone", "email", "role", "zone", "cluster", "status", "notes", "updatedAt", "accessLevel", "pin", "mode", "sessionLink", "classStream", "shifts", "preferredContact", "leadershipInterest", "leadershipStatus", "secondaryCluster", "secondaryClusterConfirmed", "photoUrl", "bio", "yearsParticipated"];
const TASKS_HEADERS = ["id", "phase", "task", "owner", "delegable", "due", "status", "state", "ref", "notes", "updatedAt"];
// cohort: "F4" | "G10A" | "G10B". choices: comma-separated cluster IDs, ranked, e.g. "B1,C2,A1,D3,E2,B5"
// — DERIVED from careerChoices below (never entered directly by a student since the career-first
// registration redesign; still hand-editable by staff via register_student for walk-ins).
// round1..round4: cluster ID once allocation runs (e.g. "B1") — blank until then.
// teacherEmail/teacherName: a class shares ONE contact (usually the class
// teacher), not one email per student — captured once at bulk-import time
// and stored on every student row in that batch. New columns are appended
// at the END of this array on purpose: migrateHeaders_() (below) adds any
// missing header to the END of an existing live sheet too, so position
// alignment between this array and the real sheet columns is preserved on
// every re-run of setupSheets(), even on a sheet that predates this field.
const STUDENTS_HEADERS = [
  "id", "name", "admissionNo", "classStream", "cohort", "choices",
  "round1", "round2", "round3", "round4",
  "status", "notes", "createdAt", "updatedAt",
  "teacherEmail", "teacherName",
  "email", // the STUDENT's own email (optional) — separate from teacherEmail above,
           // used only to email this one student their own QR code (email_own_qr).
  // Parent/guardian consent — only ever populated by the PUBLIC, no-sign-in
  // registration screen (see publicRegisterStudent_), since students are
  // minors and that screen is the one path where nobody on the WG2 team is
  // present to vouch for who's filling it in. Blank for every student
  // registered the normal way (bulk import, walk-in, on-the-spot by staff),
  // since a class teacher or intern present in person already IS the
  // adult-in-the-room check. parentConsent is literally "Yes" or blank —
  // there's no "No", since the form can't be submitted without it checked.
  "parentName", "parentContact", "parentConsent", "consentAt",
  // Career-first registration (see SEED_CAREERS/CAREERS_HEADERS above).
  // careerChoices: comma-separated CAREER ids, ranked, e.g.
  // "CR004,CR153,CR025" — what the student actually picked on the form.
  // "choices" above stays the derived, ranked CLUSTER-id list (each career
  // resolved to its clusterId, de-duplicated, in the same order) so every
  // existing downstream system — allocation (allocateStudents_), CSV
  // export, dashboards — keeps working unchanged on cluster ids. Editing
  // careerChoices (see public_update_student_choices) always re-derives
  // "choices" from scratch, so the two never drift apart. otherCareerRequest:
  // free text the student typed for a career not on the list — blank if
  // unused. otherCareerClusterId: the cluster suggestClusterFit_ matched
  // that free text to (blank if no text given, or no confident match) —
  // also appended onto the end of "choices" as an extra, lowest-priority
  // pick so she has a real shot at being placed there, and triggers a
  // system note to that cluster's zone group chat (see
  // notifyZoneOfCareerRequest_) so cluster leads know it was asked for.
  // All three appended at the END on purpose, same reasoning as the fields
  // above — migrateHeaders_ preserves position alignment on a live sheet.
  "careerChoices", "otherCareerRequest", "otherCareerClusterId",
  // Every student gets exactly 3 standard mentorship rounds now (see
  // SEED_SCHEDULE) — round4 is an OPTIONAL extra that only exists for
  // students who privately arrange it in advance with WG2, so the right
  // mentor can be pre-notified and prepared rather than surprised by an
  // unplanned 4th visitor. spilloverApproved is literally "Yes" or blank —
  // set by a Lead/Assistant Lead/Zone Coordinator (see set_student_spillover)
  // once that arrangement is actually made. runAllocation_ only ever fills
  // round4 for students where this is "Yes" — never automatically for
  // everyone, even if they ranked 4+ choices. Appended at the END, same
  // reasoning as every field above.
  "spilloverApproved",
];
// type: "Student" | "Team". method: "QR" | "Manual" | "Walk-in".
const ATTENDANCE_HEADERS = ["timestamp", "type", "personId", "personName", "round", "room", "method", "checkedInBy"];
// The 23-cluster / 5-zone structure, matching every other WG2 Career Day
// document. "room" is the ACTUAL physical location hosting that cluster on
// the day (e.g. "1K1", "4S2", "Senior Corridor") — edit it any time from
// Dashboard -> Room Assignments as the real school room list firms up;
// it starts out equal to the cluster id (e.g. "A1") as a placeholder only.
const CLUSTERS_HEADERS = ["id", "zone", "room", "name", "capacity"];
// Every specific career a student can choose on the registration form —
// deliberately a level BELOW Clusters, since a Form 4/Grade 10 girl usually
// knows "I want to be a Surgeon" long before she knows that sits under
// "Medical Practitioners" in "Zone A". clusterId links each career back to
// the cluster that will host mentors in that field on the day (see
// SEED_CAREERS below), so the student-facing vocabulary is career names
// while every downstream system (allocation, rooms, capacity) still runs on
// cluster ids exactly as before. description: one plain-language sentence,
// shown on the registration form and reused in the Careers & Clusters Guide.
const CAREERS_HEADERS = ["id", "name", "clusterId", "description"];
const LOG_HEADERS = ["timestamp", "who", "action", "targetId", "detail"];
// category: "Bug" | "Question" | "Suggestion" | "Other". status: "Open" | "Resolved".
const FEEDBACK_HEADERS = ["id", "timestamp", "who", "category", "screen", "message", "status", "reply", "updatedAt"];
// attachmentUrl/attachmentName: optional, set when a message carries a file
// (see saveAttachment_) — appended at the end so migrateHeaders_ can add
// them to an already-live sheet without disturbing existing rows/data.
const CHAT_HEADERS = ["id", "timestamp", "who", "message", "attachmentUrl", "attachmentName"];
// 1:1 direct messages, separate from the whole-team broadcast Chat above —
// only the two participants (fromId/toId) ever see a given row; see
// visiblePrivateChat_. readByRecipient: "Yes" | "No", flipped by
// mark_private_read once the recipient has opened that thread — drives the
// unread badge in the client.
const PRIVATE_CHAT_HEADERS = ["id", "timestamp", "fromId", "fromName", "toId", "toName", "message", "readByRecipient", "attachmentUrl", "attachmentName"];
// Group channels — membership is COMPUTED from the Team roster every time
// (zone letter, role, accessLevel), never a stored member list, so nobody
// has to remember to add/remove someone from a group when their role
// changes; see myGroupIds_. Fixed group ids: "zone-A".."zone-E" (everyone
// working that zone — mentors, cluster/sub-leads, the Zone Coordinator),
// "class-teachers" (every Class Teacher / WG8 liaison), "leads-interns"
// (Leads, Assistant Leads, Interns). Leads/Assistant Leads ("all" access)
// are members of every group, same "see and manage everything" reasoning
// as the rest of their access level.
const GROUP_CHAT_HEADERS = ["id", "timestamp", "groupId", "who", "whoId", "message", "attachmentUrl", "attachmentName"];
const ALL_GROUP_IDS = ["zone-A", "zone-B", "zone-C", "zone-D", "zone-E", "class-teachers", "leads-interns"];
// Shared Team Files — a standing library, independent of any one chat
// thread, for things the team needs to find again later (room assignment
// sheets, updated rosters, meeting notes). Same core-team audience as the
// Docs & Orientation tab (canViewDocs()/role !== "Mentor"), enforced both
// client- and server-side (see the "team_files"/"upload_team_file" actions).
const TEAM_FILES_HEADERS = ["id", "timestamp", "uploadedBy", "uploadedById", "fileName", "fileUrl", "description"];
// Simple key/value store for event-wide settings that don't belong to any
// one sheet — currently the room map image link and who to contact about
// room coordination/mapping. Read by everyone signed in (like Clusters);
// written by Lead/Assistant Lead/Zone Coordinator/Intern (see doPost) —
// interns are included on purpose, since "room coordination and mapping"
// is exactly the kind of thing that gets delegated to an intern.
const SETTINGS_HEADERS = ["key", "value", "updatedAt"];
// cohort: "F4" | "G10A" | "G10B". name: the actual class/stream name (e.g.
// "4 East", "10 Amani") — kept as a managed list (rather than free text on
// the registration form) so a typo doesn't create a phantom class that
// never shows up in "My Class". Seeded empty on purpose: the example
// names used during development ("Form 4 East", "Grade 10 Amani", "Grade
// 10 Baraka") aren't real KHS classes — add the real ones from Dashboard ->
// Classes & Streams before registration opens.
const CLASSES_HEADERS = ["id", "cohort", "name", "updatedAt"];
// One row per (cohort, round) giving the actual clock time that round
// runs — separate from CLUSTERS (which room) and from a student's own
// round1..round4 (which cluster). id is "<cohort>-R<round>" so it's
// human-readable in the Sheet and stable to update. G10B's times are
// seeded blank on purpose: the source Coordination Playbook itself only
// says Slot 3 "follows the same pattern... full clock in the companion
// Draft Programme" — filling in a guessed time would be worse than
// leaving it for a Lead/Assistant Lead/Zone Coordinator/Intern to confirm
// and enter for real once that's set.
const SCHEDULE_HEADERS = ["id", "cohort", "round", "startTime", "endTime", "updatedAt"];
// One row per mentor per round-they're-staffing — the round sign-up grid's
// backing data. `scheduleId` is a Schedule row id (e.g. "F4-R2") — only rows
// with a numeric round ("1".."4", an actual mentorship round, never a
// Lab/Lunch/Exhibition label) ever get a signup. Capacity (up to 4 mentors
// per round per cluster, see claimSessionSlot_) is enforced here, not just
// in the UI, so two people tapping "Join" at the same moment can't both
// squeeze a 5th mentor into a full round.
const SESSION_SIGNUPS_HEADERS = ["id", "scheduleId", "cohort", "round", "clusterId", "mentorId", "mentorName", "timestamp"];
const SESSION_ROUND_CAPACITY = 4;
// Generic in-app polls — e.g. mentor availability for an induction/update
// meeting, or any other yes/no or multiple-choice question WG2 needs a
// quick read on. `options` is a JSON-stringified array of option text.
// `audienceLabel` is informational only (e.g. "Mentors", "Zone B") — it
// does NOT restrict who can vote; every signed-in person can vote on every
// poll, kept deliberately simple rather than building a whole second
// visibility-scoping system on top of Team/Tasks/etc.
const POLLS_HEADERS = ["id", "question", "options", "allowMultiple", "audienceLabel", "createdBy", "createdById", "createdAt", "closesAt", "status"];
// One row per voter per poll — re-voting overwrites this row (see
// votePoll_) rather than adding a second one, so a tally never double
// counts someone who changed their mind. optionIndexes is a comma-joined
// list of chosen option indexes (e.g. "0" or "0,2" for a multi-select poll).
const POLL_VOTES_HEADERS = ["id", "pollId", "voterId", "voterName", "optionIndexes", "timestamp"];
// Public, no-sign-in mentor self-registration (see publicRegisterMentor_).
// Anyone with the app link can submit one of these without a PIN — it is
// NOT a Team row and grants no access on its own. A Lead/Assistant Lead
// reviews it (Dashboard -> Mentor Applications) and either approves it
// (which creates the real Team row, auto-generates a PIN, and emails that
// PIN to the applicant — see approveMentorApplication_) or rejects it.
// status: "Pending" | "Approved" | "Rejected". exbomarian: "Yes" | "No".
// refereeName/refereeContact: only meaningful when exbomarian = "No".
// primaryCluster/secondaryCluster: cluster IDs (e.g. "B3"), not full names —
// resolved against the Clusters sheet everywhere they're displayed.
// shifts/additionalRole: comma-separated (checkbox questions on the form).
// teamMemberId: set once approved, links back to the Team row it created.
// linkedinOrProfile: OPTIONAL, voluntary — a LinkedIn URL or any other
// profile/portfolio link the applicant chooses to share, purely to help the
// AI/heuristic cluster-fit matcher (see suggestClusterFit_/
// suggestMentorFit_) identify a better or additional cluster match; never
// required to complete registration. suggestedClusterId/suggestedClusterName/
// aiStrengthsSummary are INTERNAL-ONLY fields (never shown on the public
// form or to the applicant) — computed automatically at submission via the
// heuristic matcher (see publicRegisterMentor_), and refreshable any time by
// an admin via suggest_mentor_fit once a LinkedIn/profile link or fuller bio
// is on file. mode: "In-person" | "Live virtual" | "Pre-recorded" — how the
// applicant plans to take part, asked directly on the public form now (used
// to default to "In-person" for every mentor with no way to say otherwise).
// Carried straight through to the Team row's own "mode" field at approval
// time — see approveMentorApplication_. All appended at the END on purpose,
// same reasoning as STUDENTS_HEADERS above — keeps position alignment on a
// live sheet.
const MENTOR_APPLICATIONS_HEADERS = [
  "id", "submittedAt", "status",
  "exbomarian", "refereeName", "refereeContact", "gradYear",
  "name", "phone", "email", "preferredContact",
  "jobTitle", "organisation", "profession", "yearsExperience", "bio",
  "primaryCluster", "secondaryCluster",
  "shifts", "additionalRole", "priorMentor", "briefingAttend",
  "tshirtSize", "accessNeeds", "consent", "notes",
  "teamMemberId", "reviewedBy", "reviewedAt", "reviewNotes",
  "linkedinOrProfile", "suggestedClusterId", "suggestedClusterName", "aiStrengthsSummary",
  "mode",
];
const SEED_MENTOR_APPLICATIONS = [];

// Mentor Feedback Survey — filled in-app on/immediately after Career Day by
// any signed-in team member (Mentors, Cluster Leads, Sub-Leads, Zone
// Coordinators all mentor students in some form). One row per person:
// submitting again UPDATES their existing row rather than adding a
// duplicate (see submitMentorSurvey_) — that's what makes "who hasn't
// responded yet" a simple diff against the Team roster. Modelled on the
// Society's own Mentors' Feedback Questionnaire lineage (2018-2024, from
// the shared "Mentors - FEEDBACK QUESTIONNAIRES" Drive folder), trimmed for
// a mobile in-app form: anything already on file (name, contact, cluster,
// professional background) isn't re-asked. rating* fields are 1-5
// (5=Excellent ... 1=Needs Improvement, same scale used every year since
// 2018) so they're simple to average for the admin analytics view.
const MENTOR_SURVEY_HEADERS = [
  "id", "submittedAt", "teamMemberId", "name", "cluster",
  "attended", "mentorsInCluster", "studentsMet",
  "ratingCommunicationPrior", "ratingTimeFormatInfo", "ratingParking", "ratingRoomSetup",
  "ratingSupport", "ratingSessionDuration", "ratingStudentQuestions", "ratingStudentCommunication",
  "ratingStudentBehaviour", "ratingStudentEngagement", "ratingOverallOrganisation",
  "attendNextYear", "internshipsAvailable", "internshipListings", "jobShadowing", "openToFutureNetwork",
  "commentsExpand", "commentsForMentors", "commentsForStudents", "commentsOther",
];
const SEED_MENTOR_SURVEY = [];

// Historical Mentor Database — a consolidated, searchable record of everyone
// who has served as a Boma Career Day mentor/speaker/counsellor/cluster lead
// in past years (2017, 2019, 2022, 2023) plus current WG2/Careers Committee
// leadership, compiled from the Society's own Drive records (KHS Careers
// Progr - WG 2 - MENTORS folder). Purpose: (1) re-inviting past mentors for
// 2026 and future Career Days, (2) resource allocation — matching a person's
// real profession/background to a cluster that needs mentors, even outside
// where they last served, (3) one current reference of who to contact.
// Access: Lead/Assistant Lead, Zone Coordinators, and Interns only (see
// canViewMentorDatabase_) — NOT plain Mentors/Cluster access or Class
// Teachers, since this is internal outreach/resource-allocation data, not
// something every signed-in person needs. primaryClusterId/secondaryCluster*
// are this app's CURRENT 23-cluster ids/names (see SEED_CLUSTERS above) even
// though the source documents used each year's own cluster names — mapped by
// hand during compilation. aiStrengthsSummary/linkedinOrProfile start blank
// and are filled in later, either by an admin running suggest_mentor_fit or
// by the mentor themselves volunteering a profile link on re-registration.
// outreachStatus/outreachNotes are the ONLY fields meant to be edited from
// the app day-to-day (see updateMentorDatabaseEntry_) — everything else is
// historical record, correct as of compilation; fix it in the Sheet directly
// if a name/contact needs correcting.
const MENTOR_DATABASE_SHEET = "MentorDatabase";
const MENTOR_DATABASE_HEADERS = [
  "id", "name", "classOf", "organisation", "designation", "profession",
  "primaryClusterId", "primaryClusterName", "secondaryClusterIds", "secondaryClusterNames",
  "yearsInvolved", "phone", "email", "location",
  "linkedinOrProfile", "aiStrengthsSummary",
  "source", "notes", "outreachStatus", "outreachNotes", "addedAt",
];

const SEED_MENTOR_DATABASE = [
  {"id": "MD001", "name": "Rose Mwendar", "classOf": "", "organisation": "The Kenya High School", "designation": "Faculty Member & Head of Dept: Career Guidance", "profession": "Faculty Member & Head of Dept: Career Guidance", "primaryClusterId": "D5", "primaryClusterName": "Education", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722513629", "email": "akinyimwendar@yahoo.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017 Core Data", "notes": "School Careers Dept", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD002", "name": "Josephine Kimani", "classOf": "", "organisation": "The Kenya High School", "designation": "Dept: Career Guidance", "profession": "Dept: Career Guidance", "primaryClusterId": "D5", "primaryClusterName": "Education", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017 Core Data", "notes": "School Careers Dept", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD003", "name": "Joyce Gatambia", "classOf": "KHS'91", "organisation": "Habitat for Humanity", "designation": "Resource Mobilization & Communication Manager", "profession": "Resource Mobilization & Communication Manager", "primaryClusterId": "C3", "primaryClusterName": "Leadership & Strategic/HR Management", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017,2019", "phone": "+254720106342", "email": "joyce.gatambia@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017/2019", "notes": "Boma'91 XComm Treasurer", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD004", "name": "Carolyne Gathuru", "classOf": "KHS'91", "organisation": "LifeSkills Consulting Ltd", "designation": "Director Strategy & Business Development", "profession": "Director Strategy & Business Development", "primaryClusterId": "C5", "primaryClusterName": "Marketing, PR, Sales, Comms & CX", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017,2019,2022,2023", "phone": "+254722730084", "email": "cgathuru@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017/2019/2022-23", "notes": "2023 Environment & Marketing Cluster Lead, Boma'91 Mentorship Ctte", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD005", "name": "Caroline Kipsanai", "classOf": "KHS'91", "organisation": "Faulu Microfinance Bank", "designation": "Head of Marketing", "profession": "Head of Marketing", "primaryClusterId": "C5", "primaryClusterName": "Marketing, PR, Sales, Comms & CX", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722771688", "email": "carolkoyier@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017, 2017 Core Data", "notes": "Boma'91 XComm Secretary; dup-check name matches above row", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD006", "name": "June Kyula", "classOf": "KHS'91", "organisation": "WAL Hospitality", "designation": "Director", "profession": "Director", "primaryClusterId": "E2", "primaryClusterName": "Hospitality & Tourism", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017,2019,2022,2023", "phone": "+254735699822", "email": "nthenyajune@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017/2019/2022-23", "notes": "Hospitality Cluster Lead 2022-23, Boma'91 Events Lead", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD007", "name": "Jane Freda Marondo", "classOf": "KHS'91", "organisation": "Barclays Bank Kenya", "designation": "Reconciliations Manager", "profession": "Reconciliations Manager", "primaryClusterId": "C1", "primaryClusterName": "Finance & Actuarial Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722851701", "email": "freda.marondo@barclayscorp.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017 Core Data", "notes": "Boma'91 Member", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD008", "name": "Dr. med. Evelyn Ivy Mwangi", "classOf": "KHS'91", "organisation": "Sanford Worthington Hospital (MN, USA)", "designation": "Consultant Physician", "profession": "Consultant Physician", "primaryClusterId": "A1", "primaryClusterName": "Medical Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+14438572482", "email": "Iwmwangi@gmail.com", "location": "Diaspora - USA", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017 Core Data", "notes": "Boma'91 Mentorship Diaspora Rep", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD009", "name": "Priscillah Njako", "classOf": "KHS'91", "organisation": "CUEA / Oshwal Academy", "designation": "Advocate, Lecturer & Faculty Advisor", "profession": "Advocate, Lecturer & Faculty Advisor", "primaryClusterId": "D5", "primaryClusterName": "Education", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017,2019", "phone": "+254733758844", "email": "priscillanjako@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017/2019", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD010", "name": "Maria Nyamai-Mbugua", "classOf": "KHS'91", "organisation": "", "designation": "Commercial Leader: Health Sector", "profession": "Commercial Leader: Health Sector", "primaryClusterId": "C3", "primaryClusterName": "Leadership & Strategic/HR Management", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017,2019,2022,2023", "phone": "+254720392419", "email": "maria20w@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017/2019/2022-23", "notes": "Leadership & Corporate Mgmt Cluster Lead 2019-2023", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD011", "name": "Louise Nyamu-Steinbeck", "classOf": "KHS'91", "organisation": "University of Nairobi", "designation": "Lecturer", "profession": "Lecturer", "primaryClusterId": "D5", "primaryClusterName": "Education", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017,2022,2023", "phone": "+254723503777", "email": "nyamu.steinbeck@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017/2022-23", "notes": "Boma'91 XComm Chair, Plenary WG Lead 2023", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD012", "name": "Sylvia Wanjie-Muniu", "classOf": "KHS'91", "organisation": "Market Diagnostics Int'l / Collin College TX", "designation": "VP Syndicated Data / Associate Professor", "profession": "VP Syndicated Data / Associate Professor", "primaryClusterId": "C1", "primaryClusterName": "Finance & Actuarial Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017,2023", "phone": "+12144509419", "email": "swanjiemuniu@gmail.com", "location": "Diaspora - USA", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017/2023", "notes": "Diaspora WG Lead 2023", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD013", "name": "Frida Wathome", "classOf": "KHS'91", "organisation": "", "designation": "Home & Special Needs Education Advisor", "profession": "Home & Special Needs Education Advisor", "primaryClusterId": "D5", "primaryClusterName": "Education", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722308649", "email": "fwathome@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017 Core Data", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD014", "name": "Warigia Milka Macharia", "classOf": "KHS'90", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "C2", "primaryClusterName": "Entrepreneurship & Innovation", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254725206662", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017 Core Data", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD015", "name": "Hon. Lady Justice Njoki Ndung'u", "classOf": "exKHS", "organisation": "Judiciary of Kenya", "designation": "Supreme Court Judge", "profession": "Supreme Court Judge", "primaryClusterId": "D1", "primaryClusterName": "Legal Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017 Plenary", "notes": "Keynote speaker", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD016", "name": "Eunice Gichangi-Githaara", "classOf": "KHS'91", "organisation": "National Assembly of Kenya", "designation": "Sr Deputy Clerk", "profession": "Sr Deputy Clerk", "primaryClusterId": "D2", "primaryClusterName": "Int'l Relations, Development & Governance", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722838052", "email": "egichangi@yahoo.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017 Plenary", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD017", "name": "Wanjiru \"Ciiru\" Waweru-Waithaka", "classOf": "KHS'92", "organisation": "Funkidz Group Ltd.", "designation": "Founder & CEO", "profession": "Founder & CEO", "primaryClusterId": "C2", "primaryClusterName": "Entrepreneurship & Innovation", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017,2019", "phone": "+254721240634", "email": "ciiru@funkidz.co.ke", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017/2019", "notes": "also listed Applied Arts", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD018", "name": "Carol Musyoka", "classOf": "KHS'90", "organisation": "Caroline Musyoka Consulting", "designation": "CEO", "profession": "CEO", "primaryClusterId": "C2", "primaryClusterName": "Entrepreneurship & Innovation", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254721381144", "email": "carol@carolmusyoka.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017 Speakers", "notes": "Entrepreneurship keynote", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD019", "name": "Sumayya Hassan-Athmani", "classOf": "KHS'91", "organisation": "Azure Energy Ltd. (fmr NOCK)", "designation": "Founder & CEO (fmr MD NOCK)", "profession": "Founder & CEO (fmr MD NOCK)", "primaryClusterId": "C2", "primaryClusterName": "Entrepreneurship & Innovation", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722727319", "email": "ceo@azureblue.co.ke", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017 Speakers", "notes": "Leadership keynote", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD020", "name": "Adema Sangale", "classOf": "KHS'92", "organisation": "World Bicycle Relief (fmr P&G, UNEP)", "designation": "VP Africa", "profession": "VP Africa", "primaryClusterId": "C3", "primaryClusterName": "Leadership & Strategic/HR Management", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254724025447", "email": "sangaleadema@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017 Speakers", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD021", "name": "Dr. phil. Wanjiru Kamau-Rutenberg", "classOf": "", "organisation": "African Women in Agricultural Research & Development (AWARD)", "designation": "Director", "profession": "Director", "primaryClusterId": "B5", "primaryClusterName": "Agriculture, Food & Agribusiness", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "", "email": "wanjirukr@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017 Speakers", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD022", "name": "Hon. Lady Justice Mary Gitumbi", "classOf": "KHS'91", "organisation": "Judiciary of Kenya", "designation": "High Court Judge", "profession": "High Court Judge", "primaryClusterId": "D1", "primaryClusterName": "Legal Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254725751305", "email": "marygitumbi@yahoo.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017 Speakers", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD023", "name": "Capt. Irene Koki Mutungi", "classOf": "Mso'92", "organisation": "Kenya Airways", "designation": "Commercial Pilot", "profession": "Commercial Pilot", "primaryClusterId": "B6", "primaryClusterName": "Aviation, Aerospace & Maritime", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017,2019", "phone": "+254722776602", "email": "Irenemutungi@yahoo.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017/2019", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD024", "name": "Amani Maranga", "classOf": "", "organisation": "360 Africa", "designation": "Director", "profession": "Director", "primaryClusterId": "E1", "primaryClusterName": "Journalism & The Media", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254726868787", "email": "Amani@360degrees.co.ke", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "EmCee", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD025", "name": "Evelyn Mawia Muthangya", "classOf": "KHS'93", "organisation": "Braeburn Garden Estate", "designation": "Faculty Member (Preparatory)", "profession": "Faculty Member (Preparatory)", "primaryClusterId": "D5", "primaryClusterName": "Education", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017,2019,2022,2023", "phone": "+254722296024", "email": "emuthangya@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017/2019/2022-23", "notes": "Education Cluster Lead 2019-2023", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD026", "name": "Rachel Aondo", "classOf": "KHS'91", "organisation": "International School of Kenya", "designation": "Faculty Member (Music)", "profession": "Faculty Member (Music)", "primaryClusterId": "D5", "primaryClusterName": "Education", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722393330", "email": "rachelaondo@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD027", "name": "Cynthia Pereira-Kapasa", "classOf": "", "organisation": "Braeburn Garden Estate", "designation": "Faculty Member (Secondary)", "profession": "Faculty Member (Secondary)", "primaryClusterId": "D5", "primaryClusterName": "Education", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254708990272", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD028", "name": "Dr. phil. Jane Munga", "classOf": "KHS'92", "organisation": "Ministry of Education (Cabinet Secretary Office)", "designation": "Technical Advisor on Policy", "profession": "Technical Advisor on Policy", "primaryClusterId": "D5", "primaryClusterName": "Education", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254711946287", "email": "Jmunga@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD029", "name": "Dr. chem. Damaris Mbui", "classOf": "KHS'91", "organisation": "University of Nairobi", "designation": "Senior Lecturer", "profession": "Senior Lecturer", "primaryClusterId": "B3", "primaryClusterName": "Earth Sciences, Energy & Mining", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254723322033", "email": "damaris.mbui@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "also relevant D5 Education", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD030", "name": "Dr. phil. Jane Wathuta", "classOf": "KHS'91", "organisation": "Strathmore Law School", "designation": "Lecturer", "profession": "Lecturer", "primaryClusterId": "D1", "primaryClusterName": "Legal Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254707244049", "email": "jane.wathuta@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "also D5 Education", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD031", "name": "Anne Nderitu", "classOf": "KHS'91", "organisation": "Alliance Girls' High School", "designation": "Faculty Member & Form 1 Principal", "profession": "Faculty Member & Form 1 Principal", "primaryClusterId": "D5", "primaryClusterName": "Education", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254720514401", "email": "annenyaguthi@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD032", "name": "Dorothy Akinyi Agere", "classOf": "KHS'91", "organisation": "Olasi Mixed Secondary School", "designation": "Principal", "profession": "Principal", "primaryClusterId": "D5", "primaryClusterName": "Education", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254721426695", "email": "Dorothyakinyi744@yahoo.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD033", "name": "Dr. pharm. Jacqueline \"Bugo\" Kamau", "classOf": "KHS'92", "organisation": "J. Kamau & Associates Pharma Consultants", "designation": "Founder & Lead Consultant", "profession": "Founder & Lead Consultant", "primaryClusterId": "C2", "primaryClusterName": "Entrepreneurship & Innovation", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017,2022,2023", "phone": "+254700606900", "email": "Jkassociatespharmaconsultants@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017/2022-23", "notes": "also A1 Medical (Pharmacist), Medical Talk Lead 2023", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD034", "name": "Maureen Murunga", "classOf": "", "organisation": "Amadiva Ltd.", "designation": "Founder & CEO", "profession": "Founder & CEO", "primaryClusterId": "C2", "primaryClusterName": "Entrepreneurship & Innovation", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722710341", "email": "maureen65@hotmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD035", "name": "Waceke Nduati-Omanga", "classOf": "KHS'94", "organisation": "Centonomy Ltd.", "designation": "Founder & CEO", "profession": "Founder & CEO", "primaryClusterId": "C2", "primaryClusterName": "Entrepreneurship & Innovation", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722997284", "email": "waceke@centonomy.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD036", "name": "Dr. paed. Deborah Omeddo", "classOf": "KHS'94", "organisation": "Ministry of Health - Kisii County", "designation": "Consultant Paediatrician", "profession": "Consultant Paediatrician", "primaryClusterId": "A1", "primaryClusterName": "Medical Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017,2022,2023", "phone": "+254721788002", "email": "deborahomeddo73@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017/2022-23", "notes": "Medical Practitioners Cluster Lead 2022-23 (Physicians)", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD037", "name": "Dr. pharm. Moraa Kiangoi", "classOf": "KHS'95", "organisation": "Leleshwa Pharmacy", "designation": "Founder, Director & Pharmacist", "profession": "Founder, Director & Pharmacist", "primaryClusterId": "A1", "primaryClusterName": "Medical Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254702564235", "email": "moraa@leleshwapharmacy.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD038", "name": "Dr. anae. Summary Sitima", "classOf": "KHS'06", "organisation": "", "designation": "Anaesthesiologist", "profession": "Anaesthesiologist", "primaryClusterId": "A1", "primaryClusterName": "Medical Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254718009698", "email": "summersitima@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD039", "name": "Dr. dent. Linda Kang'ara-Olweny", "classOf": "Saints'89", "organisation": "Sunrise Crisis & Recovery Centre", "designation": "Chair Board of Trustees & Dental Surgeon", "profession": "Chair Board of Trustees & Dental Surgeon", "primaryClusterId": "A1", "primaryClusterName": "Medical Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722699677", "email": "drlkangara@yahoo.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD040", "name": "Dr. dent. Nduta Kaguongo", "classOf": "KHS'94", "organisation": "Serene Dental Care", "designation": "Partner / Dentist", "profession": "Partner / Dentist", "primaryClusterId": "A1", "primaryClusterName": "Medical Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254720732092", "email": "nduta.kaguongo@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD041", "name": "Dr. med. Elizabeth Wala", "classOf": "AGHS'94", "organisation": "Amref Health Africa", "designation": "Programme Director: Health Systems Strengthening", "profession": "Programme Director: Health Systems Strengthening", "primaryClusterId": "A1", "primaryClusterName": "Medical Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722775932", "email": "lizwala@yahoo.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "fmr CEO Kenya Medical Association", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD042", "name": "Dr. med. Jacqueline Kitulu", "classOf": "PB'90", "organisation": "Kenya Medical Association / Karen Surgery", "designation": "Chair KMA / Family Physician", "profession": "Chair KMA / Family Physician", "primaryClusterId": "A1", "primaryClusterName": "Medical Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722238514", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD043", "name": "Connie Aluoch", "classOf": "KHS'95", "organisation": "Connie Aluoch Styling Management", "designation": "Founder & CEO", "profession": "Founder & CEO", "primaryClusterId": "E3", "primaryClusterName": "The Arts — Applied, Visual, Performing & Literary", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017,2019", "phone": "+254711919699", "email": "connie@conniealuoch.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017/2019", "notes": "also E1 Journalism (fashion blogger), Arts Cluster Lead 2019", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD044", "name": "Julie Masiga", "classOf": "KHS'95", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "E1", "primaryClusterName": "Journalism & The Media", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254713217289", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD045", "name": "Lucia Musau", "classOf": "", "organisation": "", "designation": "Fashion blogger", "profession": "Fashion blogger", "primaryClusterId": "E1", "primaryClusterName": "Journalism & The Media", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254721616745", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD046", "name": "Elizabeth Nyambane", "classOf": "AGHS'95", "organisation": "Wacha ni Kwambie", "designation": "Motivational Writer/Blogger", "profession": "Motivational Writer/Blogger", "primaryClusterId": "E1", "primaryClusterName": "Journalism & The Media", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722784574", "email": "liznyambane@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD047", "name": "Isaac Gabantu", "classOf": "", "organisation": "Agency X", "designation": "Founder & CEO", "profession": "Founder & CEO", "primaryClusterId": "E1", "primaryClusterName": "Journalism & The Media", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254715003975", "email": "igabantu@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD048", "name": "Angela Silima Muchai", "classOf": "", "organisation": "Multimedia University", "designation": "Lecturer", "profession": "Lecturer", "primaryClusterId": "E1", "primaryClusterName": "Journalism & The Media", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254723860714", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD049", "name": "Joyce Ang'wech Lukwiya", "classOf": "KHS'97", "organisation": "East Africa Magazines", "designation": "Online Environment Journalist", "profession": "Online Environment Journalist", "primaryClusterId": "E1", "primaryClusterName": "Journalism & The Media", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254724317324", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD050", "name": "Felista Wangari", "classOf": "KHS'03", "organisation": "Nation Media Group", "designation": "Health & Science Journalist", "profession": "Health & Science Journalist", "primaryClusterId": "E1", "primaryClusterName": "Journalism & The Media", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254734202990", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD051", "name": "Mwihaki Muraguri", "classOf": "KHS'90", "organisation": "Paukwa (fmr Rockefeller Foundation)", "designation": "Motivational Writer & Blogger", "profession": "Motivational Writer & Blogger", "primaryClusterId": "E1", "primaryClusterName": "Journalism & The Media", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017,2019", "phone": "+254722491682", "email": "mwihaki@yahoo.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017/2019", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD052", "name": "Carol Radull", "classOf": "", "organisation": "Radio Africa Group Ltd.", "designation": "Head of Bamba Sport", "profession": "Head of Bamba Sport", "primaryClusterId": "E1", "primaryClusterName": "Journalism & The Media", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254721306126", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "also A3 Sports", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD053", "name": "Adelle Onyango", "classOf": "", "organisation": "", "designation": "Radio Journalist", "profession": "Radio Journalist", "primaryClusterId": "E1", "primaryClusterName": "Journalism & The Media", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD054", "name": "Gift Mwaura", "classOf": "", "organisation": "Kijiji Agency Ltd.", "designation": "Digital Manager", "profession": "Digital Manager", "primaryClusterId": "E1", "primaryClusterName": "Journalism & The Media", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254727637071", "email": "gift@kijijiagency.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD055", "name": "June Seif", "classOf": "KHS'06", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "E3", "primaryClusterName": "The Arts — Applied, Visual, Performing & Literary", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254736462450", "email": "kagehi.juneseif@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD056", "name": "Pauline Macharia", "classOf": "", "organisation": "Sparkle 10 Salon", "designation": "Owner", "profession": "Owner", "primaryClusterId": "E3", "primaryClusterName": "The Arts — Applied, Visual, Performing & Literary", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254721808376", "email": "Paulineirosh@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD057", "name": "Suzie Wokabi", "classOf": "", "organisation": "Flame Tree Group", "designation": "Chief Creative Officer & Brand Ambassador (SuzyBeauty)", "profession": "Chief Creative Officer & Brand Ambassador (SuzyBeauty)", "primaryClusterId": "E3", "primaryClusterName": "The Arts — Applied, Visual, Performing & Literary", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254710817817", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD058", "name": "Tei Mukunya", "classOf": "KHS'92", "organisation": "Azuri Health Ltd.", "designation": "Founder & CEO", "profession": "Founder & CEO", "primaryClusterId": "B2", "primaryClusterName": "Engineering & Manufacturing", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254707762777", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "also B5 Agro", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD059", "name": "Kabuki Anyumba", "classOf": "KHS'91", "organisation": "", "designation": "Founder/Director of Innovation & CookBook Author", "profession": "Founder/Director of Innovation & CookBook Author", "primaryClusterId": "B2", "primaryClusterName": "Engineering & Manufacturing", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254728293929", "email": "kabuki@scrumptuouseat.co.ke", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "also B5 Agro", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD060", "name": "Roselyne Gutu", "classOf": "", "organisation": "Creation Aluminium Industry", "designation": "Sales & Marketing", "profession": "Sales & Marketing", "primaryClusterId": "B2", "primaryClusterName": "Engineering & Manufacturing", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254726320655", "email": "rosegutu19@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD061", "name": "Dr. biotech. Linda Davis", "classOf": "LCLimuru", "organisation": "wPOWER Hub (Wangari Maathai Institute)", "designation": "Director of Partnerships", "profession": "Director of Partnerships", "primaryClusterId": "B3", "primaryClusterName": "Earth Sciences, Energy & Mining", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD062", "name": "Jessica Musila", "classOf": "KHS'91", "organisation": "Mzalendo Trust", "designation": "Executive Director", "profession": "Executive Director", "primaryClusterId": "D2", "primaryClusterName": "Int'l Relations, Development & Governance", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254714391812", "email": "jessica.musila@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD063", "name": "Nanjira Sambuli", "classOf": "KHS'05", "organisation": "World Wide Web Foundation", "designation": "Advocacy Leader", "profession": "Advocacy Leader", "primaryClusterId": "D2", "primaryClusterName": "Int'l Relations, Development & Governance", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722481566", "email": "nanjira.sambuli@webfoundation.org", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD064", "name": "Charity Muriuki", "classOf": "KHS'91", "organisation": "Plan International", "designation": "Regional Gender & BIAAG Programme Advisor", "profession": "Regional Gender & BIAAG Programme Advisor", "primaryClusterId": "D2", "primaryClusterName": "Int'l Relations, Development & Governance", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254733586137", "email": "c.e.n.muriuki@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD065", "name": "Betty Adera", "classOf": "KHS'91", "organisation": "Global Communities", "designation": "Chief of Party", "profession": "Chief of Party", "primaryClusterId": "D2", "primaryClusterName": "Int'l Relations, Development & Governance", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254720567590", "email": "badera@globalcommunities.org", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD066", "name": "Juma Assiago", "classOf": "", "organisation": "UN-Habitat", "designation": "Coordinator, Safer Cities Programme", "profession": "Coordinator, Safer Cities Programme", "primaryClusterId": "D2", "primaryClusterName": "Int'l Relations, Development & Governance", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254723402393", "email": "juma.assiago@unhabitat.org", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD067", "name": "Juliana Kisimbi", "classOf": "KHS'92", "organisation": "", "designation": "Team Building & Project Mgmt Consultant", "profession": "Team Building & Project Mgmt Consultant", "primaryClusterId": "D2", "primaryClusterName": "Int'l Relations, Development & Governance", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722411679", "email": "jmkisimbi@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD068", "name": "Wanjiku Muguiyi", "classOf": "KHS'89", "organisation": "UNOPS (United Nations)", "designation": "Project Manager", "profession": "Project Manager", "primaryClusterId": "E4", "primaryClusterName": "The Built Environment & Real Estate", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722986767", "email": "wanjikumuguiyi2010@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD069", "name": "Dr. arch. Paul Aloyo", "classOf": "AHS'91", "organisation": "JKUAT", "designation": "Lecturer", "profession": "Lecturer", "primaryClusterId": "E4", "primaryClusterName": "The Built Environment & Real Estate", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254738672413", "email": "aloyopaul@yahoo.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD070", "name": "Dr. arch. June Gumo-Kidenda", "classOf": "Mso'94", "organisation": "University of Nairobi / Private Consultancy", "designation": "Lecturer / Landscape & Interior Architect", "profession": "Lecturer / Landscape & Interior Architect", "primaryClusterId": "E4", "primaryClusterName": "The Built Environment & Real Estate", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254716079870", "email": "junegumo@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD071", "name": "Roselyne Nduati", "classOf": "Mso'92", "organisation": "Sopa Lodges (Kenya & Tanzania)", "designation": "Director Sales & Marketing, East Africa", "profession": "Director Sales & Marketing, East Africa", "primaryClusterId": "E2", "primaryClusterName": "Hospitality & Tourism", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722762269", "email": "roselyne.nduati@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD072", "name": "Sarah Murimi", "classOf": "LCVR'95", "organisation": "Radisson Blu Nairobi", "designation": "Executive Housekeeper", "profession": "Executive Housekeeper", "primaryClusterId": "E2", "primaryClusterName": "Hospitality & Tourism", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254729572884", "email": "samurimi@yahoo.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD073", "name": "Martin Nthiwa Mulwa", "classOf": "", "organisation": "Event Managers Association (EMA)", "designation": "CEO", "profession": "CEO", "primaryClusterId": "E2", "primaryClusterName": "Hospitality & Tourism", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722530224", "email": "nthiwam@yahoo.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD074", "name": "Adeline Mwaluma", "classOf": "KHS'89", "organisation": "Idyllic Ventures", "designation": "Tours Consultant", "profession": "Tours Consultant", "primaryClusterId": "E2", "primaryClusterName": "Hospitality & Tourism", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254721403597", "email": "info@idyllicventures.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD075", "name": "Dr. Juliana Kyalo", "classOf": "", "organisation": "Kenya Utalii College", "designation": "Senior Lecturer & Member KAWT", "profession": "Senior Lecturer & Member KAWT", "primaryClusterId": "E2", "primaryClusterName": "Hospitality & Tourism", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254717710625", "email": "julianakyalo@yahoo.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD076", "name": "Joyce Kienji", "classOf": "", "organisation": "Eka Hotel", "designation": "Executive Housekeeper & Member KAWT", "profession": "Executive Housekeeper & Member KAWT", "primaryClusterId": "E2", "primaryClusterName": "Hospitality & Tourism", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254733795802", "email": "jkienji@yahoo.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD077", "name": "Faith Wathome-Kithu", "classOf": "exKHS", "organisation": "KAWT / Machakos County Govt", "designation": "Patron KAWT / Exec Committee Member", "profession": "Patron KAWT / Exec Committee Member", "primaryClusterId": "E2", "primaryClusterName": "Hospitality & Tourism", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "", "email": "faith@kawt.or.ke", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD078", "name": "Nyandia Nyamu-Lenehan", "classOf": "SHGHS'94", "organisation": "", "designation": "Event Management Consultant, Member KAWT", "profession": "Event Management Consultant, Member KAWT", "primaryClusterId": "E2", "primaryClusterName": "Hospitality & Tourism", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017,2019,2022,2023", "phone": "+254719516007", "email": "nyandianyamu@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017/2019/2022-23", "notes": "also E1 Journalism (digital space), Hospitality Sub-Lead", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD079", "name": "Emma Nderitu", "classOf": "", "organisation": "Rift Valley Winery", "designation": "Winery Manager & Oenologist", "profession": "Winery Manager & Oenologist", "primaryClusterId": "E2", "primaryClusterName": "Hospitality & Tourism", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254721588115", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD080", "name": "Victoria Mulu-Munywoki", "classOf": "", "organisation": "Wines of the World", "designation": "Wine Director / Consultant Sommelier", "profession": "Wine Director / Consultant Sommelier", "primaryClusterId": "E2", "primaryClusterName": "Hospitality & Tourism", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254706606861", "email": "viki_mulu@hotmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD081", "name": "Capt. Bilha Gohole Amadi", "classOf": "", "organisation": "Kenya Airways Ltd.", "designation": "Commercial Pilot", "profession": "Commercial Pilot", "primaryClusterId": "B6", "primaryClusterName": "Aviation, Aerospace & Maritime", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254720929032", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD082", "name": "Mosa Agina", "classOf": "KHS'97", "organisation": "Kenya Airways Ltd.", "designation": "Senior Engineer", "profession": "Senior Engineer", "primaryClusterId": "B6", "primaryClusterName": "Aviation, Aerospace & Maritime", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017,2022,2023", "phone": "+254722630719", "email": "Mosa.Agina@kenya-airways.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017/2022-23", "notes": "Aviation Cluster Lead 2022-23", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD083", "name": "Eng. civ. Angela Wamola-Janssens", "classOf": "KHS'92", "organisation": "GSMA", "designation": "Strategic Engagement Director, Africa", "profession": "Strategic Engagement Director, Africa", "primaryClusterId": "B1", "primaryClusterName": "Computing, Data & Cyber Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017,2019", "phone": "+254722540814", "email": "Awamola@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017/2019, 2019 Cluster Members", "notes": "STEM Cluster Lead 2019", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD084", "name": "Sheila Koech", "classOf": "KHS'91", "organisation": "Sidai Consulting Limited", "designation": "Principal Consultant", "profession": "Principal Consultant", "primaryClusterId": "B1", "primaryClusterName": "Computing, Data & Cyber Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254701048527", "email": "sheila.koechcbs@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD085", "name": "Dr. Eng. mech. Hussein H. Jama", "classOf": "NS'91", "organisation": "University of Nairobi", "designation": "Lecturer", "profession": "Lecturer", "primaryClusterId": "B2", "primaryClusterName": "Engineering & Manufacturing", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722337788", "email": "hhjama@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD086", "name": "Eng. Phoebe Aoko", "classOf": "", "organisation": "Women in Engineering", "designation": "", "profession": "Women in Engineering", "primaryClusterId": "B2", "primaryClusterName": "Engineering & Manufacturing", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254713585549", "email": "phoebe@womeng.org", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD087", "name": "Njeri Gitau", "classOf": "KHS'91", "organisation": "Copia", "designation": "IT Manager", "profession": "IT Manager", "primaryClusterId": "B1", "primaryClusterName": "Computing, Data & Cyber Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254714434323", "email": "fngitau@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD088", "name": "Agnes Mainye", "classOf": "KHS'05", "organisation": "Iberafrica Power (EA) Ltd.", "designation": "Quality, Environmental & Health & Safety Engineer", "profession": "Quality, Environmental & Health & Safety Engineer", "primaryClusterId": "B2", "primaryClusterName": "Engineering & Manufacturing", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254724740339", "email": "aggshiventa@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD089", "name": "Dr. Charity Wayua", "classOf": "AGHS'02", "organisation": "IBM Research Africa", "designation": "Research Scientist & Manager", "profession": "Research Scientist & Manager", "primaryClusterId": "B1", "primaryClusterName": "Computing, Data & Cyber Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254705477812", "email": "charitywayua@ke.ibm.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD090", "name": "Kate Kavoo", "classOf": "KHS'06", "organisation": "Safaricom", "designation": "Subscriber Data Engineer", "profession": "Subscriber Data Engineer", "primaryClusterId": "B1", "primaryClusterName": "Computing, Data & Cyber Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254723928788", "email": "kavookate@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD091", "name": "Martha Wakoli", "classOf": "KHS'07", "organisation": "Kenya Power Ltd. / Virunga Power", "designation": "Assistant / Electrical Engineer", "profession": "Assistant / Electrical Engineer", "primaryClusterId": "B2", "primaryClusterName": "Engineering & Manufacturing", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017,2019,2023", "phone": "+254725116151", "email": "wakolim@yahoo.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017/2023, 2019 Cluster Members", "notes": "STEM Talk Lead 2023; dup", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD092", "name": "Virginia Kuria", "classOf": "KHS'91", "organisation": "Hands-On Training Solutions", "designation": "Founder & Director", "profession": "Founder & Director", "primaryClusterId": "B2", "primaryClusterName": "Engineering & Manufacturing", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254717594042", "email": "vmuthoni.ndungu@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD093", "name": "Eng. chem. Andrew Amadi", "classOf": "Saints'90", "organisation": "", "designation": "Energy Project Development / Sustainable Energy", "profession": "Energy Project Development / Sustainable Energy", "primaryClusterId": "B3", "primaryClusterName": "Earth Sciences, Energy & Mining", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254721159337", "email": "andy.amadi@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD094", "name": "Wilkister Nyanumba-Bosire", "classOf": "KHS'91", "organisation": "African Institute for Health and Development", "designation": "Executive Director", "profession": "Executive Director", "primaryClusterId": "A2", "primaryClusterName": "Public Health & Psychosocial Services", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254703733742", "email": "wbosire@aihdint.org", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD095", "name": "Nyawira Njeru", "classOf": "Limuru'91", "organisation": "Becton Dickinson (BD)", "designation": "Director Global Health (EE/ME/Africa)", "profession": "Director Global Health (EE/ME/Africa)", "primaryClusterId": "A2", "primaryClusterName": "Public Health & Psychosocial Services", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722791790", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD096", "name": "Jordan Kyongo", "classOf": "Maseno'96", "organisation": "LVCT Health", "designation": "Research Manager", "profession": "Research Manager", "primaryClusterId": "A2", "primaryClusterName": "Public Health & Psychosocial Services", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722317643", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD097", "name": "Betty Kanyagia", "classOf": "KHS'92", "organisation": "Bamburi Cement Ltd. (Lafarge Holcim)", "designation": "General Counsel", "profession": "General Counsel", "primaryClusterId": "D1", "primaryClusterName": "Legal Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017,2023", "phone": "+254724381237", "email": "betty.kanyagia@lafargeholcim.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017/2023", "notes": "Booths WG Lead 2023", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD098", "name": "Violet Kimotho", "classOf": "KHS'90", "organisation": "Azali CPS", "designation": "Managing Partner", "profession": "Managing Partner", "primaryClusterId": "D1", "primaryClusterName": "Legal Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254726155972", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD099", "name": "Nazima Malik", "classOf": "KHS'91", "organisation": "Kaplan & Stratton Advocates", "designation": "Partner", "profession": "Partner", "primaryClusterId": "D1", "primaryClusterName": "Legal Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722297972", "email": "NMalik@kapstrat.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD100", "name": "Wanjiru Nduati-Musembi", "classOf": "KHS'91", "organisation": "Havelock, Nduati & Co. Advocates", "designation": "Managing Partner", "profession": "Managing Partner", "primaryClusterId": "D1", "primaryClusterName": "Legal Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722554678", "email": "wnduati@hnc.co.ke", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "also C2 Entrepreneurship", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD101", "name": "Esther Kinyenje", "classOf": "KHS'90", "organisation": "Kaplan & Stratton Advocates", "designation": "Partner", "profession": "Partner", "primaryClusterId": "D1", "primaryClusterName": "Legal Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017,2022", "phone": "+254722858416", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017/2022", "notes": "Legal Sub-Lead 2022", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD102", "name": "Jacqueline Waihenya-Maina", "classOf": "KHS'91", "organisation": "Maina Njanga & Co. Advocates", "designation": "Partner", "profession": "Partner", "primaryClusterId": "D1", "primaryClusterName": "Legal Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254725519058", "email": "jackeewmaina@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "Careers Committee Secretary 2023", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD103", "name": "Nkirote Mworia-Njiru", "classOf": "", "organisation": "UAP Old Mutual Group", "designation": "Group Company Secretary", "profession": "Group Company Secretary", "primaryClusterId": "D1", "primaryClusterName": "Legal Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254733720108", "email": "nkinjiru18@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD104", "name": "Iminza Kaisha-Waithaka", "classOf": "KHS'90", "organisation": "Renaissance Capital (K) Ltd.", "designation": "CAO - Legal, Compliance & HR", "profession": "CAO - Legal, Compliance & HR", "primaryClusterId": "D1", "primaryClusterName": "Legal Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722717388", "email": "susankaisha@yahoo.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD105", "name": "Nancy Kiruki", "classOf": "KHS'91", "organisation": "British-American Investments (Britam)", "designation": "Director Legal, HR & Company Secretary", "profession": "Director Legal, HR & Company Secretary", "primaryClusterId": "D1", "primaryClusterName": "Legal Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722922766", "email": "nkiruki@britam.co.ke", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "also C3 Leadership", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD106", "name": "Cosima Wetende", "classOf": "KHS'92", "organisation": "Kaplan & Stratton Advocates", "designation": "Partner", "profession": "Partner", "primaryClusterId": "D1", "primaryClusterName": "Legal Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD107", "name": "Wangui Kaniaru", "classOf": "AGHS'93", "organisation": "Anjarwalla & Khanna Advocates", "designation": "Senior Associate, Corporate/Commercial", "profession": "Senior Associate, Corporate/Commercial", "primaryClusterId": "D1", "primaryClusterName": "Legal Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254734028007", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD108", "name": "Jane Mburia", "classOf": "KHS'95", "organisation": "Co-operative Bank of Kenya", "designation": "Head of Customer Experience", "profession": "Head of Customer Experience", "primaryClusterId": "C1", "primaryClusterName": "Finance & Actuarial Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017,2019,2022,2023", "phone": "+254721228498", "email": "jmburia@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017/2019/2022-23", "notes": "Finance Cluster Lead 2019-2023", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD109", "name": "Mary Mulili", "classOf": "KHS'95", "organisation": "GT Bank / Bank of Africa", "designation": "Head of Corporate & Commercial Banking / GM Business", "profession": "Head of Corporate & Commercial Banking / GM Business", "primaryClusterId": "C1", "primaryClusterName": "Finance & Actuarial Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254725832921", "email": "mary.mulili@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD110", "name": "Selipha Waigwa", "classOf": "", "organisation": "Cassia Capital Partners LLC", "designation": "Junior Analyst", "profession": "Junior Analyst", "primaryClusterId": "C1", "primaryClusterName": "Finance & Actuarial Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254704551668", "email": "waigwaselipha@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD111", "name": "Imtiaz Khan", "classOf": "", "organisation": "Cassia Capital / Centum / Oltepesi", "designation": "Director / Non-Exec Director / Board Chairman", "profession": "Director / Non-Exec Director / Board Chairman", "primaryClusterId": "C1", "primaryClusterName": "Finance & Actuarial Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD112", "name": "Lydia Ndeeri-Maina", "classOf": "KHS'91", "organisation": "Co-operative Bank of Kenya", "designation": "", "profession": "Co-operative Bank of Kenya", "primaryClusterId": "C1", "primaryClusterName": "Finance & Actuarial Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254721212291", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD113", "name": "Eleanor Kigen-Ouko", "classOf": "", "organisation": "CFA Society East Africa", "designation": "President", "profession": "President", "primaryClusterId": "C1", "primaryClusterName": "Finance & Actuarial Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254716960022", "email": "eleanorkigen@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD114", "name": "Julie Kilewe", "classOf": "KHS'91", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "C1", "primaryClusterName": "Finance & Actuarial Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254734700490", "email": "darkstarltdke@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD115", "name": "Patricia Kiwanuka", "classOf": "KHS'92", "organisation": "fmr UAP Old Mutual Group", "designation": "fmr Group MD, Asset Management", "profession": "fmr Group MD, Asset Management", "primaryClusterId": "C1", "primaryClusterName": "Finance & Actuarial Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254728970703", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD116", "name": "Evelyn Muhoro", "classOf": "KHS'92", "organisation": "", "designation": "HR & Admin Professional", "profession": "HR & Admin Professional", "primaryClusterId": "C3", "primaryClusterName": "Leadership & Strategic/HR Management", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254729977088", "email": "Muhoro.evelyn@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD117", "name": "Linda W. Waweru", "classOf": "KHS'01", "organisation": "Kileleshwa Covenant Community Church", "designation": "HR & Admin Director", "profession": "HR & Admin Director", "primaryClusterId": "C3", "primaryClusterName": "Leadership & Strategic/HR Management", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722892223", "email": "wanjirulinda@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD118", "name": "Njeri Waithaka", "classOf": "exKHS", "organisation": "National Transport & Safety Authority (NTSA)", "designation": "Director Road Safety", "profession": "Director Road Safety", "primaryClusterId": "D3", "primaryClusterName": "Uniformed & National Security Services", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254732466002", "email": "Njeri.waithaka@ntsa.go.ke", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD119", "name": "Isabel Opondo", "classOf": "KHS'13", "organisation": "Kenyatta University / Careers Committee", "designation": "Sportsperson & Rugby Varsity Team, CC Chair", "profession": "Sportsperson & Rugby Varsity Team, CC Chair", "primaryClusterId": "A3", "primaryClusterName": "Sports Science & Physical Fitness", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017,2019,2022,2023", "phone": "+254716900152", "email": "isabel.atieno@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017/2019/2022-23", "notes": "Careers Cmte Chair 2023, Arts Cluster Lead 2019", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD120", "name": "Chris Amimo", "classOf": "Lenana'90", "organisation": "Football Kenya Federation / Ligi Ndogo SC", "designation": "Chair Nairobi Branch / Chair", "profession": "Chair Nairobi Branch / Chair", "primaryClusterId": "A3", "primaryClusterName": "Sports Science & Physical Fitness", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722718620", "email": "camimo@ligindogo.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD121", "name": "Christine Ethangatta", "classOf": "KHS'91", "organisation": "Distell Winemasters (KWAL)", "designation": "Marketing Manager", "profession": "Marketing Manager", "primaryClusterId": "C5", "primaryClusterName": "Marketing, PR, Sales, Comms & CX", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722725100", "email": "cethangatta23@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD122", "name": "Caroline Wanjala-Wabwire", "classOf": "KHS'91", "organisation": "Retirement Benefits Authority (RBA)", "designation": "Deputy Manager: Supervision", "profession": "Deputy Manager: Supervision", "primaryClusterId": "C5", "primaryClusterName": "Marketing, PR, Sales, Comms & CX", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254721977562", "email": "carolwanjala@yahoo.co.uk", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD123", "name": "Chao Mwaluma-Mweu", "classOf": "KHS'80", "organisation": "Unilever", "designation": "Sales & Marketing", "profession": "Sales & Marketing", "primaryClusterId": "C5", "primaryClusterName": "Marketing, PR, Sales, Comms & CX", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722706621", "email": "Mwaluma@unilever.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD124", "name": "Catherine Obwino", "classOf": "KHS'91", "organisation": "UAP Old Mutual Group", "designation": "Group Marketing Manager", "profession": "Group Marketing Manager", "primaryClusterId": "C5", "primaryClusterName": "Marketing, PR, Sales, Comms & CX", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722754272", "email": "cobwino@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD125", "name": "Sharon Mwelu Kyungu", "classOf": "KHS'94", "organisation": "Kenya National Museums", "designation": "PR & Marketing Manager", "profession": "PR & Marketing Manager", "primaryClusterId": "C5", "primaryClusterName": "Marketing, PR, Sales, Comms & CX", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254717868961", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD126", "name": "Pamela Mutua", "classOf": "KHS'91", "organisation": "Ministry of Energy & Petroleum", "designation": "Strategy & Communications Advisor", "profession": "Strategy & Communications Advisor", "primaryClusterId": "C5", "primaryClusterName": "Marketing, PR, Sales, Comms & CX", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254722686225", "email": "Pamela.mutua@gmail.com", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD127", "name": "Sarah Mugo", "classOf": "SHGHS'91", "organisation": "Crest Corporation Ltd.", "designation": "Lifestyle Property & Marketing Consultant", "profession": "Lifestyle Property & Marketing Consultant", "primaryClusterId": "C5", "primaryClusterName": "Marketing, PR, Sales, Comms & CX", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+256755103828", "email": "sarah@crestnanyuki.com", "location": "Diaspora - Uganda", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD128", "name": "Patrick Mwicigi", "classOf": "", "organisation": "Royal Properties Market Ltd.", "designation": "Founder & Principal", "profession": "Founder & Principal", "primaryClusterId": "C5", "primaryClusterName": "Marketing, PR, Sales, Comms & CX", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+254717575738", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD129", "name": "Mary Otieno", "classOf": "", "organisation": "United Nations - Abidjan, Côte d'Ivoire", "designation": "", "profession": "United Nations - Abidjan, Côte d'Ivoire", "primaryClusterId": "D2", "primaryClusterName": "Int'l Relations, Development & Governance", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+16466448129", "email": "", "location": "Diaspora - Côte d'Ivoire", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD130", "name": "Louise Masese", "classOf": "", "organisation": "UNICEF HQ, New York", "designation": "Nutrition Specialist", "profession": "Nutrition Specialist", "primaryClusterId": "D2", "primaryClusterName": "Int'l Relations, Development & Governance", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+17186443523", "email": "", "location": "Diaspora - USA", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD131", "name": "Wangui wa Goro", "classOf": "", "organisation": "African Development (Editor)", "designation": "Editor", "profession": "Editor", "primaryClusterId": "D2", "primaryClusterName": "Int'l Relations, Development & Governance", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2017", "phone": "+447944219315", "email": "", "location": "Diaspora - UK", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2017", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD132", "name": "Kanyi Ohawa", "classOf": "", "organisation": "", "designation": "Creative Arts", "profession": "Creative Arts", "primaryClusterId": "E3", "primaryClusterName": "The Arts — Applied, Visual, Performing & Literary", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0726864222", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD133", "name": "Sammy Lutaya", "classOf": "", "organisation": "", "designation": "Creative Arts", "profession": "Creative Arts", "primaryClusterId": "E3", "primaryClusterName": "The Arts — Applied, Visual, Performing & Literary", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0722265210", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD134", "name": "Caleb Rachkara", "classOf": "", "organisation": "", "designation": "Interior Designer & Digital Strategist", "profession": "Interior Designer & Digital Strategist", "primaryClusterId": "E3", "primaryClusterName": "The Arts — Applied, Visual, Performing & Literary", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0713629534", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD135", "name": "Raphael Nyamu Ndwiga", "classOf": "", "organisation": "", "designation": "Gospel DJ", "profession": "Gospel DJ", "primaryClusterId": "E3", "primaryClusterName": "The Arts — Applied, Visual, Performing & Literary", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0720499497", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD136", "name": "Faith Mwaisaka", "classOf": "", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "C5", "primaryClusterName": "Marketing, PR, Sales, Comms & CX", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0721348207", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD137", "name": "Daisy Wanzala", "classOf": "", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "C5", "primaryClusterName": "Marketing, PR, Sales, Comms & CX", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0708066200", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD138", "name": "Innocent Deckoks", "classOf": "", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "B4", "primaryClusterName": "Environment & Conservation", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0770599394", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD139", "name": "Judy Mugambi", "classOf": "", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "B4", "primaryClusterName": "Environment & Conservation", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0722704636", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD140", "name": "Mercy Masila Achoka", "classOf": "", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "C3", "primaryClusterName": "Leadership & Strategic/HR Management", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0727541540", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD141", "name": "Stella Ngugi", "classOf": "", "organisation": "", "designation": "Software Entrepreneurship / HR Professional", "profession": "Software Entrepreneurship / HR Professional", "primaryClusterId": "C2", "primaryClusterName": "Entrepreneurship & Innovation", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0716808880", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "also B1 STEM", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD142", "name": "Kawira Thambu", "classOf": "", "organisation": "Lively Minds Uganda", "designation": "Country Director (ECCE)", "profession": "Country Director (ECCE)", "primaryClusterId": "D5", "primaryClusterName": "Education", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0731433688", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD143", "name": "Ivy Nafula (Inviolata)", "classOf": "", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "A2", "primaryClusterName": "Public Health & Psychosocial Services", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019,2022,2023", "phone": "0729378599", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019/2022-23", "notes": "Public Health Cluster Lead", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD144", "name": "Edna Gicovi Thairu", "classOf": "", "organisation": "", "designation": "Mental Health Practitioner", "profession": "Mental Health Practitioner", "primaryClusterId": "A2", "primaryClusterName": "Public Health & Psychosocial Services", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0725716768", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD145", "name": "Agolla Aloo", "classOf": "", "organisation": "Madini Youth Foundation", "designation": "Psychologist / Founder", "profession": "Psychologist / Founder", "primaryClusterId": "A2", "primaryClusterName": "Public Health & Psychosocial Services", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0710263329", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "also D5 Education", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD146", "name": "Mitchell Njeri Kagotho", "classOf": "", "organisation": "MKU", "designation": "5th Yr Medical Student", "profession": "5th Yr Medical Student", "primaryClusterId": "A1", "primaryClusterName": "Medical Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0721948719", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD147", "name": "Dr Nzioki", "classOf": "", "organisation": "", "designation": "Medical Doctor", "profession": "Medical Doctor", "primaryClusterId": "A1", "primaryClusterName": "Medical Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0721460657", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD148", "name": "Diana Marangu", "classOf": "", "organisation": "", "designation": "Consultant Paediatrician & Pulmonologist", "profession": "Consultant Paediatrician & Pulmonologist", "primaryClusterId": "A1", "primaryClusterName": "Medical Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019,2022", "phone": "0721282815", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019/2022", "notes": "Medical Physicians Lead 2019/22", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD149", "name": "Njambi Njuguna", "classOf": "", "organisation": "", "designation": "Technical Advisor - Clinical Services", "profession": "Technical Advisor - Clinical Services", "primaryClusterId": "A1", "primaryClusterName": "Medical Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019,2022,2023", "phone": "0722310917", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019/2022-23", "notes": "Medical Non-Physicians Lead", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD150", "name": "Faith Laboso", "classOf": "", "organisation": "Mama Lucy Kibaki Hospital", "designation": "Medical Officer Intern", "profession": "Medical Officer Intern", "primaryClusterId": "A1", "primaryClusterName": "Medical Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0702329235", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD151", "name": "Angela Makumi", "classOf": "", "organisation": "ILRI", "designation": "Post-Doctoral Scientist", "profession": "Post-Doctoral Scientist", "primaryClusterId": "A1", "primaryClusterName": "Medical Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "+353871749003", "email": "", "location": "Diaspora - Ireland", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD152", "name": "Joyce Lukiwa", "classOf": "", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "E1", "primaryClusterName": "Journalism & The Media", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0724317324", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "dup of Joyce Ang'wech Lukwiya", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD153", "name": "Olive Burrows", "classOf": "", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "E1", "primaryClusterName": "Journalism & The Media", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019,2022", "phone": "0723385720", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019/2022", "notes": "Journalism Cluster Lead 2019", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD154", "name": "Amina Abdi", "classOf": "", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "E1", "primaryClusterName": "Journalism & The Media", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0721736265", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD155", "name": "Winnie Maru", "classOf": "", "organisation": "KAWT", "designation": "", "profession": "KAWT", "primaryClusterId": "E2", "primaryClusterName": "Hospitality & Tourism", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0721374780", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD156", "name": "Dorcas Kimathi", "classOf": "", "organisation": "KAWT", "designation": "", "profession": "KAWT", "primaryClusterId": "E2", "primaryClusterName": "Hospitality & Tourism", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0796679415", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD157", "name": "Marie Mwikali", "classOf": "", "organisation": "Adrienne Events", "designation": "", "profession": "Adrienne Events", "primaryClusterId": "E2", "primaryClusterName": "Hospitality & Tourism", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0721323019", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD158", "name": "Lilian Chumba", "classOf": "", "organisation": "Global Travel & Tourism Partnership", "designation": "", "profession": "Global Travel & Tourism Partnership", "primaryClusterId": "E2", "primaryClusterName": "Hospitality & Tourism", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0729920198", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD159", "name": "Peter Kibe", "classOf": "", "organisation": "Strathmore University", "designation": "", "profession": "Strathmore University", "primaryClusterId": "E2", "primaryClusterName": "Hospitality & Tourism", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0739149151", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD160", "name": "Esther Nganga", "classOf": "", "organisation": "Safari Park Hotel", "designation": "Sales Executive", "profession": "Sales Executive", "primaryClusterId": "E2", "primaryClusterName": "Hospitality & Tourism", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0737124025", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD161", "name": "Isabelle Wambui", "classOf": "", "organisation": "Cheeky Monkeys", "designation": "", "profession": "Cheeky Monkeys", "primaryClusterId": "E2", "primaryClusterName": "Hospitality & Tourism", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0720938390", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD162", "name": "Yvonne Mwandiga", "classOf": "", "organisation": "Microsoft Safari", "designation": "", "profession": "Microsoft Safari", "primaryClusterId": "E2", "primaryClusterName": "Hospitality & Tourism", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0725270431", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD163", "name": "Nahida Mohamed", "classOf": "", "organisation": "Kilifi County Govt", "designation": "County Exec Committee Member - Trade, Tourism & Coop Devpt", "profession": "County Exec Committee Member - Trade, Tourism & Coop Devpt", "primaryClusterId": "E2", "primaryClusterName": "Hospitality & Tourism", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0701657231", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD164", "name": "Wangeci Ndirangu", "classOf": "", "organisation": "", "designation": "Conference Interpreter", "profession": "Conference Interpreter", "primaryClusterId": "D2", "primaryClusterName": "Int'l Relations, Development & Governance", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0713163543", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "Governance Cluster Lead 2019", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD165", "name": "Gloria Chepkoech", "classOf": "", "organisation": "WFP Kenya", "designation": "", "profession": "WFP Kenya", "primaryClusterId": "D2", "primaryClusterName": "Int'l Relations, Development & Governance", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0746615451", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD166", "name": "Linet Gatakaa", "classOf": "", "organisation": "African Development Bank", "designation": "Gender Expert", "profession": "Gender Expert", "primaryClusterId": "D2", "primaryClusterName": "Int'l Relations, Development & Governance", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "+27638710175", "email": "", "location": "Diaspora - South Africa", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD167", "name": "Wanjiku Mwotia", "classOf": "", "organisation": "", "designation": "International Conference Interpreter", "profession": "International Conference Interpreter", "primaryClusterId": "D2", "primaryClusterName": "Int'l Relations, Development & Governance", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0733617105", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD168", "name": "Angela Kariuki", "classOf": "", "organisation": "IndigeCap Partners", "designation": "Co-Principal, Business Advisory", "profession": "Co-Principal, Business Advisory", "primaryClusterId": "C2", "primaryClusterName": "Entrepreneurship & Innovation", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019,2022", "phone": "0727363208", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019/2022", "notes": "Entrepreneurship Cluster Lead 2019", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD169", "name": "Esther Kute", "classOf": "", "organisation": "", "designation": "Design (product/industrial/fashion/footwear) & Manufacturing", "profession": "Design (product/industrial/fashion/footwear) & Manufacturing", "primaryClusterId": "C2", "primaryClusterName": "Entrepreneurship & Innovation", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0725377143", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD170", "name": "Esther Ndegwa", "classOf": "", "organisation": "Keep It Kleen Ltd", "designation": "Post-Construction Cleaning", "profession": "Post-Construction Cleaning", "primaryClusterId": "C2", "primaryClusterName": "Entrepreneurship & Innovation", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0723437636", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD171", "name": "Nkatha Kiruki", "classOf": "", "organisation": "", "designation": "Fashion & Textile Design & Manufacturing", "profession": "Fashion & Textile Design & Manufacturing", "primaryClusterId": "C2", "primaryClusterName": "Entrepreneurship & Innovation", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0725552459", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD172", "name": "Namunyak", "classOf": "", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "D1", "primaryClusterName": "Legal Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0717488917", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD173", "name": "Jane Murungi", "classOf": "", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "D1", "primaryClusterName": "Legal Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0775118161", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD174", "name": "Beatrice Koske", "classOf": "", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "D1", "primaryClusterName": "Legal Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0721586948", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD175", "name": "Elizabeth Kimura", "classOf": "", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "D1", "primaryClusterName": "Legal Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0712853471", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD176", "name": "Nicole Gichuhi", "classOf": "", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "D1", "primaryClusterName": "Legal Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0738413734", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD177", "name": "Jill Obuchunju", "classOf": "", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "D1", "primaryClusterName": "Legal Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0720204624", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD178", "name": "Rev Jackie Othoro", "classOf": "LCVR'88", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "D4", "primaryClusterName": "Theology & Pastoral Care", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0722715498", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "Theology Cluster Lead 2019", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD179", "name": "Anne Ndiritu", "classOf": "", "organisation": "Alliance Girls' High School", "designation": "Teacher", "profession": "Teacher", "primaryClusterId": "D5", "primaryClusterName": "Education", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0720514401", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "dup of Anne Nderitu", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD180", "name": "Tabitha Kinyua", "classOf": "", "organisation": "St Joseph High School Gathanga", "designation": "Teacher", "profession": "Teacher", "primaryClusterId": "D5", "primaryClusterName": "Education", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0722455648", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD181", "name": "Jane Oisebe", "classOf": "", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "A3", "primaryClusterName": "Sports Science & Physical Fitness", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019,2022", "phone": "0722747979", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019/2022", "notes": "Sports Cluster Lead 2019/22", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD182", "name": "La Paula", "classOf": "", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "A3", "primaryClusterName": "Sports Science & Physical Fitness", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0718706810", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD183", "name": "Cynthia Mumbo", "classOf": "", "organisation": "", "designation": "Runs a sports marketing company", "profession": "Runs a sports marketing company", "primaryClusterId": "A3", "primaryClusterName": "Sports Science & Physical Fitness", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD184", "name": "Caroline Milgo", "classOf": "", "organisation": "", "designation": "Software Engineer", "profession": "Software Engineer", "primaryClusterId": "B1", "primaryClusterName": "Computing, Data & Cyber Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0720563247", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD185", "name": "Shiro Theuri", "classOf": "", "organisation": "FrontlineSMS", "designation": "CTO", "profession": "CTO", "primaryClusterId": "B1", "primaryClusterName": "Computing, Data & Cyber Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0710247276", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD186", "name": "Vivianne Meta", "classOf": "", "organisation": "LocateIT Ltd", "designation": "Geomatics Lead", "profession": "Geomatics Lead", "primaryClusterId": "B1", "primaryClusterName": "Computing, Data & Cyber Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0726705239", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD187", "name": "Kathy Wamukoya", "classOf": "", "organisation": "EPSON Europe B.V", "designation": "Consumer Account Manager", "profession": "Consumer Account Manager", "primaryClusterId": "B1", "primaryClusterName": "Computing, Data & Cyber Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0720106286", "email": "", "location": "Diaspora - Europe", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD188", "name": "Rose Sumeita", "classOf": "", "organisation": "JKUAT", "designation": "4th Yr Civil Engineering Student", "profession": "4th Yr Civil Engineering Student", "primaryClusterId": "B2", "primaryClusterName": "Engineering & Manufacturing", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0718744950", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD189", "name": "Lulu Chilumo", "classOf": "", "organisation": "", "designation": "BSc Marine Engineering Student", "profession": "BSc Marine Engineering Student", "primaryClusterId": "B6", "primaryClusterName": "Aviation, Aerospace & Maritime", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0707985551", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD190", "name": "Florence Nyole", "classOf": "KHS'03", "organisation": "Architects Chapter, AAK", "designation": "Chair", "profession": "Chair", "primaryClusterId": "E4", "primaryClusterName": "The Built Environment & Real Estate", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019,2022,2023", "phone": "0720280606", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019/2022-23", "notes": "Built Environment Cluster Lead", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD191", "name": "Teresa Mutua", "classOf": "", "organisation": "", "designation": "Student Architecture", "profession": "Student Architecture", "primaryClusterId": "E4", "primaryClusterName": "The Built Environment & Real Estate", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0704698742", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD192", "name": "Rita Kimani", "classOf": "", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "E4", "primaryClusterName": "The Built Environment & Real Estate", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0702661690", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD193", "name": "Isabele Njoroge", "classOf": "", "organisation": "", "designation": "Graduate Architect", "profession": "Graduate Architect", "primaryClusterId": "E4", "primaryClusterName": "The Built Environment & Real Estate", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0727369920", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD194", "name": "Kathambi Kirika", "classOf": "", "organisation": "", "designation": "Quantity Surveyor", "profession": "Quantity Surveyor", "primaryClusterId": "E4", "primaryClusterName": "The Built Environment & Real Estate", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0725758953", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD195", "name": "Ruth Kihoro", "classOf": "", "organisation": "", "designation": "Student Quantity Surveyor", "profession": "Student Quantity Surveyor", "primaryClusterId": "E4", "primaryClusterName": "The Built Environment & Real Estate", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0704216531", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD196", "name": "Joyce Omamo", "classOf": "", "organisation": "Barker & Barton", "designation": "Quantity Surveyor", "profession": "Quantity Surveyor", "primaryClusterId": "E4", "primaryClusterName": "The Built Environment & Real Estate", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0716362439", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD197", "name": "Joan Nyagwalla Otieno", "classOf": "", "organisation": "", "designation": "Landscape Architect", "profession": "Landscape Architect", "primaryClusterId": "E4", "primaryClusterName": "The Built Environment & Real Estate", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019,2022", "phone": "0705404180", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019/2022", "notes": "Built Environment Sub-Lead 2022 (unavailable 2023)", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD198", "name": "Claire", "classOf": "", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "C1", "primaryClusterName": "Finance & Actuarial Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0704435471", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD199", "name": "Catherine Muthuuri", "classOf": "", "organisation": "Stanbic Kenya Ltd", "designation": "Senior Relationship Manager", "profession": "Senior Relationship Manager", "primaryClusterId": "C1", "primaryClusterName": "Finance & Actuarial Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0722730937", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD200", "name": "Beatrice Vulule", "classOf": "", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "C1", "primaryClusterName": "Finance & Actuarial Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0733807540", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD201", "name": "Wendy Kodhiambo", "classOf": "", "organisation": "Deloitte", "designation": "Senior Consultant", "profession": "Senior Consultant", "primaryClusterId": "C1", "primaryClusterName": "Finance & Actuarial Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0711994584", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD202", "name": "Ruth Opondo", "classOf": "", "organisation": "I&M Bank", "designation": "Head of Reconciliation", "profession": "Head of Reconciliation", "primaryClusterId": "C1", "primaryClusterName": "Finance & Actuarial Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0728484277", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD203", "name": "Caroline Mumbi", "classOf": "", "organisation": "UAP Old Mutual", "designation": "Operations, Health Insurance", "profession": "Operations, Health Insurance", "primaryClusterId": "C1", "primaryClusterName": "Finance & Actuarial Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0728108846", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD204", "name": "Amoit Ikol", "classOf": "", "organisation": "Coca-Cola", "designation": "Senior Financial Analyst", "profession": "Senior Financial Analyst", "primaryClusterId": "C1", "primaryClusterName": "Finance & Actuarial Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0731807020", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD205", "name": "Catherine Wathome", "classOf": "", "organisation": "Bible Translation & Literacy", "designation": "Accountant", "profession": "Accountant", "primaryClusterId": "C1", "primaryClusterName": "Finance & Actuarial Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0721977089", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD206", "name": "Audrey Obara", "classOf": "", "organisation": "", "designation": "Private Equity - Development Finance", "profession": "Private Equity - Development Finance", "primaryClusterId": "C1", "primaryClusterName": "Finance & Actuarial Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0722318283", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD207", "name": "Gladys Warirah", "classOf": "", "organisation": "", "designation": "Finance / Accountancy", "profession": "Finance / Accountancy", "primaryClusterId": "C1", "primaryClusterName": "Finance & Actuarial Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019", "phone": "0715299681", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019 Cluster Members", "notes": "", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD208", "name": "Sophia Mithika", "classOf": "KHS'13", "organisation": "Careers Committee", "designation": "Board & CC Member", "profession": "Board & CC Member", "primaryClusterId": "B1", "primaryClusterName": "Computing, Data & Cyber Sciences", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2022,2023", "phone": "", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2022-23", "notes": "STEM Cluster & Talk Lead 2023, Finance WG Lead 2023", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD209", "name": "Marianne Mureithi", "classOf": "", "organisation": "", "designation": "Medical Practitioner", "profession": "Medical Practitioner", "primaryClusterId": "A1", "primaryClusterName": "Medical Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019,2022", "phone": "0703704711", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019/2022", "notes": "Medical Non-Physicians Sub-Lead", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD210", "name": "Sarafina Nyawira", "classOf": "KHS'15", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "E1", "primaryClusterName": "Journalism & The Media", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2023", "phone": "", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2023", "notes": "Journalism Cluster Lead 2023", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD211", "name": "Beverly Naliaka Wangila", "classOf": "KHS'05", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "C5", "primaryClusterName": "Marketing, PR, Sales, Comms & CX", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2023", "phone": "", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2023", "notes": "Marketing Cluster & Talk Lead 2023", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD212", "name": "Caroline Kungu", "classOf": "KHS'92", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "D2", "primaryClusterName": "Int'l Relations, Development & Governance", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2023", "phone": "", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2023", "notes": "Int'l Relations Cluster Lead 2023", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD213", "name": "Michelle Kagari", "classOf": "KHS'91", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "D2", "primaryClusterName": "Int'l Relations, Development & Governance", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2023", "phone": "", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2023", "notes": "Int'l Relations Talk Lead 2023", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD214", "name": "Mbinya Mutiso", "classOf": "", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "C2", "primaryClusterName": "Entrepreneurship & Innovation", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2019,2023", "phone": "0722368960", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2019/2023", "notes": "Entrepreneurship Cluster Lead 2023", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD215", "name": "Teresia J. Michael", "classOf": "KHS'11", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "C2", "primaryClusterName": "Entrepreneurship & Innovation", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2023", "phone": "", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2023", "notes": "Entrepreneurship Sub-Lead 2023", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD216", "name": "Clare Kasera-Carter", "classOf": "KHS'00", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "E4", "primaryClusterName": "The Built Environment & Real Estate", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2023", "phone": "", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2023", "notes": "Built Environment Talk Lead 2023", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD217", "name": "Cpt. Brenda Wambu", "classOf": "Pioneer'12", "organisation": "", "designation": "Commercial Pilot", "profession": "Commercial Pilot", "primaryClusterId": "B6", "primaryClusterName": "Aviation, Aerospace & Maritime", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2023", "phone": "", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2023", "notes": "Aviation Cluster Lead 2023", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD218", "name": "Hannah Gitonga-Mwangi", "classOf": "KHS'90", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "D1", "primaryClusterName": "Legal Practitioners", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2022,2023", "phone": "", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2022-23", "notes": "Legal Cluster Lead 2023", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD219", "name": "Nancy Dindi", "classOf": "KHS'06", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "D4", "primaryClusterName": "Theology & Pastoral Care", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2023", "phone": "", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2023", "notes": "Theology Cluster Lead 2023", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD220", "name": "Caroline Ndirangu", "classOf": "KHS'02", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "C3", "primaryClusterName": "Leadership & Strategic/HR Management", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2023", "phone": "", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2023", "notes": "Mentors (WG2) Lead 2023 - predecessor role", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD221", "name": "Georgette Kiniga", "classOf": "KHS'10", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "C5", "primaryClusterName": "Marketing, PR, Sales, Comms & CX", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2023", "phone": "", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2023", "notes": "Communications WG Lead 2023", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD222", "name": "June Komen-Migui", "classOf": "KHS'02", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "C3", "primaryClusterName": "Leadership & Strategic/HR Management", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2023", "phone": "", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2023", "notes": "Merchandise WG Lead 2023", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
  {"id": "MD223", "name": "Samwel Maina", "classOf": "", "organisation": "", "designation": "", "profession": "", "primaryClusterId": "D5", "primaryClusterName": "Education", "secondaryClusterIds": "", "secondaryClusterNames": "", "yearsInvolved": "2023", "phone": "", "email": "", "location": "Local", "linkedinOrProfile": "", "aiStrengthsSummary": "", "source": "2023", "notes": "School WG Lead 2023", "outreachStatus": "Not yet contacted (2026)", "outreachNotes": "", "addedAt": ""},
];

const SEED_TEAM = [
  {
    "id": "T001",
    "name": "Dr Muthoni Mugambi",
    "phone": "",
    "email": "",
    "role": "Lead",
    "zone": "",
    "cluster": "",
    "status": "Confirmed",
    "notes": "WG2 Lead",
    "accessLevel": "all",
    "pin": "1001"
  },
  {
    "id": "T002",
    "name": "Cizarina Nasirumbi",
    "phone": "",
    "email": "",
    "role": "Assistant Lead",
    "zone": "",
    "cluster": "",
    "status": "Confirmed",
    "notes": "WG2 Assistant Lead",
    "accessLevel": "all",
    "pin": "1002"
  },
  {
    "id": "T003",
    "name": "Margaret Ogachi",
    "phone": "",
    "email": "",
    "role": "Assistant Lead",
    "zone": "",
    "cluster": "",
    "status": "Confirmed",
    "notes": "WG2 Assistant Lead",
    "accessLevel": "all",
    "pin": "1003"
  },
  {
    "id": "T004",
    "name": "Elsie Munge",
    "phone": "",
    "email": "",
    "role": "Intern",
    "zone": "",
    "cluster": "",
    "status": "Confirmed",
    "notes": "WG2 Intern",
    "accessLevel": "intern",
    "pin": ""
  },
  {
    "id": "T005",
    "name": "Lena Wekunda",
    "phone": "",
    "email": "",
    "role": "Intern",
    "zone": "",
    "cluster": "",
    "status": "Confirmed",
    "notes": "WG2 Intern",
    "accessLevel": "intern",
    "pin": ""
  },
  {
    "id": "T006",
    "name": "Abigail Amanda Adika",
    "phone": "",
    "email": "",
    "role": "Intern",
    "zone": "",
    "cluster": "",
    "status": "Confirmed",
    "notes": "WG2 Intern",
    "accessLevel": "intern",
    "pin": ""
  },
  {
    "id": "T007",
    "name": "Keisha Wahome",
    "phone": "",
    "email": "",
    "role": "Intern",
    "zone": "",
    "cluster": "",
    "status": "Confirmed",
    "notes": "WG2 Intern",
    "accessLevel": "intern",
    "pin": ""
  },
  {
    "id": "T008",
    "name": "Jeddy Kolil",
    "phone": "",
    "email": "",
    "role": "Intern",
    "zone": "",
    "cluster": "",
    "status": "Confirmed",
    "notes": "WG2 Intern",
    "accessLevel": "intern",
    "pin": ""
  },
  {
    "id": "T009",
    "name": "Seanice Ochieng",
    "phone": "",
    "email": "",
    "role": "Intern",
    "zone": "",
    "cluster": "",
    "status": "Confirmed",
    "notes": "WG2 Intern",
    "accessLevel": "intern",
    "pin": ""
  },
  {
    "id": "T010",
    "name": "Sarah Bora",
    "phone": "",
    "email": "",
    "role": "Intern",
    "zone": "",
    "cluster": "",
    "status": "Confirmed",
    "notes": "WG2 Intern",
    "accessLevel": "intern",
    "pin": ""
  },
  {
    "id": "T011",
    "name": "Anne Obure",
    "phone": "",
    "email": "",
    "role": "Zone Coordinator",
    "zone": "Zone A",
    "cluster": "",
    "status": "Confirmed",
    "notes": "WG2 Member",
    "accessLevel": "zone",
    "pin": ""
  },
  {
    "id": "T012",
    "name": "Gloria Kikete",
    "phone": "",
    "email": "",
    "role": "Member",
    "zone": "",
    "cluster": "",
    "status": "Confirmed",
    "notes": "WG2 Member, Society Secretary-General",
    "accessLevel": "cluster",
    "pin": ""
  },
  {
    "id": "T013",
    "name": "Hannah Gitonga",
    "phone": "",
    "email": "",
    "role": "Zone Coordinator",
    "zone": "Zone B",
    "cluster": "",
    "accessLevel": "zone",
    "pin": "",
    "status": "Confirmed",
    "notes": "WG2 Member"
  },
  {
    "id": "T014",
    "name": "Tamara Ariba",
    "phone": "",
    "email": "",
    "role": "Zone Coordinator",
    "zone": "Zone C",
    "cluster": "",
    "status": "Confirmed",
    "notes": "WG2 Member",
    "accessLevel": "zone",
    "pin": ""
  },
  {
    "id": "T015",
    "name": "Lorraine Muturi",
    "phone": "",
    "email": "",
    "role": "Zone Coordinator",
    "zone": "Zone D",
    "cluster": "",
    "status": "Confirmed",
    "notes": "WG2 Member",
    "accessLevel": "zone",
    "pin": ""
  },
  {
    "id": "T016",
    "name": "Wangechi Ndirangu",
    "phone": "",
    "email": "",
    "role": "Member",
    "zone": "",
    "cluster": "",
    "status": "Confirmed",
    "notes": "WG2 Member, also WG4 Plenary Lead",
    "accessLevel": "cluster",
    "pin": ""
  },
  {
    "id": "T017",
    "name": "Mercy Amuguni",
    "phone": "",
    "email": "",
    "role": "Zone Coordinator",
    "zone": "Zone E",
    "cluster": "",
    "status": "Confirmed",
    "notes": "WG2 Member",
    "accessLevel": "zone",
    "pin": ""
  },
  {
    "id": "T018",
    "name": "Sharon Chachale-Wata",
    "phone": "",
    "email": "",
    "role": "Member",
    "zone": "",
    "cluster": "",
    "status": "Confirmed",
    "notes": "WG2 Member",
    "accessLevel": "cluster",
    "pin": ""
  },
  {
    "id": "T019",
    "name": "June Kyula",
    "phone": "",
    "email": "",
    "role": "Member",
    "zone": "",
    "cluster": "",
    "status": "Unconfirmed - chase before 7 Aug",
    "notes": "WG2 Member",
    "accessLevel": "cluster",
    "pin": ""
  },
  {
    "id": "T020",
    "name": "Agnes Maina-Gwaro",
    "phone": "",
    "email": "",
    "role": "Member",
    "zone": "",
    "cluster": "",
    "status": "Unconfirmed - chase before 7 Aug",
    "notes": "WG2 Member",
    "accessLevel": "cluster",
    "pin": ""
  },
  {
    "id": "T021",
    "name": "Annabel Njoroge",
    "phone": "",
    "email": "",
    "role": "Member",
    "zone": "",
    "cluster": "",
    "status": "Unconfirmed - chase before 7 Aug",
    "notes": "WG2 Member",
    "accessLevel": "cluster",
    "pin": ""
  },
  {
    "id": "T022",
    "name": "Jane Gachanja",
    "phone": "",
    "email": "",
    "role": "Member",
    "zone": "",
    "cluster": "",
    "status": "Unconfirmed - chase before 7 Aug",
    "notes": "WG2 Member",
    "accessLevel": "cluster",
    "pin": ""
  },
  {
    "id": "T023",
    "name": "Mary Mugambi",
    "phone": "",
    "email": "",
    "role": "Member",
    "zone": "",
    "cluster": "",
    "status": "Unconfirmed - chase before 7 Aug",
    "notes": "WG2 Member",
    "accessLevel": "cluster",
    "pin": ""
  },
  {
    "id": "T024",
    "name": "Sylvia Wanjie-Muniu",
    "phone": "",
    "email": "",
    "role": "Member",
    "zone": "",
    "cluster": "",
    "status": "Unconfirmed - chase before 7 Aug",
    "notes": "WG2 Member",
    "accessLevel": "cluster",
    "pin": ""
  },
  {
    "id": "T025",
    "name": "Tabitha Waithaka",
    "phone": "",
    "email": "",
    "role": "Member",
    "zone": "",
    "cluster": "",
    "status": "Unconfirmed - chase before 7 Aug",
    "notes": "WG2 Member",
    "accessLevel": "cluster",
    "pin": ""
  }
];

// No example/demo rows on purpose — a fresh setupSheets() gives a genuinely
// empty Students sheet, so there's no risk of mistaking a leftover sample
// row for real registration data. If you've already run setupSheets from an
// earlier version of this app, delete any rows whose "notes" column says
// "Example row" from your live Students sheet by hand (one-time cleanup).
const SEED_STUDENTS = [];

// The 23-cluster / 5-zone structure, matching every other WG2 Career Day
// document (Student Career Guide, Career Briefs Addendum, Playbook).
const SEED_CLUSTERS = [
  { id: "A1", zone: "A", room: "A1", name: "Medical Practitioners", capacity: 28 },
  { id: "A2", zone: "A", room: "A2", name: "Public Health & Psychosocial Services", capacity: 28 },
  { id: "A3", zone: "A", room: "A3", name: "Sports Science & Physical Fitness", capacity: 28 },
  { id: "B1", zone: "B", room: "B1", name: "Computing, Data & Cyber Sciences", capacity: 28 },
  { id: "B2", zone: "B", room: "B2", name: "Engineering & Manufacturing", capacity: 28 },
  { id: "B3", zone: "B", room: "B3", name: "Earth Sciences, Energy & Mining", capacity: 28 },
  { id: "B4", zone: "B", room: "B4", name: "Environment & Conservation", capacity: 28 },
  { id: "B5", zone: "B", room: "B5", name: "Agriculture, Food & Agribusiness", capacity: 28 },
  { id: "B6", zone: "B", room: "B6", name: "Aviation, Aerospace & Maritime", capacity: 28 },
  { id: "C1", zone: "C", room: "C1", name: "Finance & Actuarial Sciences", capacity: 28 },
  { id: "C2", zone: "C", room: "C2", name: "Entrepreneurship & Innovation", capacity: 28 },
  { id: "C3", zone: "C", room: "C3", name: "Leadership & Strategic/HR Management", capacity: 28 },
  { id: "C4", zone: "C", room: "C4", name: "Supply Chain, Logistics & Procurement", capacity: 28 },
  { id: "C5", zone: "C", room: "C5", name: "Marketing, PR, Sales, Comms & CX", capacity: 28 },
  { id: "D1", zone: "D", room: "D1", name: "Legal Practitioners", capacity: 28 },
  { id: "D2", zone: "D", room: "D2", name: "Int'l Relations, Development & Governance", capacity: 28 },
  { id: "D3", zone: "D", room: "D3", name: "Uniformed & National Security Services", capacity: 28 },
  { id: "D4", zone: "D", room: "D4", name: "Theology & Pastoral Care", capacity: 28 },
  { id: "D5", zone: "D", room: "D5", name: "Education", capacity: 28 },
  { id: "E1", zone: "E", room: "E1", name: "Journalism & The Media", capacity: 28 },
  { id: "E2", zone: "E", room: "E2", name: "Hospitality & Tourism", capacity: 28 },
  { id: "E3", zone: "E", room: "E3", name: "The Arts — Applied, Visual, Performing & Literary", capacity: 28 },
  { id: "E4", zone: "E", room: "E4", name: "The Built Environment & Real Estate", capacity: 28 },
];

// All careers a student can select from, mapped to the cluster that would
// host that career's mentors on the day. id: CR001.. (stable, never reused).
// All careers a student can select from, mapped to the cluster that would
// host that career's mentors on the day. id: CR001.. (stable, never reused).
// clusterId: matches SEED_CLUSTERS above. name/description: taken verbatim
// from "Your Career Guide" and its "Career Briefs Addendum" (the two official
// WG2 PDFs also offered to students as downloads — see the Careers &
// Clusters Guide screen/action), so the app never shows a career under
// wording that conflicts with what a student can read in those documents.
const SEED_CAREERS = [
  { id: "CR001", name: "Physicians", clusterId: "A1", description: "General physicians diagnose illness, order and interpret tests, and manage treatment for patients of all ages — often the first specialist a patient sees before being referred further." },
  { id: "CR002", name: "Surgeons", clusterId: "A1", description: "Surgeons operate to repair injuries, remove disease, or reconstruct the body — from a 20-minute appendectomy to a 10-hour transplant." },
  { id: "CR003", name: "Dentists", clusterId: "A1", description: "Dentists diagnose and treat problems with teeth, gums, and the mouth — from routine fillings to full reconstructive and cosmetic work." },
  { id: "CR004", name: "Pharmacists", clusterId: "A1", description: "Pharmacists are the final safety check on every prescription — verifying doses, catching drug interactions, and advising patients on how to take medicine safely." },
  { id: "CR005", name: "Nurses", clusterId: "A1", description: "Nurses provide direct, hands-on patient care around the clock — administering medication, monitoring vital signs, and often noticing problems before anyone else does." },
  { id: "CR006", name: "Physiotherapists", clusterId: "A1", description: "Physiotherapists help patients regain movement and strength after injury, surgery, stroke, or chronic illness, through hands-on therapy and exercise programmes." },
  { id: "CR007", name: "Veterinary Practitioners", clusterId: "A1", description: "Vets diagnose and treat illness and injury in animals — from family pets to livestock herds worth an entire farmer's income, to wildlife." },
  { id: "CR008", name: "Clinical Psychology", clusterId: "A2", description: "Clinical psychologists assess and treat mental health conditions — anxiety, depression, trauma — through structured therapy, not medication." },
  { id: "CR009", name: "Social Services", clusterId: "A2", description: "Social workers support vulnerable individuals and families — children, the elderly, survivors of abuse — to access the care, housing, or protection they need." },
  { id: "CR010", name: "Primary Healthcare", clusterId: "A2", description: "Primary healthcare workers are the first point of contact in the health system — running community clinics, dispensaries, and basic diagnosis before referral." },
  { id: "CR011", name: "Mental Health Counselling", clusterId: "A2", description: "Counsellors guide people through difficult life periods — grief, anxiety, relationship breakdowns — using structured conversation rather than clinical diagnosis." },
  { id: "CR012", name: "Epidemiology", clusterId: "A2", description: "Epidemiologists track how disease spreads through a population, using data to spot outbreaks early and design the response." },
  { id: "CR013", name: "Community Health", clusterId: "A2", description: "Community health professionals design and run public health programmes at the grassroots — vaccination drives, nutrition education, sanitation campaigns." },
  { id: "CR014", name: "Environmental Health", clusterId: "A2", description: "Environmental health officers protect public health from unsafe water, poor sanitation, and pollution — inspecting facilities and enforcing standards." },
  { id: "CR015", name: "PE & Sport Pedagogy", clusterId: "A3", description: "PE teachers and sport pedagogy specialists design how physical education is taught — building fitness, teamwork, and lifelong sport habits in learners." },
  { id: "CR016", name: "Coaching", clusterId: "A3", description: "Coaches train individuals or teams — technically, tactically, and mentally — to perform at their competitive best." },
  { id: "CR017", name: "Sports Therapy", clusterId: "A3", description: "Sports therapists prevent and treat injuries specific to athletes — from pitch-side first response to long-term rehabilitation plans." },
  { id: "CR018", name: "Health & Fitness Science", clusterId: "A3", description: "Fitness scientists design evidence-based training and wellness programmes — for athletes, gyms, or corporate wellness schemes." },
  { id: "CR019", name: "Sports Management", clusterId: "A3", description: "Sports managers run the business side of sport — clubs, federations, leagues, and major events — from budgets to sponsorships to logistics." },
  { id: "CR020", name: "Sports Journalism", clusterId: "A3", description: "Sports journalists report, analyse, and broadcast the stories behind the game — on TV, radio, print, or digital platforms." },
  { id: "CR021", name: "Sports Agents & Scouting", clusterId: "A3", description: "Agents and scouts discover talent early and negotiate athletes' contracts, sponsorships, and career moves." },
  { id: "CR022", name: "Computer Science", clusterId: "B1", description: "Computer scientists design and build the software, algorithms, and systems behind every app, website, and platform in use today." },
  { id: "CR023", name: "IT & Informatics", clusterId: "B1", description: "IT professionals keep an organisation's technology — networks, hardware, software, data — running securely and reliably every single day." },
  { id: "CR024", name: "IT Service Management", clusterId: "B1", description: "IT service managers make sure technology is delivered and supported at scale — the process and people layer behind a smooth IT department." },
  { id: "CR025", name: "Cyber Security", clusterId: "B1", description: "Cyber security experts defend networks, data, and people from digital attacks — from phishing scams to full-scale breaches." },
  { id: "CR026", name: "AI & Machine Learning", clusterId: "B1", description: "AI/ML specialists teach machines to recognise patterns and make predictions — powering everything from credit scoring to voice assistants." },
  { id: "CR027", name: "Data Science", clusterId: "B1", description: "Data scientists turn raw, messy data into insight — the analysis behind everything from a company's next product to national policy decisions." },
  { id: "CR028", name: "Applied Mathematics", clusterId: "B1", description: "Applied mathematicians use advanced maths to model and solve real-world problems in engineering, finance, and computing." },
  { id: "CR029", name: "Statistics", clusterId: "B1", description: "Statisticians make sense of uncertainty — designing studies, analysing results, and ensuring conclusions (from research to national census) are actually valid." },
  { id: "CR030", name: "Industrial Design", clusterId: "B1", description: "Industrial designers shape the physical products people use every day — from furniture to appliances to packaging — balancing function and form." },
  { id: "CR031", name: "Electrical Engineering", clusterId: "B2", description: "Electrical engineers design the systems that generate, distribute, and safely use power — from national grids to the wiring in a building." },
  { id: "CR032", name: "Mechatronics", clusterId: "B2", description: "Mechatronics engineers blend mechanical, electrical, and software engineering to build smart, automated machines — think robotics and automated manufacturing lines." },
  { id: "CR033", name: "Mechanical Engineering", clusterId: "B2", description: "Mechanical engineers design and build machines, engines, and mechanical systems — from vehicle components to industrial equipment." },
  { id: "CR034", name: "Biomedical Engineering", clusterId: "B2", description: "Biomedical engineers design the medical devices and technology that save lives — from prosthetics to imaging machines to hospital equipment." },
  { id: "CR035", name: "Manufacturing & Industrial Engineering", clusterId: "B2", description: "Manufacturing and industrial engineers design and optimise how products get made at scale — the systems behind every factory floor." },
  { id: "CR036", name: "Geoscience", clusterId: "B3", description: "Geoscientists study the Earth's structure to locate natural resources and understand hazards like earthquakes — reading what's beneath the surface." },
  { id: "CR037", name: "Energy (Power & Renewables)", clusterId: "B3", description: "Energy professionals generate and distribute power — increasingly from renewable sources like geothermal, wind, and solar — that runs the whole economy." },
  { id: "CR038", name: "Mining & Extractives", clusterId: "B3", description: "Mining professionals responsibly locate and extract the minerals modern life depends on — balancing economic value with environmental and community impact." },
  { id: "CR039", name: "Climate Change", clusterId: "B4", description: "Climate professionals research and respond to shifting weather patterns, rising temperatures, and their impact on agriculture, water, and livelihoods." },
  { id: "CR040", name: "Wildlife Management", clusterId: "B4", description: "Wildlife managers protect and manage Kenya's iconic animal populations — balancing conservation, tourism, and human-wildlife conflict." },
  { id: "CR041", name: "Environmental Conservation", clusterId: "B4", description: "Conservationists work to preserve ecosystems and biodiversity — from forests to wetlands — for future generations." },
  { id: "CR042", name: "Eco-Planning", clusterId: "B4", description: "Eco-planners design land use and development plans that protect the environment while still allowing growth — the bridge between urban planning and conservation." },
  { id: "CR043", name: "Waste Management", clusterId: "B4", description: "Waste management professionals design the systems that keep waste out of land, air, and water — from collection logistics to recycling infrastructure." },
  { id: "CR044", name: "Environmental Journalism", clusterId: "B4", description: "Environmental journalists tell the stories that hold polluters accountable and inspire public action — from climate reporting to investigative exposés." },
  { id: "CR045", name: "Agronomy & Crop Science", clusterId: "B5", description: "Agronomists improve how crops are grown, bred, and protected — the science behind higher yields and food security." },
  { id: "CR046", name: "Animal Husbandry", clusterId: "B5", description: "Animal husbandry professionals raise and manage livestock for food, income, and export — from dairy herds to poultry operations." },
  { id: "CR047", name: "Fisheries & Aquaculture", clusterId: "B5", description: "Fisheries and aquaculture professionals farm and manage fish stocks sustainably — from Lake Victoria's wild fisheries to fish farming ponds." },
  { id: "CR048", name: "Agricultural Engineering", clusterId: "B5", description: "Agricultural engineers design the machinery, irrigation, and storage systems that modernise farming — from tractors to precision irrigation." },
  { id: "CR049", name: "Eco-Agriculture", clusterId: "B5", description: "Eco-agriculture specialists farm in ways that protect soil, water, and biodiversity — sustainable methods that keep land productive for the long term." },
  { id: "CR050", name: "Agribusiness & Value Addition", clusterId: "B5", description: "Agribusiness professionals turn raw produce into branded, exportable products — the link between the farm and the global market shelf." },
  { id: "CR051", name: "Pilots", clusterId: "B6", description: "Pilots fly commercial, cargo, or private aircraft — responsible for the safety of everyone and everything on board." },
  { id: "CR052", name: "Flight Dispatch & Air Traffic Control", clusterId: "B6", description: "Dispatchers and air traffic controllers plan flight paths and keep every aircraft safely on course and on time, especially in busy airspace." },
  { id: "CR053", name: "Cabin Crew", clusterId: "B6", description: "Cabin crew ensure passenger safety and service in the air — trained first responders as much as hosts." },
  { id: "CR054", name: "Aerospace Engineering", clusterId: "B6", description: "Aerospace engineers design the aircraft and spacecraft of the future — from aerodynamics to propulsion systems." },
  { id: "CR055", name: "Drone Operations", clusterId: "B6", description: "Drone operators fly and manage drones for mapping, agricultural monitoring, delivery, and infrastructure inspection." },
  { id: "CR056", name: "Airport Management", clusterId: "B6", description: "Airport managers run the operations behind a functioning airport — from runway scheduling to passenger services to security coordination." },
  { id: "CR057", name: "Aircraft Maintenance Engineering", clusterId: "B6", description: "Maintenance engineers keep aircraft safe and airworthy — inspecting, repairing, and certifying every part before a plane flies again." },
  { id: "CR058", name: "Maritime & Shipping", clusterId: "B6", description: "Maritime professionals manage vessels, ports, and global cargo trade by sea — keeping goods moving between countries and continents." },
  { id: "CR059", name: "Financial Engineering", clusterId: "C1", description: "Financial engineers design complex financial products and investment strategies, using maths and modelling to manage risk and return." },
  { id: "CR060", name: "Financial Analysis", clusterId: "C1", description: "Financial analysts evaluate companies, markets, and investment opportunities to guide decisions on where money should go." },
  { id: "CR061", name: "Banking", clusterId: "C1", description: "Bankers manage how money moves — from personal savings accounts to the loans that fund entire businesses and national infrastructure." },
  { id: "CR062", name: "Accountancy", clusterId: "C1", description: "Accountants track, audit, and report the financial health of any organisation — the discipline that keeps every business honest and solvent." },
  { id: "CR063", name: "Investments", clusterId: "C1", description: "Investment professionals grow wealth by allocating capital into markets, property, or businesses on behalf of clients or funds." },
  { id: "CR064", name: "Auditing", clusterId: "C1", description: "Auditors independently verify that financial records are accurate and honest — the check that protects investors, regulators, and the public." },
  { id: "CR065", name: "Insurance", clusterId: "C1", description: "Insurance professionals price and manage risk, so individuals and businesses are financially protected when something goes wrong." },
  { id: "CR066", name: "Actuarial Science", clusterId: "C1", description: "Actuaries use statistics and maths to price risk — the reason insurance and pensions can promise to pay out decades into the future." },
  { id: "CR067", name: "Startup Founder", clusterId: "C2", description: "Founders build a business from a raw idea into a functioning company — raising money, building a product, and finding customers, often all at once." },
  { id: "CR068", name: "Incubators & Accelerators", clusterId: "C2", description: "Incubator and accelerator staff support and fund early-stage startups, providing mentorship, workspace, and capital to help them grow fast." },
  { id: "CR069", name: "Seed Investing", clusterId: "C2", description: "Seed investors provide the first capital that gets new ideas off the ground, betting early on founders and concepts with high risk and high potential." },
  { id: "CR070", name: "Innovation Management", clusterId: "C2", description: "Innovation managers lead how established organisations create and adopt new ideas — keeping big companies from getting left behind by smaller, faster ones." },
  { id: "CR071", name: "Institutional Strengthening", clusterId: "C3", description: "Institutional strengthening specialists build more effective organisations from the inside — improving systems, governance, and capacity." },
  { id: "CR072", name: "Business Development", clusterId: "C3", description: "Business development professionals grow organisations by finding and securing new opportunities, partnerships, and clients." },
  { id: "CR073", name: "Human Resources", clusterId: "C3", description: "HR professionals recruit, support, and develop an organisation's people — the function that makes every other department actually work." },
  { id: "CR074", name: "Talent Acquisition", clusterId: "C3", description: "Talent acquisition specialists find and attract the right people for the right roles, often the deciding factor in whether a team succeeds." },
  { id: "CR075", name: "Administration", clusterId: "C3", description: "Administrators keep organisations running efficiently day to day — the operational backbone behind every functioning office." },
  { id: "CR076", name: "Change Management", clusterId: "C3", description: "Change managers guide organisations through major transitions — mergers, restructures, new systems — successfully and with less disruption." },
  { id: "CR077", name: "Supply Chain Management", clusterId: "C4", description: "Supply chain managers design and run the end-to-end flow of goods — from raw material to finished product on a shelf." },
  { id: "CR078", name: "Logistics", clusterId: "C4", description: "Logistics professionals plan and coordinate how goods move efficiently across distances — the practical engine behind supply chains." },
  { id: "CR079", name: "Procurement", clusterId: "C4", description: "Procurement professionals source and negotiate the goods and services an organisation needs — getting the best value without compromising quality." },
  { id: "CR080", name: "Warehousing", clusterId: "C4", description: "Warehousing professionals manage the storage and distribution hubs that keep supply chains moving smoothly." },
  { id: "CR081", name: "Distribution", clusterId: "C4", description: "Distribution professionals get finished products to the right place, on time — the last stretch between a warehouse and a customer." },
  { id: "CR082", name: "Advertising", clusterId: "C5", description: "Advertisers create the campaigns that make brands unforgettable — the concepts, visuals, and messages that stop you mid-scroll." },
  { id: "CR083", name: "Branding", clusterId: "C5", description: "Branding specialists shape how an organisation looks, sounds, and feels to the world — the identity behind every logo, tone, and customer impression." },
  { id: "CR084", name: "Communications", clusterId: "C5", description: "Communications professionals manage how organisations speak to the public and the press — protecting and building reputation." },
  { id: "CR085", name: "Customer Experience (CX)", clusterId: "C5", description: "CX professionals design every touchpoint a customer has with a brand — making sure the experience matches the promise." },
  { id: "CR086", name: "Market Development", clusterId: "C5", description: "Market development professionals identify and grow new markets for products and services — finding where the next big opportunity is." },
  { id: "CR087", name: "Corporate Social Responsibility", clusterId: "C5", description: "CSR professionals lead how businesses give back and act responsibly — running community, environmental, and ethical programmes." },
  { id: "CR088", name: "Sales Process Engineering", clusterId: "C5", description: "Sales process engineers design the systems that turn interest into revenue — the structure behind how a sales team actually closes deals." },
  { id: "CR089", name: "Legal Scholarship", clusterId: "D1", description: "Legal scholars research and shape how the law itself develops — through academic writing, case analysis, and influence on future legislation." },
  { id: "CR090", name: "Advocacy (Attorneys)", clusterId: "D1", description: "Advocates represent clients and argue cases in court — the lawyers most people picture when they think 'lawyer.'" },
  { id: "CR091", name: "Judiciary", clusterId: "D1", description: "Judges interpret the law and deliver rulings — one of the most respected and consequential roles in any justice system." },
  { id: "CR092", name: "Paralegal Work", clusterId: "D1", description: "Paralegals support legal teams with research and case preparation, doing much of the groundwork that makes a lawyer's case possible." },
  { id: "CR093", name: "Notary Services", clusterId: "D1", description: "Notaries certify and authenticate legal documents — the official witness that makes documents legally trustworthy." },
  { id: "CR094", name: "Mediation", clusterId: "D1", description: "Mediators resolve disputes outside the courtroom, fairly and efficiently, helping both sides reach an agreement without a trial." },
  { id: "CR095", name: "Prosecution", clusterId: "D1", description: "Prosecutors represent the state in criminal cases, deciding what to charge and arguing the case against the accused in court." },
  { id: "CR096", name: "Judicial Administration", clusterId: "D1", description: "Judicial administrators keep the machinery of courts and justice running — scheduling, records, and operations behind every case." },
  { id: "CR097", name: "Policy Development", clusterId: "D2", description: "Policy developers design the rules and frameworks that shape public life — from education policy to national economic strategy." },
  { id: "CR098", name: "Public Participation", clusterId: "D2", description: "Public participation specialists ensure citizens have a real voice in governance decisions, running consultations that shape policy from the ground up." },
  { id: "CR099", name: "Civic Education", clusterId: "D2", description: "Civic educators teach communities how to engage with democracy and their rights — voting, accountability, and civic participation." },
  { id: "CR100", name: "NGO & Foundation Work", clusterId: "D2", description: "NGO professionals lead programmes that address social and humanitarian needs — from education to emergency relief." },
  { id: "CR101", name: "Diplomacy", clusterId: "D2", description: "Diplomats represent your country's interests on the world stage — negotiating agreements and maintaining international relationships." },
  { id: "CR102", name: "Think Tank Research", clusterId: "D2", description: "Think tank researchers shape policy debates through rigorous, independent research — the evidence behind public arguments." },
  { id: "CR103", name: "Conference Interpretation", clusterId: "D2", description: "Conference interpreters enable real-time communication across languages at the highest levels — diplomacy, international courts, global summits." },
  { id: "CR104", name: "Kenya Defence Forces (KDF)", clusterId: "D3", description: "KDF officers and personnel serve and lead in the nation's armed forces — defending national sovereignty and supporting peacekeeping missions abroad." },
  { id: "CR105", name: "National Police Service", clusterId: "D3", description: "Police officers protect communities and enforce the law — from community policing to specialised investigative units." },
  { id: "CR106", name: "Kenya Prisons Service", clusterId: "D3", description: "Prisons service officers manage correctional facilities and support rehabilitation, balancing security with genuine efforts at reform." },
  { id: "CR107", name: "National Youth Service (NYS)", clusterId: "D3", description: "NYS leaders run national service and youth development programmes, combining discipline training with practical skills development." },
  { id: "CR108", name: "Immigration Services", clusterId: "D3", description: "Immigration officers manage the nation's borders and citizenship processes — who enters, who stays, and how documentation is verified." },
  { id: "CR109", name: "Coast Guard", clusterId: "D3", description: "Coast Guard personnel protect Kenya's waters, ports, and maritime borders — from search and rescue to anti- smuggling operations." },
  { id: "CR110", name: "Theology", clusterId: "D4", description: "Theologians study and teach the foundations of faith and belief — the scholarly discipline behind religious leadership and thought." },
  { id: "CR111", name: "Pastoral Studies", clusterId: "D4", description: "Pastoral studies graduates train formally for religious and spiritual leadership — preparing to guide congregations and communities." },
  { id: "CR112", name: "Pastoral Care", clusterId: "D4", description: "Pastoral care providers offer spiritual and emotional support to individuals and communities through life's hardest moments." },
  { id: "CR113", name: "Spiritual Ministry", clusterId: "D4", description: "Spiritual ministry leaders lead worship, congregations, and faith communities, shaping both belief and communal life." },
  { id: "CR114", name: "Early Childhood Education", clusterId: "D5", description: "ECE teachers shape the earliest, most formative years of learning — building the foundation every later education stage builds on." },
  { id: "CR115", name: "Primary Education", clusterId: "D5", description: "Primary teachers guide the foundational school years, building core literacy, numeracy, and life skills." },
  { id: "CR116", name: "Secondary Education", clusterId: "D5", description: "Secondary teachers teach and mentor teenagers through their most pivotal academic years, specialising in one or two subjects." },
  { id: "CR117", name: "Home Education", clusterId: "D5", description: "Home education specialists design and deliver individualised, at-home learning — a growing alternative pathway for some families." },
  { id: "CR118", name: "Special Needs Education", clusterId: "D5", description: "Special needs educators teach and advocate for learners with diverse needs, adapting teaching methods to make education genuinely inclusive." },
  { id: "CR119", name: "TVET (Technical & Vocational)", clusterId: "D5", description: "TVET trainers teach practical, hands-on trade and technical skills — the instructors behind Kenya's skilled workforce in construction, mechanics, catering, and more." },
  { id: "CR120", name: "Tertiary & Academia", clusterId: "D5", description: "University lecturers and academics teach, research, and lead at the highest level of education, expanding knowledge in their field." },
  { id: "CR121", name: "Broadcast Media", clusterId: "E1", description: "Broadcast media professionals report and produce news and content for TV and radio, shaping how millions get their daily information." },
  { id: "CR122", name: "Print Media", clusterId: "E1", description: "Print journalists write and edit for newspapers, magazines, and publications — the in-depth, considered side of news." },
  { id: "CR123", name: "Digital & Social Media", clusterId: "E1", description: "Digital media professionals build and manage online platforms and audiences — the modern newsroom that lives on phones, not paper." },
  { id: "CR124", name: "Blogging", clusterId: "E1", description: "Bloggers build an independent voice and audience around their expertise — writing consistently on a topic they know deeply." },
  { id: "CR125", name: "Vlogging", clusterId: "E1", description: "Vloggers tell stories and build community through video content — from lifestyle to education to comedy." },
  { id: "CR126", name: "Podcasting", clusterId: "E1", description: "Podcasters create long-form audio content and conversation — a fast-growing format for storytelling, interviews, and commentary." },
  { id: "CR127", name: "Gastronomy (Culinary Arts)", clusterId: "E2", description: "Professional chefs and culinary experts train in the art and science of food — running kitchens, developing menus, and creating memorable dining experiences." },
  { id: "CR128", name: "Event Management", clusterId: "E2", description: "Event managers plan and execute events — from weddings to global conferences — coordinating every moving piece to come together on the day." },
  { id: "CR129", name: "Destination Marketing", clusterId: "E2", description: "Destination marketers sell the story of a place to the world — the campaigns that make travellers choose Kenya over anywhere else." },
  { id: "CR130", name: "Conference Management", clusterId: "E2", description: "Conference managers run large-scale business and international events, handling everything from delegate logistics to venue technology." },
  { id: "CR131", name: "Tours & Travel", clusterId: "E2", description: "Tours and travel professionals design and guide unforgettable travel experiences — from safari itineraries to international trip planning." },
  { id: "CR132", name: "Sommelier", clusterId: "E2", description: "Sommeliers are certified wine experts — advising on selection, pairing, and service in top restaurants and hotels." },
  { id: "CR133", name: "Oenology", clusterId: "E2", description: "Oenologists study and practice the science of winemaking — from grape selection to fermentation to final bottling." },
  { id: "CR134", name: "Fashion & Couture Design", clusterId: "E3", description: "Fashion designers create original clothing and collections — from concept sketch to finished, wearable garment." },
  { id: "CR135", name: "Graphic Design", clusterId: "E3", description: "Graphic designers visually communicate ideas across every kind of media — logos, packaging, websites, and campaigns." },
  { id: "CR136", name: "Interior Design", clusterId: "E3", description: "Interior designers shape how spaces look, feel, and function — from private homes to hotels and offices." },
  { id: "CR137", name: "Photography", clusterId: "E3", description: "Photographers capture and tell stories through still images — from weddings to journalism to fine art." },
  { id: "CR138", name: "Videography", clusterId: "E3", description: "Videographers tell stories through moving images and film — from commercials to documentaries to music videos." },
  { id: "CR139", name: "Painting & Sculpture", clusterId: "E3", description: "Painters and sculptors create original fine art in two and three dimensions, exhibiting and selling work as professional artists." },
  { id: "CR140", name: "Sound Engineering", clusterId: "E3", description: "Sound engineers record, mix, and produce professional audio — for music, film, radio, and live events." },
  { id: "CR141", name: "DJ Techniques", clusterId: "E3", description: "DJs curate and mix music for live audiences, reading a room and shaping the energy of an event in real time." },
  { id: "CR142", name: "Dance", clusterId: "E3", description: "Dancers perform, choreograph, and teach movement as art — across styles from traditional to contemporary to commercial." },
  { id: "CR143", name: "Drama", clusterId: "E3", description: "Actors, directors, and drama producers bring stories to life for stage and screen, from theatre to film to TV." },
  { id: "CR144", name: "Music", clusterId: "E3", description: "Musicians perform, compose, and produce music professionally — across genres from gospel to Afrobeat to classical." },
  { id: "CR145", name: "Creative Writing", clusterId: "E3", description: "Creative writers write fiction, essays, and creative nonfiction — building stories and ideas that move readers." },
  { id: "CR146", name: "Poetry", clusterId: "E3", description: "Poets craft and perform the written and spoken word — from page poetry to spoken word and slam performance." },
  { id: "CR147", name: "Script-Writing", clusterId: "E3", description: "Scriptwriters write for film, TV, theatre, and stage — the structural and dialogue backbone of every production." },
  { id: "CR148", name: "Cosmetology", clusterId: "E3", description: "Cosmetologists train professionally in skincare and beauty treatments — facials, makeup artistry, and skin health." },
  { id: "CR149", name: "Hairdressing (Coiffeuring)", clusterId: "E3", description: "Hairdressers master the art and business of professional hairstyling — cutting, styling, and treating hair for clients." },
  { id: "CR150", name: "Aesthetics", clusterId: "E3", description: "Aestheticians specialise in professional skincare and beauty therapy — treatments focused specifically on skin health and appearance." },
  { id: "CR163", name: "Modelling", clusterId: "E3", description: "Models bring fashion, editorial, and commercial concepts to life in front of the camera or on the runway, working with designers, photographers, and brands." },
  { id: "CR164", name: "Film Directing & Production", clusterId: "E3", description: "Film directors and producers lead a film from concept to screen — directing the story, casting, and shoot, while producers manage the people, budget, and logistics that make it happen." },
  { id: "CR165", name: "Cinematography", clusterId: "E3", description: "Cinematographers (Directors of Photography) design and capture a film's visual look — camera, lighting, and framing choices that shape how a story feels on screen." },
  { id: "CR166", name: "Film & Video Editing", clusterId: "E3", description: "Editors assemble raw footage into a finished film, show, or advert — the pacing, structure, and story built entirely in the edit." },
  { id: "CR167", name: "Animation & Motion Graphics", clusterId: "E3", description: "Animators and motion designers bring characters, effects, and graphics to life frame by frame — for film, TV, games, and advertising." },
  { id: "CR168", name: "Theatre & Stage Performance (Acting)", clusterId: "E3", description: "Theatre performers act live on stage — in scripted plays, drama festivals, and touring productions — building a craft felt differently than acting for a camera." },
  { id: "CR169", name: "Theatre Production & Stage Management", clusterId: "E3", description: "Stage managers and theatre production crews run the technical side of a live show — sets, lighting, sound, and cues — keeping a production running smoothly night after night." },
  { id: "CR170", name: "Voice Acting & Voiceover", clusterId: "E3", description: "Voice actors lend their voice to animation, adverts, audiobooks, and dubbing — performing entirely through vocal expression." },
  { id: "CR171", name: "Recording Artist / Musician (Performance)", clusterId: "E3", description: "Recording and performing musicians write, record, and perform music professionally — building an audience through streaming, live shows, and collaborations." },
  { id: "CR172", name: "Music Production", clusterId: "E3", description: "Music producers shape a song's sound and arrangement in the studio — guiding artists, arranging instrumentation, and overseeing a track from demo to finished release." },
  { id: "CR173", name: "Songwriting & Composition", clusterId: "E3", description: "Songwriters and composers write original music and lyrics — for recording artists, film scores, adverts, and stage productions." },
  { id: "CR174", name: "Music Direction & Conducting", clusterId: "E3", description: "Music directors and conductors lead choirs, bands, and orchestras — shaping how a group of musicians sounds and performs together." },
  { id: "CR175", name: "Music Business & Artist Management", clusterId: "E3", description: "Music business professionals and managers handle the business side of music — bookings, contracts, royalties, and building an artist's career." },
  { id: "CR151", name: "Quantity Surveying", clusterId: "E4", description: "Quantity surveyors manage the costs and contracts of major construction projects, keeping budgets realistic from design to completion." },
  { id: "CR152", name: "Urban Planning", clusterId: "E4", description: "Urban planners design how entire cities and towns grow and function — zoning, transport, housing, and public space." },
  { id: "CR153", name: "Architecture", clusterId: "E4", description: "Architects design buildings that are beautiful, functional, and safe — from concept sketch through construction oversight." },
  { id: "CR154", name: "Architectural Drafting", clusterId: "E4", description: "Architectural drafters turn design concepts into precise technical drawings that builders can actually construct from." },
  { id: "CR155", name: "Interior Architecture", clusterId: "E4", description: "Interior architects design the structural and spatial experience of interiors — more technical than interior design, closer to building structure." },
  { id: "CR156", name: "Site Engineering", clusterId: "E4", description: "Site engineers manage the technical execution of a construction site, translating design plans into real, safely built structures." },
  { id: "CR157", name: "Civil Engineering", clusterId: "E4", description: "Civil engineers design and build roads, bridges, and public infrastructure — the physical systems entire economies run on." },
  { id: "CR158", name: "Structural Engineering", clusterId: "E4", description: "Structural engineers ensure buildings and structures can safely stand and last — the calculations behind every skyscraper and bridge." },
  { id: "CR159", name: "Building Services Engineering", clusterId: "E4", description: "Building services engineers design a building's power, water, and climate systems — the invisible infrastructure that makes a building livable." },
  { id: "CR160", name: "Energy Assessment (Buildings)", clusterId: "E4", description: "Building energy assessors evaluate and improve a building's energy efficiency — reducing costs and environmental impact." },
  { id: "CR161", name: "Construction Management", clusterId: "E4", description: "Construction managers oversee construction projects from design to completion — the people who keep a build on time and on budget." },
  { id: "CR162", name: "Real Estate", clusterId: "E4", description: "Real estate professionals broker, appraise, manage, and develop property — connecting buyers, sellers, and the built environment." },
];

const SEED_TASKS = [
  {
    "id": "K001",
    "phase": "Phase 0 - Immediate",
    "task": "Resolve Assistant Lead: Cizarina AND Margaret Ogachi (not either/or)",
    "owner": "Dr Muthoni Mugambi + Cizarina Nasirumbi",
    "delegable": "N",
    "due": "06-Aug-26",
    "status": "Resolved 6 Aug",
    "ref": "A13",
    "notes": "Report to Secretariat that WG2 has two confirmed Assistant Leads - update official roster",
    "state": "Done"
  },
  {
    "id": "K002",
    "phase": "Phase 0 - Immediate",
    "task": "Chase all unconfirmed WG2 members for straw poll",
    "owner": "Cizarina + Interns",
    "delegable": "Y",
    "due": "07-Aug-26",
    "status": "Pending",
    "ref": "A13",
    "notes": "Straw poll closes 07 Aug 10am EAT - interns chase individually",
    "state": "Pending"
  },
  {
    "id": "K003",
    "phase": "Phase 0 - Immediate",
    "task": "Confirm 23-cluster / 5-zone structure (reorganized 2023 clusters + Mining/Agriculture/Supply Chain/Uniformed and Security Services)",
    "owner": "Dr Muthoni + Cizarina + WG2 core",
    "delegable": "N",
    "due": "06-Aug-26",
    "status": "Confirmed on 6 Aug call",
    "ref": "A17",
    "notes": "See WG2_Cluster_Reference_2026.csv - feeds Cluster Allocation Matrix",
    "state": "Pending"
  },
  {
    "id": "K004",
    "phase": "Phase 0 - Immediate",
    "task": "Appoint 5 Zone Coordinators from confirmed WG2 Members",
    "owner": "Dr Muthoni + Cizarina + Margaret",
    "delegable": "N",
    "due": "07-Aug-26",
    "status": "Pending",
    "ref": "A17",
    "notes": "Draft candidates in Playbook Section 8.6 - confirm fit/availability at tomorrow's meeting",
    "state": "Pending"
  },
  {
    "id": "K005",
    "phase": "Phase 0 - Immediate",
    "task": "Draft WG2 roster and structure document",
    "owner": "Cizarina",
    "delegable": "Partial - interns format",
    "due": "07-Aug-26",
    "status": "Complete",
    "ref": "A15",
    "notes": "Covered by Playbook Section 3 - upload to WG2 Drive folder",
    "state": "Done"
  },
  {
    "id": "K006",
    "phase": "Phase 0 - Immediate",
    "task": "Draft WG2 7-day workplan/checklist",
    "owner": "Cizarina",
    "delegable": "Y - interns compile",
    "due": "07-Aug-26",
    "status": "Complete",
    "ref": "A16",
    "notes": "This tracker fulfils this",
    "state": "Done"
  },
  {
    "id": "K007",
    "phase": "Phase 0 - Immediate",
    "task": "Assign Zone Coordinator/liaison to every cluster; check Cluster Lead/Sub-Lead availability",
    "owner": "Dr Muthoni + Cizarina + Margaret + Zone Coordinators",
    "delegable": "Partial - interns pre-fill matrix from poll responses",
    "due": "07-Aug-26",
    "status": "Pending",
    "ref": "A17",
    "notes": "Most important WG2 task - interns build first draft of Cluster Allocation Matrix from volunteer responses before the meeting",
    "state": "Pending"
  },
  {
    "id": "K008",
    "phase": "Phase 0 - Immediate",
    "task": "Create/confirm Cluster Leads chat and add all confirmed leads",
    "owner": "Cizarina",
    "delegable": "Y",
    "due": "07-Aug-26",
    "status": "Pending",
    "ref": "A18",
    "notes": "Intern can create/manage group once leads are confirmed",
    "state": "Pending"
  },
  {
    "id": "K009",
    "phase": "Phase 0 - Immediate",
    "task": "Identify KICD/KUCCPS contacts and send first outreach",
    "owner": "Dr Muthoni + WG8 liaison",
    "delegable": "Partial - interns draft using template",
    "due": "07-Aug-26",
    "status": "Pending",
    "ref": "A19",
    "notes": "Initiate only; expect to run into Week 2 - see WG2_Outreach_Messages_Pack.txt item 3",
    "state": "Pending"
  },
  {
    "id": "K010",
    "phase": "Phase 0 - Immediate",
    "task": "Submit WG2 mentorship-time requirement to Secretariat/WG4",
    "owner": "Dr Muthoni",
    "delegable": "N",
    "due": "07-Aug-26",
    "status": "Pending",
    "ref": "A20",
    "notes": "e.g. minimum 90 min mentorship per cohort",
    "state": "Pending"
  },
  {
    "id": "K011",
    "phase": "Phase 0 - Immediate",
    "task": "Give WG8 cluster count/room needs/timing for student-guide route",
    "owner": "Dr Muthoni + Cizarina",
    "delegable": "Partial - interns prep numbers",
    "due": "07-Aug-26",
    "status": "Pending",
    "ref": "A31",
    "notes": "23 rooms needed across 2 shifts (updated from 19 to match 23-cluster reorg)",
    "state": "Pending"
  },
  {
    "id": "K012",
    "phase": "Phase 0 - Immediate",
    "task": "Send preferred email to Iteyo Khaisia for Drive access",
    "owner": "All WG2 members",
    "delegable": "N - individual action",
    "due": "07-Aug-26",
    "status": "Pending",
    "ref": "A14",
    "notes": "+254 748 047 581",
    "state": "Pending"
  },
  {
    "id": "K013",
    "phase": "Phase 0 - Immediate",
    "task": "Prepare WG2 status update for SteerCo Meeting 2",
    "owner": "Cizarina or Dr Muthoni",
    "delegable": "Partial - interns draft summary",
    "due": "07-Aug-26",
    "status": "Pending",
    "ref": "R12",
    "notes": "Attend 1900hrs via Google Meet",
    "state": "Pending"
  },
  {
    "id": "K014",
    "phase": "Phase 0 - From 6 Aug call with Dr Muthoni",
    "task": "Post Cluster Lead/Zone Coordinator recruitment message in all WG2 cluster WhatsApp groups",
    "owner": "Cizarina + Dr Muthoni",
    "delegable": "Y - interns can post once approved",
    "due": "06-Aug-26",
    "status": "Sent",
    "ref": "",
    "notes": "See WG2_Outreach_Messages_Pack.txt item 1",
    "state": "Done"
  },
  {
    "id": "K015",
    "phase": "Phase 0 - From 6 Aug call with Dr Muthoni",
    "task": "Collect and compile volunteer responses (name/cluster/role)",
    "owner": "Cizarina + Dr Muthoni + Interns",
    "delegable": "Y - primary intern task",
    "due": "07-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "Feeds Zone Coordinator and Cluster Lead roster before tomorrow's meeting",
    "state": "Pending"
  },
  {
    "id": "K016",
    "phase": "Phase 0 - From 6 Aug call with Dr Muthoni",
    "task": "Delegate mentor follow-up outreach to interns",
    "owner": "Cizarina",
    "delegable": "Y",
    "due": "06-Aug-26",
    "status": "Assigned",
    "ref": "",
    "notes": "See WG2_Outreach_Messages_Pack.txt item 2 - urgent per Dr Muthoni",
    "state": "Done"
  },
  {
    "id": "K017",
    "phase": "Phase 0 - From 6 Aug call with Dr Muthoni",
    "task": "Execute mentor follow-up outreach to previously interested mentors",
    "owner": "Interns (delegated)",
    "delegable": "Y",
    "due": "06-Aug-26 onward",
    "status": "In progress",
    "ref": "",
    "notes": "Log responses in WG2_Mentor_Database.csv",
    "state": "In Progress"
  },
  {
    "id": "K018",
    "phase": "Phase 0 - From 6 Aug call with Dr Muthoni",
    "task": "Send KICD follow-up to confirm commitment and session logistics",
    "owner": "Cizarina or Dr Muthoni",
    "delegable": "Partial - interns draft",
    "due": "This week",
    "status": "Ready to send",
    "ref": "A19",
    "notes": "See WG2_Outreach_Messages_Pack.txt item 3",
    "state": "In Progress"
  },
  {
    "id": "K019",
    "phase": "Phase 0 - From 6 Aug call with Dr Muthoni",
    "task": "Identify and reach out to potential corporate/organisational partners",
    "owner": "Dr Muthoni + Cizarina",
    "delegable": "Partial - interns research prospect list",
    "due": "This week",
    "status": "Ready to send",
    "ref": "",
    "notes": "See WG2_Outreach_Messages_Pack.txt item 4 - WG2 owns this pending Secretariat Partnerships lead",
    "state": "In Progress"
  },
  {
    "id": "K020",
    "phase": "Phase 0 - From 6 Aug call with Dr Muthoni",
    "task": "Finalise and share work plan and executive summary with Dr Muthoni",
    "owner": "Cizarina",
    "delegable": "N",
    "due": "06-Aug-26 before lunch",
    "status": "Complete",
    "ref": "A16",
    "notes": "WG2_Executive_Summary_Brief.doc - upload to WG2 Drive folder",
    "state": "Done"
  },
  {
    "id": "K021",
    "phase": "Phase 0 - From 6 Aug call with Dr Muthoni",
    "task": "Confirm Zone Coordinator/Cluster Lead roster ahead of next meeting",
    "owner": "Cizarina + Dr Muthoni + Margaret",
    "delegable": "Partial - interns compile from poll",
    "due": "07-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "Depends on WhatsApp poll responses",
    "state": "Pending"
  },
  {
    "id": "K022",
    "phase": "Phase 0 - From 6 Aug call with Dr Muthoni",
    "task": "Escalate Secretariat Partnerships lead gap for clarification",
    "owner": "Dr Muthoni",
    "delegable": "N",
    "due": "This week",
    "status": "Pending",
    "ref": "",
    "notes": "Raise at next SteerCo meeting if unresolved",
    "state": "Pending"
  },
  {
    "id": "K023",
    "phase": "Phase 0 - From 6 Aug call with Dr Muthoni",
    "task": "Add Registration ID column to Student Pre-Registration Template and confirm ID format",
    "owner": "Interns",
    "delegable": "Y",
    "due": "06-Aug-26",
    "status": "Complete",
    "ref": "",
    "notes": "Format KHS26-[Cohort/Group]-[AdmissionNo] - see Playbook Section 19.1-19.2",
    "state": "Done"
  },
  {
    "id": "K024",
    "phase": "Phase 0 - From 6 Aug call with Dr Muthoni",
    "task": "Present QR/Registration ID + wristband tracking design for sign-off",
    "owner": "Cizarina",
    "delegable": "N",
    "due": "07-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "Present Playbook Section 19 at tomorrow's meeting - needs Dr Muthoni + Margaret sign-off before build starts",
    "state": "Pending"
  },
  {
    "id": "K025",
    "phase": "Week 1 - Foundation",
    "task": "Fill remaining Cluster Lead/Sub-Lead gaps across all 23 clusters",
    "owner": "Zone Coordinators",
    "delegable": "N - relationship task",
    "due": "11-Aug-26",
    "status": "Pending",
    "ref": "A17",
    "notes": "",
    "state": "Pending"
  },
  {
    "id": "K026",
    "phase": "Week 1 - Foundation",
    "task": "Start sourcing mentors for Uniformed and National Security Services cluster (new - fewer existing alumnae contacts)",
    "owner": "Zone D Coordinator (reports to Cizarina)",
    "delegable": "Partial - interns build contact list",
    "due": "11-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "KDF/NPS/Prisons/NYS/Immigration/Coast Guard contacts",
    "state": "Pending"
  },
  {
    "id": "K027",
    "phase": "Week 1 - Foundation",
    "task": "Open mentor recruitment drive",
    "owner": "All WG2",
    "delegable": "Y - interns do outreach volume",
    "due": "Ongoing",
    "status": "Pending",
    "ref": "",
    "notes": "Alumnae network + professional contacts - target 70-85 mentors total",
    "state": "Pending"
  },
  {
    "id": "K028",
    "phase": "Week 1 - Foundation",
    "task": "Stand up Mentor Database and start logging contacts",
    "owner": "Interns",
    "delegable": "Y",
    "due": "09-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "See WG2_Mentor_Database.csv",
    "state": "Pending"
  },
  {
    "id": "K029",
    "phase": "Week 1 - Foundation",
    "task": "Get Grade 10/Form 4 headcounts and room capacities from WG8; confirm AM/PM shift timings",
    "owner": "Cizarina",
    "delegable": "Partial - intern compiles request",
    "due": "10-Aug-26",
    "status": "Pending",
    "ref": "A34 (WG8)",
    "notes": "23 rooms needed across 2 shifts",
    "state": "Pending"
  },
  {
    "id": "K030",
    "phase": "Week 1 - Foundation",
    "task": "Set mentor-to-student ratio and cluster size formula",
    "owner": "Dr Muthoni",
    "delegable": "N",
    "due": "11-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "",
    "state": "Pending"
  },
  {
    "id": "K031",
    "phase": "Week 1 - Foundation",
    "task": "Draft Mentorship Strategy Document",
    "owner": "Dr Muthoni + Cizarina",
    "delegable": "Partial - interns draft outline",
    "due": "12-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "Objectives and learner outcomes",
    "state": "Pending"
  },
  {
    "id": "K032",
    "phase": "Week 1 - Foundation",
    "task": "Draft Cluster Discussion Guide",
    "owner": "WG2 volunteers",
    "delegable": "Partial - interns template it",
    "due": "13-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "Topics/prompts per cluster and cohort",
    "state": "Pending"
  },
  {
    "id": "K033",
    "phase": "Week 1 - Foundation",
    "task": "Draft Mentor Handbook v1",
    "owner": "Cizarina + Interns",
    "delegable": "Y",
    "due": "14-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "Roles/schedule/safeguarding/FAQs",
    "state": "Pending"
  },
  {
    "id": "K034",
    "phase": "Week 1 - Foundation",
    "task": "Continue KICD/KUCCPS engagement; confirm cohort per expert",
    "owner": "Dr Muthoni",
    "delegable": "N",
    "due": "14-Aug-26",
    "status": "Pending",
    "ref": "A19",
    "notes": "",
    "state": "Pending"
  },
  {
    "id": "K035",
    "phase": "Week 1 - Foundation",
    "task": "Share mentor-numbers-needed with WG3 Comms",
    "owner": "Cizarina",
    "delegable": "Y - intern sends",
    "due": "08-Aug-26",
    "status": "Pending",
    "ref": "A25 (WG3)",
    "notes": "For mentor call message",
    "state": "Pending"
  },
  {
    "id": "K036",
    "phase": "Week 1 - Foundation",
    "task": "Build Google Form for student pre-registration collection",
    "owner": "Interns",
    "delegable": "Y",
    "due": "14-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "Must be ready before 15 Aug open date - see Playbook Section 18.5/19.6 #2",
    "state": "Pending"
  },
  {
    "id": "K037",
    "phase": "Week 1 - Foundation",
    "task": "Design and test QR code generation + Itinerary Card mail-merge template",
    "owner": "Interns",
    "delegable": "Y",
    "due": "15-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "Free bulk QR generator + Google Sheets IMAGE() or similar - Playbook Section 19.6 #3",
    "state": "Pending"
  },
  {
    "id": "K038",
    "phase": "Week 1 - Foundation",
    "task": "Price and order wristbands (3 colours: maroon/green/blue",
    "owner": "~1250 units + buffer)",
    "delegable": "Interns",
    "due": "Y",
    "status": "Pending",
    "ref": "N",
    "notes": "Pending",
    "state": "Pending"
  },
  {
    "id": "K039",
    "phase": "Week 1 - Foundation",
    "task": "Schedule WG8 in-class pre-registration sessions per stream",
    "owner": "Cizarina + WG8 liaison",
    "delegable": "Partial - intern coordinates calendar",
    "due": "15-Aug-26",
    "status": "Pending",
    "ref": "A32",
    "notes": "Ties to teacher integration ask - Playbook Section 19.5",
    "state": "Pending"
  },
  {
    "id": "K040",
    "phase": "Week 2 - Build and Brief",
    "task": "Finalise Cluster Allocation Matrix",
    "owner": "Dr Muthoni + Cizarina + Margaret + Zone Coordinators",
    "delegable": "Partial - interns maintain sheet",
    "due": "17-Aug-26",
    "status": "Pending",
    "ref": "A17",
    "notes": "Mentors/rooms/time slots/cohorts",
    "state": "Pending"
  },
  {
    "id": "K041",
    "phase": "Week 2 - Build and Brief",
    "task": "Finalise student-to-cluster assignment with WG8",
    "owner": "Cizarina + WG8 liaison",
    "delegable": "N",
    "due": "18-Aug-26",
    "status": "Pending",
    "ref": "A31",
    "notes": "",
    "state": "Pending"
  },
  {
    "id": "K042",
    "phase": "Week 2 - Build and Brief",
    "task": "Finalise Mentor Handbook and Cluster Leader SOP",
    "owner": "Cizarina",
    "delegable": "Partial - interns format/print",
    "due": "18-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "",
    "state": "Pending"
  },
  {
    "id": "K043",
    "phase": "Week 2 - Build and Brief",
    "task": "Schedule and hold Mentor Briefing Session",
    "owner": "Dr Muthoni",
    "delegable": "Partial - interns prep slides/logistics",
    "due": "20-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "Prepare briefing slides",
    "state": "Pending"
  },
  {
    "id": "K044",
    "phase": "Week 2 - Build and Brief",
    "task": "Build Mentor Feedback Form as live Google Form/QR",
    "owner": "Interns",
    "delegable": "Y",
    "due": "19-Aug-26",
    "status": "Pending",
    "ref": "A21",
    "notes": "",
    "state": "Pending"
  },
  {
    "id": "K045",
    "phase": "Week 2 - Build and Brief",
    "task": "Coordinate with WG7 Booths on cluster-booth thematic links",
    "owner": "Cizarina",
    "delegable": "N",
    "due": "19-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "",
    "state": "Pending"
  },
  {
    "id": "K046",
    "phase": "Week 2 - Build and Brief",
    "task": "Confirm teacher/Chaplain integration into clusters",
    "owner": "Dr Muthoni + WG8",
    "delegable": "N",
    "due": "20-Aug-26",
    "status": "Pending",
    "ref": "A32",
    "notes": "",
    "state": "Pending"
  },
  {
    "id": "K047",
    "phase": "Week 2 - Build and Brief",
    "task": "Feed mentor confirmation numbers to WG3 for appreciation/reminders",
    "owner": "Cizarina",
    "delegable": "Y - intern sends updates",
    "due": "Ongoing",
    "status": "Pending",
    "ref": "",
    "notes": "",
    "state": "Pending"
  },
  {
    "id": "K048",
    "phase": "Week 2 - Build and Brief",
    "task": "Open student pre-registration Google Form to students via WG8 in-class sessions",
    "owner": "WG8 teachers + Cizarina",
    "delegable": "Partial - interns support logistics",
    "due": "17-20 Aug-26 (closes 20 Aug)",
    "status": "Pending",
    "ref": "",
    "notes": "Supervised in-class completion",
    "state": "Pending"
  },
  {
    "id": "K049",
    "phase": "Week 2 - Build and Brief",
    "task": "Set up Digital Class Roster views (per-class filtered link into Pre-Registration Sheet)",
    "owner": "Interns",
    "delegable": "Y",
    "due": "23-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "One filtered/protected view per class/stream - Playbook Section 19.5/19.6 #8",
    "state": "Pending"
  },
  {
    "id": "K050",
    "phase": "Week 2 - Build and Brief",
    "task": "Build the Digital Day Guide page (live schedule + campus map) and generate its QR code",
    "owner": "Interns",
    "delegable": "Y",
    "due": "23-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "Published Google Site or Sheet - public",
    "state": "Pending"
  },
  {
    "id": "K051",
    "phase": "Week 2 - Build and Brief",
    "task": "Build entry-scanning Google Form(s) + live attendance Sheet",
    "owner": "Interns",
    "delegable": "Y",
    "due": "20-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "One form per round or a Round dropdown - Playbook Section 19.6 #4",
    "state": "Pending"
  },
  {
    "id": "K052",
    "phase": "Week 3 - Confirm and Rehearse",
    "task": "Allocate students to clusters (stable-matching pass) and assign Registration IDs",
    "owner": "Interns + Zone Coordinators",
    "delegable": "Y",
    "due": "21-23 Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "Playbook Section 18.5",
    "state": "Pending"
  },
  {
    "id": "K053",
    "phase": "Week 3 - Confirm and Rehearse",
    "task": "Generate and print Itinerary Cards; prepare per-room paper roster fallback",
    "owner": "Interns",
    "delegable": "Y",
    "due": "24-26 Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "Playbook Section 19.6 #6",
    "state": "Pending"
  },
  {
    "id": "K054",
    "phase": "Week 3 - Confirm and Rehearse",
    "task": "Send final logistics to every confirmed mentor",
    "owner": "Interns",
    "delegable": "Y",
    "due": "24-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "Venue/time/room/parking/dress code",
    "state": "Pending"
  },
  {
    "id": "K055",
    "phase": "Week 3 - Confirm and Rehearse",
    "task": "Attend SteerCo recce of KHS rooms; confirm cluster room fit",
    "owner": "Dr Muthoni + Cizarina",
    "delegable": "N",
    "due": "TBC",
    "status": "Pending",
    "ref": "A35 (WG8)",
    "notes": "Date to be set by WG8",
    "state": "Pending"
  },
  {
    "id": "K056",
    "phase": "Week 3 - Confirm and Rehearse",
    "task": "Finalise Escalation Plan",
    "owner": "Cizarina",
    "delegable": "Partial - intern drafts",
    "due": "25-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "No-shows/overcrowding/room changes",
    "state": "Pending"
  },
  {
    "id": "K057",
    "phase": "Week 3 - Confirm and Rehearse",
    "task": "Distribute wristbands + Itinerary Cards in class, with student orientation",
    "owner": "WG8 teachers",
    "delegable": "Partial - interns supply materials",
    "due": "26-27 Aug-26 (complete by 27 Aug)",
    "status": "Pending",
    "ref": "",
    "notes": "HARD DEADLINE - ready 2 days before Career Day per Dr Muthoni's request - Playbook Section 18.5/19.5",
    "state": "Pending"
  },
  {
    "id": "K058",
    "phase": "Week 3 - Confirm and Rehearse",
    "task": "Prepare on-the-day materials",
    "owner": "Interns",
    "delegable": "Y",
    "due": "27-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "Signage/attendance sheets/discussion guides/feedback QR",
    "state": "Pending"
  },
  {
    "id": "K059",
    "phase": "Week 3 - Confirm and Rehearse",
    "task": "Dry-run test of QR scanning process with a small group",
    "owner": "Interns",
    "delegable": "Y",
    "due": "27-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "Use a WG2 team meeting as the test - Playbook Section 19.6 #7",
    "state": "Pending"
  },
  {
    "id": "K060",
    "phase": "Week 3 - Confirm and Rehearse",
    "task": "Rehearse student movement with WG8",
    "owner": "Cizarina",
    "delegable": "N",
    "due": "26-Aug-26",
    "status": "Pending",
    "ref": "A31",
    "notes": "Opening to mentorship to labs to booths to plenary to closing",
    "state": "Pending"
  },
  {
    "id": "K061",
    "phase": "Week 3 - Confirm and Rehearse",
    "task": "Final check-in call with all Cluster Leads and Zone Coordinators",
    "owner": "Dr Muthoni",
    "delegable": "N",
    "due": "27-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "",
    "state": "Pending"
  },
  {
    "id": "K062",
    "phase": "Week 3 - Confirm and Rehearse",
    "task": "Reconfirm KICD/KUCCPS attendance and lab logistics",
    "owner": "Dr Muthoni",
    "delegable": "N",
    "due": "27-Aug-26",
    "status": "Pending",
    "ref": "A19",
    "notes": "",
    "state": "Pending"
  },
  {
    "id": "K063",
    "phase": "Event Day",
    "task": "Zone Coordinator present and active across their zone's clusters (both shifts)",
    "owner": "5 Zone Coordinators",
    "delegable": "N",
    "due": "29-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "",
    "state": "Pending"
  },
  {
    "id": "K064",
    "phase": "Event Day",
    "task": "Roving oversight - Cizarina covers Zones B+C+E, Margaret covers Zones A+D",
    "owner": "Dr Muthoni + Cizarina + Margaret",
    "delegable": "N",
    "due": "29-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "Zone split per Playbook Section 8.2 (updated 10 Aug: Cizarina now B+C+E, Margaret A+D)",
    "state": "Pending"
  },
  {
    "id": "K065",
    "phase": "Event Day",
    "task": "Live escalation contact reachable throughout",
    "owner": "Cizarina + Margaret",
    "delegable": "N",
    "due": "29-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "",
    "state": "Pending"
  },
  {
    "id": "K066",
    "phase": "Event Day",
    "task": "Staff Command Post",
    "owner": "Cizarina, Margaret, Dr Muthoni, WG8 lead, Secretariat rep",
    "delegable": "N",
    "due": "29-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "Single WhatsApp broadcast group to all Zone Coordinators - Playbook Section 18.7",
    "state": "Pending"
  },
  {
    "id": "K067",
    "phase": "Event Day",
    "task": "Distribute mentor feedback form/QR at close of each session",
    "owner": "Cluster Leads",
    "delegable": "N",
    "due": "29-Aug-26",
    "status": "Pending",
    "ref": "A21",
    "notes": "",
    "state": "Pending"
  },
  {
    "id": "K068",
    "phase": "Event Day",
    "task": "Track mentor and student attendance per cluster via QR scan + paper roster",
    "owner": "Cluster Sub-Leads",
    "delegable": "N",
    "due": "29-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "Playbook Section 19.3-19.4",
    "state": "Pending"
  },
  {
    "id": "K069",
    "phase": "Event Day",
    "task": "Staff walk-in registration desk",
    "owner": "Interns + WG8 teacher",
    "delegable": "Partial",
    "due": "29-Aug-26",
    "status": "Pending",
    "ref": "",
    "notes": "Issue same-day paper Registration ID - Playbook Section 18.5/19.5",
    "state": "Pending"
  },
  {
    "id": "K070",
    "phase": "Post-Event",
    "task": "Compile mentor feedback results",
    "owner": "Interns",
    "delegable": "Y",
    "due": "02-Sep-26",
    "status": "Pending",
    "ref": "A21",
    "notes": "",
    "state": "Pending"
  },
  {
    "id": "K071",
    "phase": "Post-Event",
    "task": "Send mentor thank-you/appreciation messages",
    "owner": "Cizarina + WG3",
    "delegable": "Y - interns draft/send",
    "due": "02-Sep-26",
    "status": "Pending",
    "ref": "",
    "notes": "",
    "state": "Pending"
  },
  {
    "id": "K072",
    "phase": "Post-Event",
    "task": "Draft Post-Event Impact Report",
    "owner": "Dr Muthoni + Cizarina",
    "delegable": "Partial - interns compile data",
    "due": "05-Sep-26",
    "status": "Pending",
    "ref": "",
    "notes": "Participation/engagement/lessons/recommendations",
    "state": "Pending"
  },
  {
    "id": "K073",
    "phase": "Post-Event",
    "task": "Update Mentor Database for future Career Days",
    "owner": "Interns",
    "delegable": "Y",
    "due": "05-Sep-26",
    "status": "Pending",
    "ref": "",
    "notes": "",
    "state": "Pending"
  }
];

// Blank value/time cells are intentional here — see the header comments
// above (SETTINGS_HEADERS/CLASSES_HEADERS/SCHEDULE_HEADERS) for why. This
// is real data waiting to be filled in via the app, not a bug.
const SEED_SETTINGS = [
  { "key": "roomMapUrl", "value": "" },
  { "key": "roomCoordinatorName", "value": "" },
  { "key": "roomCoordinatorContact", "value": "" },
  // How many mentors a single cluster room can usefully hold for ONE shift
  // (Morning or Afternoon — see the shifts/round-structure notes on
  // TEAM_HEADERS/SEED_SETTINGS above). Used by approveMentorApplication_ to
  // decide whether a new applicant's primary-choice cluster is already full
  // for their shift (in which case they're auto-assigned to their secondary
  // choice instead, if it has room — see that function), and by
  // computeClusterCommandData_ in app.js to draw the AM/PM capacity bars on
  // the Cluster Command Center. Editable from Dashboard -> Room Map &
  // Coordination settings (Lead/Assistant Lead/Zone Coordinator/Intern).
  { "key": "mentorCapacityPerShift", "value": "8" },
];
const SEED_CLASSES = [];
// 15 Aug 2026 update — the confirmed day shape. Three cohorts (F4, G10A,
// G10B) rotate through three ~90-minute "slots" starting 10:45am (after the
// school's own cocoa break): in every slot exactly ONE cohort/group is in
// Mentorship (needs all 23 cluster rooms — can't run for two groups at
// once) while the other two are in a 1-hour Lab Session (separate lab
// space, so two groups CAN run concurrently). Each cohort gets exactly 3
// standard mentorship rounds (25 min + 5 min changeover = 90 min block) and
// 2 lab sessions across the day, just in a different order:
//   Slot 1 (10:45) — F4: Mentorship · G10A: Lab I  · G10B: Lab I
//   Slot 2 (13:00) — F4: Lab I       · G10A: Mentorship · G10B: Lab II
//   Slot 3 (15:15) — F4: Lab II      · G10A: Lab 2  · G10B: Mentorship
// 15 Aug 2026, REVISION 3 — supersedes Revision 2 above (see git history /
// prior comments if you need the old numbers). Every cohort still finishes
// its LAST scheduled block by 16:00 (4pm) sharp. The optional 4th
// ("extra") mentorship round is no longer an ADDITION squeezed on top of
// everything else — it's an EITHER/OR alternative to whichever exhibition
// window shares its time slot, and which exhibition that is differs by
// cohort (see ROUND4_SWAPS_WITH in app.js, which is what actually hides
// the swapped-out exhibition block on a given student's own itinerary once
// she has a round4 cluster assigned):
//   - F4: mentorship (3 standard rounds, 30 min each, back-to-back) 10:45-
//     12:15, then Exhibition1 12:15-12:40 OR the extra mentorship round in
//     that same window (a girl does one or the other, not both), Lunch
//     12:40-13:00 (short — 20 min — because Exhibition1's start time was
//     given as a fixed anchor; flag to WG2 if that's too tight), Lab1
//     13:00-14:00, Exhibition2 14:00-15:00 (the full hour between the two
//     labs — now COMPULSORY for every F4 student, since round4 no longer
//     competes with it), Lab2 15:00-16:00.
//   - G10A: Lab1 10:45-11:45 (unchanged), Exhibition1 11:45-12:15
//     (compulsory for every Grade 10 student, A or B), Lunch 12:15-13:00,
//     mentorship 13:00-14:30 (3 standard rounds), then EITHER Exhibition2
//     14:30-15:00 OR the extra mentorship round 14:30-14:55 (take the extra
//     round and you're exempt from Exhibition2 entirely, not just given
//     less time for it) — Exhibition2 happens right before Lab2, which
//     starts 15:00-16:00 either way.
//   - G10B: Lab1 10:45-11:45 (unchanged), Exhibition1 11:45-12:15
//     (compulsory), Lunch 12:15-13:00, Lab2 13:00-14:00, then EITHER
//     Exhibition2 14:00-14:30 OR the extra mentorship round 14:00-14:25
//     (same swap mechanic as G10A), then mentorship 14:30-16:00 (3 standard
//     rounds — this is what makes the whole event's 4pm close work).
// Lunch has an informal 2-shift/swap-order pattern for G10 (eat during
// either half of 12:15-13:00; whichever half you don't eat in becomes
// bonus Exhibition1 time) — deliberately NOT modeled as separate rows
// (the schema is one row per cohort+label); it's shown as a note on the
// printed itinerary instead. Same reasoning for "Exhibition Hall stays
// open until 17:30 for anyone who wants to keep browsing" — that's a
// venue-hours fact, not a per-student schedule block, so it's a fixed
// note in the app/print template rather than a Schedule row.
// "Lab1"/"Lab2"/"Lunch"/"Exhibition1"/"Exhibition2" are informational rows
// only (id/round are just labels) — not tied to any student's round1-4
// cluster allocation, purely for the schedule display and printed
// itinerary. Edit start/end times here (or directly in the Schedule sheet)
// any time WG2 needs to adjust — nothing else in the app assumes these
// exact numbers. The which-exhibition-gets-swapped-out mapping, though,
// lives in app.js (ROUND4_SWAPS_WITH), not here — changing a round4 time
// here doesn't by itself change which exhibition block it replaces.
const SEED_SCHEDULE = [
  { "id": "F4-R1", "cohort": "F4", "round": "1", "startTime": "10:45", "endTime": "11:15" },
  { "id": "F4-R2", "cohort": "F4", "round": "2", "startTime": "11:15", "endTime": "11:45" },
  { "id": "F4-R3", "cohort": "F4", "round": "3", "startTime": "11:45", "endTime": "12:15" },
  { "id": "F4-R4", "cohort": "F4", "round": "4", "startTime": "12:15", "endTime": "12:40" },
  { "id": "F4-Exhibition1", "cohort": "F4", "round": "Exhibition1", "startTime": "12:15", "endTime": "12:40" },
  { "id": "F4-Lunch", "cohort": "F4", "round": "Lunch", "startTime": "12:40", "endTime": "13:00" },
  { "id": "F4-Lab1", "cohort": "F4", "round": "Lab1", "startTime": "13:00", "endTime": "14:00" },
  { "id": "F4-Exhibition2", "cohort": "F4", "round": "Exhibition2", "startTime": "14:00", "endTime": "15:00" },
  { "id": "F4-Lab2", "cohort": "F4", "round": "Lab2", "startTime": "15:00", "endTime": "16:00" },
  { "id": "G10A-Lab1", "cohort": "G10A", "round": "Lab1", "startTime": "10:45", "endTime": "11:45" },
  { "id": "G10A-Exhibition1", "cohort": "G10A", "round": "Exhibition1", "startTime": "11:45", "endTime": "12:15" },
  { "id": "G10A-Lunch", "cohort": "G10A", "round": "Lunch", "startTime": "12:15", "endTime": "13:00" },
  { "id": "G10A-R1", "cohort": "G10A", "round": "1", "startTime": "13:00", "endTime": "13:30" },
  { "id": "G10A-R2", "cohort": "G10A", "round": "2", "startTime": "13:30", "endTime": "14:00" },
  { "id": "G10A-R3", "cohort": "G10A", "round": "3", "startTime": "14:00", "endTime": "14:30" },
  { "id": "G10A-R4", "cohort": "G10A", "round": "4", "startTime": "14:30", "endTime": "14:55" },
  { "id": "G10A-Exhibition2", "cohort": "G10A", "round": "Exhibition2", "startTime": "14:30", "endTime": "15:00" },
  { "id": "G10A-Lab2", "cohort": "G10A", "round": "Lab2", "startTime": "15:00", "endTime": "16:00" },
  { "id": "G10B-Lab1", "cohort": "G10B", "round": "Lab1", "startTime": "10:45", "endTime": "11:45" },
  { "id": "G10B-Exhibition1", "cohort": "G10B", "round": "Exhibition1", "startTime": "11:45", "endTime": "12:15" },
  { "id": "G10B-Lunch", "cohort": "G10B", "round": "Lunch", "startTime": "12:15", "endTime": "13:00" },
  { "id": "G10B-Lab2", "cohort": "G10B", "round": "Lab2", "startTime": "13:00", "endTime": "14:00" },
  { "id": "G10B-R4", "cohort": "G10B", "round": "4", "startTime": "14:00", "endTime": "14:25" },
  { "id": "G10B-Exhibition2", "cohort": "G10B", "round": "Exhibition2", "startTime": "14:00", "endTime": "14:30" },
  { "id": "G10B-R1", "cohort": "G10B", "round": "1", "startTime": "14:30", "endTime": "15:00" },
  { "id": "G10B-R2", "cohort": "G10B", "round": "2", "startTime": "15:00", "endTime": "15:30" },
  { "id": "G10B-R3", "cohort": "G10B", "round": "3", "startTime": "15:30", "endTime": "16:00" },
];

// ---------------------------------------------------------------------
// SETUP
// ---------------------------------------------------------------------
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, TEAM_SHEET, TEAM_HEADERS, SEED_TEAM);
  ensureSheet_(ss, TASKS_SHEET, TASKS_HEADERS, SEED_TASKS);
  ensureSheet_(ss, STUDENTS_SHEET, STUDENTS_HEADERS, SEED_STUDENTS);
  ensureSheet_(ss, ATTENDANCE_SHEET, ATTENDANCE_HEADERS, []);
  ensureSheet_(ss, CLUSTERS_SHEET, CLUSTERS_HEADERS, SEED_CLUSTERS);
  ensureSheet_(ss, CAREERS_SHEET, CAREERS_HEADERS, SEED_CAREERS);
  ensureSheet_(ss, FEEDBACK_SHEET, FEEDBACK_HEADERS, []);
  ensureSheet_(ss, CHAT_SHEET, CHAT_HEADERS, []);
  ensureSheet_(ss, SETTINGS_SHEET, SETTINGS_HEADERS, SEED_SETTINGS);
  ensureSheet_(ss, CLASSES_SHEET, CLASSES_HEADERS, SEED_CLASSES);
  ensureSheet_(ss, SCHEDULE_SHEET, SCHEDULE_HEADERS, SEED_SCHEDULE);
  ensureSheet_(ss, MENTOR_APPLICATIONS_SHEET, MENTOR_APPLICATIONS_HEADERS, SEED_MENTOR_APPLICATIONS);
  ensureSheet_(ss, MENTOR_SURVEY_SHEET, MENTOR_SURVEY_HEADERS, SEED_MENTOR_SURVEY);
  ensureSheet_(ss, PRIVATE_CHAT_SHEET, PRIVATE_CHAT_HEADERS, []);
  ensureSheet_(ss, GROUP_CHAT_SHEET, GROUP_CHAT_HEADERS, []);
  ensureSheet_(ss, MENTOR_DATABASE_SHEET, MENTOR_DATABASE_HEADERS, SEED_MENTOR_DATABASE);
  ensureSheet_(ss, SESSION_SIGNUPS_SHEET, SESSION_SIGNUPS_HEADERS, []);
  ensureSheet_(ss, POLLS_SHEET, POLLS_HEADERS, []);
  ensureSheet_(ss, POLL_VOTES_SHEET, POLL_VOTES_HEADERS, []);
  ensureLogSheet_(ss);
  const message =
    "Setup complete. Team, Tasks, Students, Attendance, Clusters, Feedback and Chat tabs are ready.\n\n" +
    "IMPORTANT: Dr Muthoni, Cizarina and Margaret have starter PINs (1001/1002/1003) in the Team sheet so they can log in for the first time. " +
    "Please change SESSION_SECRET at the top of this file to your own random text before deploying, and have those three change their PIN " +
    "(Dashboard -> Team Access -> Regenerate PIN) right after their first login.";
  // getUi() only works when a function is invoked THROUGH the Sheet's own UI
  // (a custom menu click, a dialog, etc). Running setupSheets via the "Run"
  // button in the Apps Script editor -- exactly how the Setup Guide tells
  // you to run it the first time -- has no such UI session, so getUi()
  // throws "Cannot call SpreadsheetApp.getUi() from this context" even
  // though every sheet above was already created successfully. Logging the
  // same message means it's always visible (in the Execution Log when run
  // from the editor, or as a real popup if this is ever wired to a menu),
  // and the try/catch means a missing UI never makes the setup look like it
  // failed when it didn't.
  Logger.log(message);
  try {
    SpreadsheetApp.getUi().alert(message);
  } catch (e) {
    // No UI context available (e.g. run directly from the Apps Script
    // editor) -- setup already succeeded above, so this is not an error.
  }
}

function ensureSheet_(ss, name, headers, seedRows) {
  let sheet = ss.getSheetByName(name);
  if (sheet) {
    migrateHeaders_(sheet, headers); // already set up — top up any new columns, never touch existing data
    return sheet;
  }
  sheet = ss.insertSheet(name);
  sheet.appendRow(headers);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#7A1319").setFontColor("#FFFFFF");
  sheet.setFrozenRows(1);
  const now = new Date().toISOString();
  const rows = seedRows.map(function(r) {
    return headers.map(function(h) { return h === "updatedAt" ? now : (r[h] !== undefined ? r[h] : ""); });
  });
  if (rows.length) sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  sheet.autoResizeColumns(1, headers.length);
  return sheet;
}

// Adds any header this code now expects but the live sheet doesn't have yet,
// appended at the end (existing columns/data are never moved or touched).
// This is what makes it safe to add a new field to a *_HEADERS array and
// just re-run setupSheets() on a sheet that's already live with real data —
// see the note on STUDENTS_HEADERS above for why new fields must be
// appended at the end, not inserted in the middle.
function migrateHeaders_(sheet, headers) {
  const lastCol = sheet.getLastColumn();
  const existing = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  const missing = headers.filter(function(h) { return existing.indexOf(h) === -1; });
  if (!missing.length) return;
  const startCol = existing.length + 1;
  sheet.getRange(1, startCol, 1, missing.length).setValues([missing]);
  sheet.getRange(1, startCol, 1, missing.length).setFontWeight("bold").setBackground("#7A1319").setFontColor("#FFFFFF");
}

function ensureLogSheet_(ss) {
  let sheet = ss.getSheetByName(LOG_SHEET);
  if (sheet) return sheet;
  sheet = ss.insertSheet(LOG_SHEET);
  sheet.appendRow(LOG_HEADERS);
  sheet.getRange(1, 1, 1, LOG_HEADERS.length).setFontWeight("bold").setBackground("#7A1319").setFontColor("#FFFFFF");
  sheet.setFrozenRows(1);
  return sheet;
}

// ---------------------------------------------------------------------
// AUTH — per-person PIN login + signed tokens + access-level data scoping
// ---------------------------------------------------------------------
// Every request (except login itself, and a bare "ping") must carry a
// valid token or it's refused. This is what makes access control real
// rather than cosmetic: the API itself won't hand out data someone's
// accessLevel doesn't cover, regardless of what the app's UI shows.
function makeToken_(memberId, pin) {
  const raw = memberId + ":" + pin + ":" + SESSION_SECRET;
  const sig = Utilities.computeHmacSha256Signature(raw, SESSION_SECRET);
  const hex = sig.map(function(b) { return ((b < 0 ? b + 256 : b).toString(16)).padStart(2, "0"); }).join("");
  return memberId + "." + hex;
}

// Returns the Team row for a valid token, or null. Recomputes the expected
// token fresh from the CURRENT pin on file every time — so changing or
// blanking someone's pin instantly invalidates every token they were
// issued, with no separate "session store" to manage.
function verifyToken_(token) {
  if (!token || token.indexOf(".") === -1) return null;
  const memberId = token.split(".")[0];
  const team = readSheet_(TEAM_SHEET, TEAM_HEADERS);
  let me = null;
  for (let i = 0; i < team.length; i++) {
    if (team[i].id === memberId) { me = team[i]; break; }
  }
  if (!me || !me.pin) return null;
  return makeToken_(me.id, me.pin) === token ? me : null;
}

function requireAuth_(params) {
  const me = verifyToken_(params.token);
  if (!me) return { ok: false, error: "AUTH_REQUIRED", message: "Please sign in again." };
  if (!me.accessLevel) me.accessLevel = "cluster";
  return { ok: true, me: me };
}

function login_(body) {
  const name = (body.name || "").trim();
  const pin = (body.pin || "").trim();
  if (!name || !pin) return { ok: false, error: "Enter your name and PIN." };
  const team = readSheet_(TEAM_SHEET, TEAM_HEADERS);
  let me = null;
  for (let i = 0; i < team.length; i++) {
    if (String(team[i].name).trim().toLowerCase() === name.toLowerCase()) { me = team[i]; break; }
  }
  if (!me) return { ok: false, error: "No team member found with that name. Ask a Lead or Assistant Lead to add you first." };
  // Soft-deleted account (self-service delete or an admin removal via Team
  // Access — see deleteTeamAccount_) — blocked before the PIN check since
  // the PIN was cleared as part of deletion and "Incorrect PIN" would be a
  // misleading message here.
  if (me.status === "Deleted") return { ok: false, error: "This account has been deleted. Contact a WG2 Lead or Assistant Lead if you need it restored." };
  if (!me.pin) return { ok: false, error: "No PIN has been set for you yet. Ask a Lead or Assistant Lead to set one for you (Dashboard → Team Access)." };
  if (String(me.pin).trim() !== pin) return { ok: false, error: "Incorrect PIN." };
  logActivity_(me.name, "login", me.id, "");
  return {
    ok: true, memberId: me.id, name: me.name, role: me.role,
    accessLevel: me.accessLevel || "cluster", zone: me.zone, cluster: me.cluster, classStream: me.classStream,
    token: makeToken_(me.id, me.pin),
  };
}

function generatePin_() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// "Zone A" -> "A". Tolerates "A", "Zone-A", "zone a", etc.
function zoneLetterOf_(zoneText) {
  // Matches the letter at the END of "Zone A" / "A" / "zone-a", not just any
  // A-E character anywhere in the string — "ZONE" itself contains an "E",
  // which a bare /[A-E]/ would wrongly match first. Anchoring to the end
  // avoids that trap.
  const m = String(zoneText || "").trim().toUpperCase().match(/([A-E])\s*$/);
  return m ? m[1] : "";
}
// "A1 Medical Practitioners" or "A1" -> "A1". Matches the same free-text
// cluster field convention used throughout the Team sheet.
function extractClusterId_(clusterText) {
  const m = String(clusterText || "").toUpperCase().match(/^[A-E][1-6]/);
  return m ? m[0] : "";
}
function studentClustersOf_(row) {
  const set = {};
  [row.round1, row.round2, row.round3, row.round4].forEach(function(c) { if (c) set[c] = true; });
  if (row.choices) String(row.choices).split(",").forEach(function(c) { c = c.trim(); if (c) set[c] = true; });
  return Object.keys(set);
}

function visibleStudents_(me, allStudents) {
  if (me.accessLevel === "all") return allStudents;
  // Principal sees every student school-wide (registration stats, which
  // career/cluster they signed up for) — she isn't scoped to one zone or
  // cluster the way WG2 committee roles are, since this is a whole-school
  // concern for her, not a mentorship-logistics one.
  if (me.accessLevel === "principal") return allStudents;
  if (me.accessLevel === "zone") {
    const zoneLetter = zoneLetterOf_(me.zone);
    if (!zoneLetter) return [];
    return allStudents.filter(function(s) {
      return studentClustersOf_(s).some(function(cid) { return cid.charAt(0) === zoneLetter; });
    });
  }
  // Class Teachers are scoped by classStream, not by cluster — they need
  // their WHOLE class regardless of which cluster each student ends up
  // allocated to, not the students who happen to share one cluster.
  if (me.accessLevel === "class") {
    const myClass = String(me.classStream || "").trim();
    if (!myClass) return [];
    return allStudents.filter(function(s) { return String(s.classStream || "").trim() === myClass; });
  }
  const myClusterId = extractClusterId_(me.cluster);
  if (!myClusterId) return [];
  return allStudents.filter(function(s) { return studentClustersOf_(s).indexOf(myClusterId) !== -1; });
}

function visibleTeam_(me, allTeam) {
  // Admins keep seeing deleted accounts (status "Deleted") too — Team
  // Access is where a deletion gets reversed, so they need to still be
  // able to find and restore one. Everyone else never sees a deleted
  // person in Team/room-assignment/messaging lists — they've left.
  if (me.accessLevel === "all") return allTeam;
  const active = allTeam.filter(function(t) { return t.status !== "Deleted"; });
  if (me.accessLevel === "zone") {
    const zoneLetter = zoneLetterOf_(me.zone);
    return active.filter(function(t) {
      return t.id === me.id || zoneLetterOf_(t.zone) === zoneLetter || extractClusterId_(t.cluster).charAt(0) === zoneLetter;
    });
  }
  // A Class Teacher isn't managing other team members (unlike a Zone
  // Coordinator) — no other role shares their classStream in a meaningful
  // way, so they just see themselves, same as anyone else without a
  // matching cluster.
  const myClusterId = extractClusterId_(me.cluster);
  return active.filter(function(t) {
    return t.id === me.id || (myClusterId && extractClusterId_(t.cluster) === myClusterId);
  });
}

function visibleAttendance_(me, allAttendance, visStudents, visTeamRaw) {
  if (me.accessLevel === "all") return allAttendance;
  const ids = {};
  visStudents.forEach(function(s) { ids[s.id] = true; });
  visTeamRaw.forEach(function(t) { ids[t.id] = true; });
  return allAttendance.filter(function(a) { return ids[a.personId]; });
}

// A private message is visible only to its two participants — everyone
// else (including other "all"-access Leads) doesn't see it. Unlike Team/
// Students/Tasks, this isn't scoped by role/zone/cluster; it's scoped by
// literally being one of the two people in the conversation, full stop.
function visiblePrivateChat_(me, allPrivate) {
  return allPrivate.filter(function(m) { return m.fromId === me.id || m.toId === me.id; });
}

// Which group channels "me" belongs to, computed fresh from their CURRENT
// zone/cluster/role/accessLevel every call — never a stored membership
// list. That's deliberate: it means a Zone Coordinator moved from Zone B to
// Zone D, or a Mentor reassigned to a different cluster, is in the right
// group the very next time they open it, with nothing for a Lead to
// remember to update by hand.
function myGroupIds_(me) {
  if (me.accessLevel === "all") return ALL_GROUP_IDS.slice();
  const ids = [];
  const zoneLetter = zoneLetterOf_(me.zone) || extractClusterId_(me.cluster).charAt(0);
  if (zoneLetter && ALL_GROUP_IDS.indexOf("zone-" + zoneLetter) !== -1) ids.push("zone-" + zoneLetter);
  if (me.role === "Class Teacher" || me.accessLevel === "class") ids.push("class-teachers");
  if (me.accessLevel === "intern") ids.push("leads-interns");
  return ids;
}

function visibleFeedback_(me, allFeedback) {
  if (me.accessLevel === "all") return allFeedback;
  return allFeedback.filter(function(f) { return f.who === me.name; });
}

// The Mentor Database (historical mentors, outreach status, AI/heuristic
// cluster-fit) is internal outreach/resource-allocation info, not something
// every signed-in person needs — per WG2's request, only Lead/Assistant Lead,
// Zone Coordinators, and Interns can see or edit it. Plain Mentors, Sub-
// Leads, and Class Teachers cannot, same reasoning as mentor_applications
// being gated tighter than the "whole-event visible" default.
function canViewMentorDatabase_(me) {
  return me.accessLevel === "all" || me.accessLevel === "zone" || me.accessLevel === "intern";
}

// Bulk Import Mentors — per WG2's request, opened up to Interns as well as
// Lead/Assistant Lead (NOT Zone Coordinators — narrower than
// canViewMentorDatabase_ above on purpose, since this one creates live Team
// accounts + PINs immediately rather than just viewing/editing outreach
// records). Checked explicitly in doPost rather than added to ADMIN_ONLY,
// since ADMIN_ONLY there means "all" access strictly.
function canBulkImportMentors_(me) {
  return me.accessLevel === "all" || me.accessLevel === "intern";
}

// A task counts as "under Interns" if its owner field mentions Interns —
// matches the free-text convention already used throughout the seeded task
// tracker (e.g. "Interns", "Cizarina + Interns", "Interns (delegated)",
// "Interns + Zone Coordinators"). Case-insensitive on purpose, since the
// Tasks sheet is hand-edited and casing isn't guaranteed to be consistent.
function isInternTask_(task) {
  return /intern/i.test(task.owner || "");
}

// Same convention, for the class-teacher-relevant tasks already in the
// tracker under "WG8" (e.g. K048 pre-registration, K057 wristband/
// itinerary distribution, K069 walk-in desk) — Class Teachers ARE WG8, so
// this picks those up automatically without needing separate per-teacher
// rows added to the Tasks sheet.
function isClassTeacherTask_(task) {
  return /wg8|class teacher/i.test(task.owner || "");
}

// Tasks aren't scoped by zone/cluster for anyone — the whole task tracker
// is considered event-wide coordination info, not sensitive per-person data
// (see the comment on doGet's default action). Interns and Class Teachers
// are the exception: they only need their own slice, not the full tracker
// (which includes Leadership/Finance/other coordination tasks that aren't
// theirs to act on), so "intern"/"class" access narrows this one thing.
function visibleTasks_(me, allTasks) {
  if (me.accessLevel === "intern") return allTasks.filter(isInternTask_);
  if (me.accessLevel === "class") return allTasks.filter(isClassTeacherTask_);
  return allTasks;
}

// pin is never sent to the client, for anyone, at any access level —
// including someone looking at their own row. Resetting/setting a pin is a
// write-only action (update_access), never a value you can read back.
function sanitizeTeamRow_(row) {
  const copy = {};
  TEAM_HEADERS.forEach(function(h) { copy[h] = row[h]; });
  delete copy.pin;
  return copy;
}

// ---------------------------------------------------------------------
// PRINCIPAL ACCESS — a school-side role, not a WG2 committee role. Per the
// original request: "access... to all matters teachers and students... how
// many students signed up for what, and log ins to the sessions... but
// only within her jurisdiction as mentors and other parts of the app are
// out of her scope." Rather than patching every visibleXxx_ helper (each
// with its own default-visibility assumption that could silently leak
// something new later), this is enforced as a single allow-list gate at
// the very top of doGet/doPost: any action not explicitly listed here is
// refused outright for this access level, regardless of what that action
// would otherwise return. Read-only — no write action is in the POST list
// except the same self-service basics every signed-in role gets (fix your
// own contact details, change your own PIN, delete your own account).
// ---------------------------------------------------------------------
const PRINCIPAL_ALLOWED_GET_ACTIONS_ = ["all", "students", "classes", "clusters", "careers", "attendance"];
const PRINCIPAL_ALLOWED_POST_ACTIONS_ = ["update_my_details", "change_own_pin", "delete_my_account"];

// ---------------------------------------------------------------------
// HTTP ENTRY POINTS
// ---------------------------------------------------------------------
function doGet(e) {
  const action = (e.parameter.action || "all").toLowerCase();
  try {
    if (action === "ping") return jsonOut_({ ok: true });

    // Unauthenticated on purpose — this is what lets the public Mentor
    // Registration screen (no sign-in) show proper Zone/Cluster names in its
    // dropdown before the applicant is anyone the app recognises yet.
    // Non-sensitive: same "Clusters isn't sensitive" reasoning as the
    // authenticated "clusters" action below, just reachable without a token.
    if (action === "clusters_public") {
      return jsonOut_({ ok: true, clusters: readSheet_(CLUSTERS_SHEET, CLUSTERS_HEADERS) });
    }
    // Same reasoning as clusters_public — the public Student Registration
    // screen leads with CAREER names (girls know "I want to be a Surgeon"
    // long before they know that's under "Medical Practitioners"/"Zone A"),
    // so it needs the full career list, unauthenticated, before anyone signs
    // in. Also used to resolve a chosen career back to its cluster and to
    // build the Careers & Clusters Guide page.
    if (action === "careers_public") {
      return jsonOut_({ ok: true, careers: readSheet_(CAREERS_SHEET, CAREERS_HEADERS) });
    }
    // Same reasoning as clusters_public — lets the public Parent-Assisted
    // Student Registration screen show a real class/stream picker (not free
    // text, so a typo can't create a phantom class) before anyone signs in.
    if (action === "classes_public") {
      return jsonOut_({ ok: true, classes: readSheet_(CLASSES_SHEET, CLASSES_HEADERS) });
    }
    // Unauthenticated on purpose — this IS the one-tap "vote from the email"
    // link (see sendPollEmail_/pollVoteLinkUrl_). Returns an HTML page, not
    // JSON, since it's opened directly in a browser from an email, never by
    // the app itself. The HMAC token in the link (not a login) is what
    // proves this click belongs to that one recipient on that one poll —
    // see handlePublicPollVoteLink_/pollVoteToken_.
    if (action === "poll_vote_public") {
      return handlePublicPollVoteLink_(e.parameter);
    }

    const auth = requireAuth_(e.parameter);
    if (!auth.ok) return jsonOut_(auth);
    const me = auth.me;

    // See PRINCIPAL_ALLOWED_GET_ACTIONS_ above — everything else (Team
    // roster of mentors, Tasks, Feedback, Chat/DMs/Groups, Clusters room
    // logistics detail, Schedule, Session Rounds sign-ups, Polls, Mentor
    // Database/Profiles, Shared Team Files, Staff Directory, Mentor
    // Applications) is refused outright, not just hidden client-side.
    if (me.accessLevel === "principal" && PRINCIPAL_ALLOWED_GET_ACTIONS_.indexOf(action) === -1) {
      return jsonOut_({ ok: false, error: "This isn't available for your account." });
    }

    const allTeamRaw = readSheet_(TEAM_SHEET, TEAM_HEADERS);
    const allStudents = readSheet_(STUDENTS_SHEET, STUDENTS_HEADERS);
    const allAttendance = readSheet_(ATTENDANCE_SHEET, ATTENDANCE_HEADERS);
    const allClusters = readSheet_(CLUSTERS_SHEET, CLUSTERS_HEADERS);
    const allTasks = readSheet_(TASKS_SHEET, TASKS_HEADERS);
    const allFeedback = readSheet_(FEEDBACK_SHEET, FEEDBACK_HEADERS);
    const allChat = readSheet_(CHAT_SHEET, CHAT_HEADERS);
    const allSettings = settingsToObject_(readSheet_(SETTINGS_SHEET, SETTINGS_HEADERS));
    const allClasses = readSheet_(CLASSES_SHEET, CLASSES_HEADERS);
    const allSchedule = readSheet_(SCHEDULE_SHEET, SCHEDULE_HEADERS);
    const allSessionSignups = readSheet_(SESSION_SIGNUPS_SHEET, SESSION_SIGNUPS_HEADERS);
    const allPolls = readSheet_(POLLS_SHEET, POLLS_HEADERS);
    const allPollVotes = readSheet_(POLL_VOTES_SHEET, POLL_VOTES_HEADERS);

    const visStudents = visibleStudents_(me, allStudents);
    const visTeamRaw = visibleTeam_(me, allTeamRaw);
    const visTeam = visTeamRaw.map(sanitizeTeamRow_);
    const visAttendance = visibleAttendance_(me, allAttendance, visStudents, visTeamRaw);
    const visFeedback = visibleFeedback_(me, allFeedback);
    const visTasks = visibleTasks_(me, allTasks);

    if (action === "team") return jsonOut_({ ok: true, team: visTeam });
    if (action === "tasks") return jsonOut_({ ok: true, tasks: visTasks });
    if (action === "students") return jsonOut_({ ok: true, students: visStudents });
    if (action === "attendance") return jsonOut_({ ok: true, attendance: visAttendance });
    if (action === "clusters") return jsonOut_({ ok: true, clusters: allClusters });
    if (action === "careers") return jsonOut_({ ok: true, careers: readSheet_(CAREERS_SHEET, CAREERS_HEADERS) });
    if (action === "settings") return jsonOut_({ ok: true, settings: allSettings });
    if (action === "classes") return jsonOut_({ ok: true, classes: allClasses });
    if (action === "schedule") return jsonOut_({ ok: true, schedule: allSchedule });
    // Round sign-up grid — whole-event visible to every signed-in person
    // (same as Clusters/Settings/Classes/Schedule), since mentors need to
    // see every cluster's occupancy to decide whether to fill a thin round,
    // not just their own.
    if (action === "session_signups") return jsonOut_({ ok: true, sessionSignups: allSessionSignups });
    // Polls — whole-event visible, same as Clusters/Settings/Schedule.
    if (action === "polls") return jsonOut_({ ok: true, polls: allPolls, pollVotes: allPollVotes });
    // Mentor applications carry real personal detail (phone, referee, bio) —
    // deliberately gated to "all" here rather than following the usual
    // "Clusters/Settings/Classes/Schedule are whole-event visible" pattern.
    if (action === "mentor_applications") {
      if (me.accessLevel !== "all") return jsonOut_({ ok: false, error: "Only a Lead or Assistant Lead can view mentor applications." });
      return jsonOut_({ ok: true, applications: readSheet_(MENTOR_APPLICATIONS_SHEET, MENTOR_APPLICATIONS_HEADERS) });
    }
    // Historical Mentor Database — see canViewMentorDatabase_ for who gets
    // this (Lead/Assistant Lead, Zone Coordinators, Interns only).
    if (action === "mentor_database") {
      if (!canViewMentorDatabase_(me)) return jsonOut_({ ok: false, error: "Only a Lead, Assistant Lead, Zone Coordinator, or Intern can view the Mentor Database." });
      return jsonOut_({ ok: true, mentorDatabase: readSheet_(MENTOR_DATABASE_SHEET, MENTOR_DATABASE_HEADERS) });
    }
    // Every signed-in person gets back their OWN prior response (if any, so
    // the form can prefill/show "already submitted") plus, for admins only,
    // everyone's responses for the analytics + non-responder view.
    if (action === "mentor_survey") {
      const allResponses = readSheet_(MENTOR_SURVEY_SHEET, MENTOR_SURVEY_HEADERS);
      const mine = allResponses.find(function(r) { return r.teamMemberId === me.id; }) || null;
      if (me.accessLevel !== "all") return jsonOut_({ ok: true, mine: mine });
      return jsonOut_({ ok: true, mine: mine, responses: allResponses });
    }
    // Private 1:1 messages — filtered server-side to only the two
    // participants (see visiblePrivateChat_), same principle as
    // visibleStudents_/visibleTeam_: the API itself enforces this, not just
    // the UI, so a signed-in person can't read someone else's DMs by
    // guessing/replaying a request.
    if (action === "private_chat") {
      const allPrivate = readSheet_(PRIVATE_CHAT_SHEET, PRIVATE_CHAT_HEADERS);
      return jsonOut_({ ok: true, privateChat: visiblePrivateChat_(me, allPrivate) });
    }
    // Group channels — same server-side enforcement principle as
    // visiblePrivateChat_: membership is computed here (myGroupIds_), so the
    // API only ever returns messages from groups this person is actually in.
    if (action === "group_chat") {
      const myGroups = myGroupIds_(me);
      const allGroupMsgs = readSheet_(GROUP_CHAT_SHEET, GROUP_CHAT_HEADERS);
      return jsonOut_({
        ok: true,
        myGroups: myGroups,
        groupChat: allGroupMsgs.filter(function(m) { return myGroups.indexOf(m.groupId) !== -1; }),
      });
    }
    // Shared Team Files — core team only, same audience as the client's
    // canViewDocs() gate on the Docs & Orientation tab.
    if (action === "team_files") {
      if (me.role === "Mentor") return jsonOut_({ ok: false, error: "Only core team members can view shared files." });
      return jsonOut_({ ok: true, teamFiles: readSheet_(TEAM_FILES_SHEET, TEAM_FILES_HEADERS) });
    }
    // Staff & Team Directory — live leadership/zone/intern roster for the
    // Docs & Orientation tab's printable directory. Deliberately bypasses
    // visibleTeam_ (which scopes an Intern/Cluster-tier caller to only their
    // own cluster) because this directory is meant to be whole-team visible
    // to every non-Mentor member, same as the physical noticeboard copy
    // (Playbook Sec 19.8) — but it hand-picks only non-sensitive fields
    // (never the raw row, which carries the login PIN) and never includes
    // Mentors.
    if (action === "staff_directory") {
      if (me.role === "Mentor") return jsonOut_({ ok: false, error: "Only core team members can view the staff directory." });
      const DIRECTORY_ROLES = ["Lead", "Assistant Lead", "Zone Coordinator", "Intern", "School Liaison"];
      const allTeamForDirectory = readSheet_(TEAM_SHEET, TEAM_HEADERS);
      const directory = allTeamForDirectory
        .filter(function (t) { return t.status !== "Deleted" && DIRECTORY_ROLES.indexOf(t.role) !== -1; })
        .map(function (t) {
          return { name: t.name, role: t.role, zone: t.zone, phone: t.phone, status: t.status };
        });
      return jsonOut_({ ok: true, directory: directory });
    }
    // Mentor Database (profile gallery) — deliberately whole-event visible
    // to every signed-in person, unlike visibleTeam_/the "team" action above
    // (which scopes a plain "cluster"-tier Mentor to just their own cluster's
    // teammates). The whole point of this feature is browsing OTHER
    // clusters' mentors at a glance, so it needs its own read path rather
    // than reusing visibleTeam_. Hand-picks only non-sensitive, self-
    // authored fields — no phone/email/pin — per the "skip their contact"
    // requirement; messaging happens over the existing DM feature instead.
    if (action === "mentor_profiles") {
      const profiles = allTeamRaw
        .filter(function (t) { return t.status !== "Deleted" && ROOM_MENTOR_ROLES_SERVER_.indexOf(t.role) !== -1; })
        .map(function (t) {
          return {
            id: t.id,
            name: t.name,
            role: t.role,
            zone: t.zone,
            cluster: t.cluster,
            photoUrl: t.photoUrl || "",
            bio: t.bio || "",
            yearsParticipated: t.yearsParticipated || "",
          };
        });
      return jsonOut_({ ok: true, mentorProfiles: profiles });
    }

    // Principal's default payload — deliberately a hand-built subset, not
    // the shared "everything, scoped by access level" shape below: Team is
    // narrowed to active Class Teachers only (never mentors, Zone
    // Coordinators, or any other WG2 committee role — see the request's
    // "only within her jurisdiction"), and Tasks/Feedback/Chat/Settings/
    // Schedule/Session Rounds/Polls are omitted entirely rather than
    // filtered, since none of them are her concern at all.
    if (me.accessLevel === "principal") {
      const classTeachers = allTeamRaw
        .filter(function (t) { return t.status !== "Deleted" && t.role === "Class Teacher"; })
        .map(sanitizeTeamRow_);
      return jsonOut_({
        ok: true,
        me: { memberId: me.id, name: me.name, role: me.role, accessLevel: me.accessLevel, zone: me.zone, cluster: me.cluster, classStream: me.classStream },
        team: classTeachers,
        students: visStudents,
        attendance: visAttendance,
        clusters: allClusters,
        careers: readSheet_(CAREERS_SHEET, CAREERS_HEADERS),
        classes: allClasses,
        fetchedAt: new Date().toISOString(),
      });
    }

    // default: everything the app needs in one round trip, all scoped to
    // this person's access level (except Clusters, which isn't sensitive and
    // stays whole-event visible to every signed-in person). Tasks are
    // whole-event visible too, EXCEPT for "intern" access, which is narrowed
    // to just the tasks under Interns — see visibleTasks_. Settings,
    // Classes, and Schedule are whole-event visible too, same as Clusters —
    // none of them are sensitive per-person data.
    return jsonOut_({
      ok: true,
      me: { memberId: me.id, name: me.name, role: me.role, accessLevel: me.accessLevel, zone: me.zone, cluster: me.cluster, classStream: me.classStream },
      team: visTeam,
      tasks: visTasks,
      students: visStudents,
      attendance: visAttendance,
      clusters: allClusters,
      careers: readSheet_(CAREERS_SHEET, CAREERS_HEADERS),
      feedback: visFeedback,
      chat: allChat,
      settings: allSettings,
      classes: allClasses,
      schedule: allSchedule,
      sessionSignups: allSessionSignups,
      polls: allPolls,
      pollVotes: allPollVotes,
      fetchedAt: new Date().toISOString()
    });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

// Browsers send POST bodies from fetch() as text/plain here to avoid a
// CORS preflight (Apps Script doesn't handle OPTIONS). We parse it as JSON.
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = (body.action || "").toLowerCase();

    if (action === "login") return jsonOut_(login_(body));
    // Unauthenticated on purpose — this IS the "register without signing in"
    // flow. No token exists yet because the applicant isn't a Team member
    // yet; publicRegisterMentor_ only ever writes to MentorApplications
    // (status "Pending"), never to Team, so this can't grant access on its
    // own. A Lead/Assistant Lead must explicitly approve it afterward.
    if (action === "public_register_mentor") return jsonOut_(publicRegisterMentor_(body));
    // Unauthenticated on purpose — this is the parent-assisted student
    // registration flow (see publicRegisterStudent_). Since students are
    // minors, this path requires explicit parent/guardian consent fields
    // that the normal (staff-run) register_student action doesn't ask for.
    if (action === "public_register_student") return jsonOut_(publicRegisterStudent_(body));
    // Unauthenticated on purpose — lets a parent/student look up and amend
    // an existing registration's career choices before the deadline without
    // an account (see publicLookupStudent_/publicUpdateStudentChoices_).
    // Proof-of-ownership is the Career Day ID + name match inside each
    // function, not a login.
    if (action === "public_lookup_student") return jsonOut_(publicLookupStudent_(body));
    if (action === "public_update_student_choices") return jsonOut_(publicUpdateStudentChoices_(body));

    const auth = requireAuth_(body);
    if (!auth.ok) return jsonOut_(auth);
    const me = auth.me;
    body.who = me.name; // server-verified identity from here on — the client can no longer just claim any name

    // Principal is read-only outside her own account — see
    // PRINCIPAL_ALLOWED_POST_ACTIONS_ / the matching doGet gate above.
    if (me.accessLevel === "principal" && PRINCIPAL_ALLOWED_POST_ACTIONS_.indexOf(action) === -1) {
      return jsonOut_({ ok: false, error: "This isn't available for your account." });
    }

    // Actions only a Lead/Assistant Lead ("all" access) may perform.
    // "admin_delete_member" lets a Lead/Assistant Lead delete ANY team
    // member's account from the Team Access panel — see deleteTeamAccount_.
    // Not listed here: "delete_my_account" and "update_my_details", which
    // are deliberately self-service for every signed-in role (any team
    // member fixing their own missing/wrong contact info shouldn't need a
    // Lead) — each is scoped to the caller's own id server-side, never a
    // client-supplied one, so this doesn't open a way to edit someone else.
    const ADMIN_ONLY = ["update_access", "run_allocation", "resend_pin", "approve_mentor_application", "reject_mentor_application", "admin_delete_member", "approve_leadership_role", "decline_leadership_interest", "reassign_mentor_cluster"];
    if (ADMIN_ONLY.indexOf(action) !== -1 && me.accessLevel !== "all") {
      return jsonOut_({ ok: false, error: "Only a Lead or Assistant Lead can do this." });
    }

    // "intern"/"class" access may only touch tasks actually under
    // them — enforced here (not just via visibleTasks_ on the read side) so
    // someone can't update/reassign a task ID they were never shown just by
    // guessing or replaying an old request. Every other access level is
    // unrestricted for tasks, same as before.
    if ((action === "update_task_status" || action === "assign_task") && (me.accessLevel === "intern" || me.accessLevel === "class")) {
      const targetTask = readSheet_(TASKS_SHEET, TASKS_HEADERS).find(function(t) { return t.id === body.id; });
      const isMineTask = me.accessLevel === "intern" ? isInternTask_(targetTask || {}) : isClassTeacherTask_(targetTask || {});
      if (!targetTask || !isMineTask) {
        return jsonOut_({ ok: false, error: me.accessLevel === "intern" ? "You can only update tasks under Interns." : "You can only update tasks under WG8/Class Teachers." });
      }
    }
    if (action === "update_task_status") return jsonOut_(updateTaskStatus_(body));
    if (action === "assign_task") return jsonOut_(assignTask_(body));
    // Previously ungated (the client hid the button, but the API itself
    // would happily accept the write from anyone with a valid token — not
    // real access control). Matches update_cluster_room/update_setting's
    // "ops" tier: Leads, Assistant Leads, Zone Coordinators, and Interns can
    // all create and assign tasks; Mentors/Class Teachers/plain Cluster
    // access cannot.
    if (action === "add_task") {
      if (me.accessLevel !== "all" && me.accessLevel !== "zone" && me.accessLevel !== "intern") {
        return jsonOut_({ ok: false, error: "Only a Lead, Assistant Lead, Zone Coordinator, or Intern can add new tasks." });
      }
      return jsonOut_(addTask_(body));
    }
    if (action === "update_team_status") return jsonOut_(updateTeamStatus_(body));
    // Registering a Class Teacher grants "class" access to a real student
    // roster (see addTeamMember_'s safeDefault) — narrowed to Lead/Assistant
    // Lead/Zone Coordinator/Intern only, same "ops" tier as add_task/
    // update_cluster_room. Every OTHER role on this form (Mentor, Zone
    // Coordinator, Cluster Lead, Sub-Lead, WG8 Teacher Liaison, Member)
    // stays open to any signed-in team member — this is deliberately narrow
    // to just the role that carries elevated, class-scoped access.
    if ((action === "add_team_member" || action === "register_mentor") && body.role === "Class Teacher") {
      if (me.accessLevel !== "all" && me.accessLevel !== "zone" && me.accessLevel !== "intern") {
        return jsonOut_({ ok: false, error: "Only a Lead, Assistant Lead, Zone Coordinator, or Intern can register a Class Teacher." });
      }
    }
    if (action === "add_team_member") return jsonOut_(addTeamMember_(body, me));
    if (action === "register_student") return jsonOut_(registerStudent_(body));
    if (action === "register_mentor") return jsonOut_(addTeamMember_(body, me));
    if (action === "check_in") return jsonOut_(checkIn_(body));
    if (action === "walkin_register_checkin") return jsonOut_(registerWalkinAndCheckIn_(body));
    if (action === "run_allocation") return jsonOut_(runAllocation_(body));
    if (action === "bulk_register_students") return jsonOut_(bulkRegisterStudents_(body));
    if (action === "send_segment_email") {
      // Allow-listing "all"/"zone" (rather than just blocking "cluster")
      // means this stays safe by default for any future access level too —
      // including the new "intern" tier, which should not be able to send
      // event-wide emails.
      if (me.accessLevel !== "all" && me.accessLevel !== "zone") {
        return jsonOut_({ ok: false, error: "Only a Lead, Assistant Lead, or Zone Coordinator can send updates." });
      }
      return jsonOut_(sendSegmentEmail_(body, me));
    }
    if (action === "update_access") return jsonOut_(updateAccess_(body));
    // Admin path for the same soft-delete a person can do to themselves
    // (see delete_my_account below) — a Lead/Assistant Lead removing
    // someone else's account from Team Access. Shares deleteTeamAccount_
    // so both paths behave identically (blocks sign-in, keeps the row for
    // audit/task-history continuity).
    if (action === "admin_delete_member") return jsonOut_(deleteTeamAccount_(body, body.id, me.name));
    // "intern" is deliberately included here (not just all/zone) — room
    // coordination and mapping is exactly the kind of task that gets
    // delegated to an intern (see updateClusterRoom_/updateSetting_).
    if (action === "update_cluster_room") {
      if (me.accessLevel !== "all" && me.accessLevel !== "zone" && me.accessLevel !== "intern") {
        return jsonOut_({ ok: false, error: "Only a Lead, Assistant Lead, Zone Coordinator, or Intern can update room assignments." });
      }
      return jsonOut_(updateClusterRoom_(body, me));
    }
    if (action === "update_setting") {
      if (me.accessLevel === "cluster" || me.accessLevel === "class") {
        return jsonOut_({ ok: false, error: "Only a Lead, Assistant Lead, Zone Coordinator, or Intern can update this." });
      }
      return jsonOut_(updateSetting_(body));
    }
    if (action === "add_class" || action === "update_class") {
      if (me.accessLevel !== "all" && me.accessLevel !== "zone") {
        return jsonOut_({ ok: false, error: "Only a Lead, Assistant Lead, or Zone Coordinator can manage Classes & Streams." });
      }
      return jsonOut_(action === "add_class" ? addClass_(body) : updateClass_(body));
    }
    // Grants (or revokes) a student's optional 4th mentorship round — see
    // the note on spilloverApproved in STUDENTS_HEADERS. Deliberately NOT
    // self-service: this is WG2 privately arranging the extra session with
    // a specific mentor/cluster ahead of time, not a request a parent can
    // trigger on her own. Same access level as Classes & Streams — a
    // judgment call, not something to delegate broadly.
    if (action === "set_student_spillover") {
      if (me.accessLevel !== "all" && me.accessLevel !== "zone") {
        return jsonOut_({ ok: false, error: "Only a Lead, Assistant Lead, or Zone Coordinator can approve an extra mentorship session." });
      }
      return jsonOut_(setStudentSpillover_(body));
    }
    // Explicitly opened up to Interns too, per WG2's request — leads AND
    // interns both need to be able to correct session times as the wider
    // Career Day programme firms up.
    if (action === "update_schedule_slot") {
      if (me.accessLevel === "cluster" || me.accessLevel === "class") {
        return jsonOut_({ ok: false, error: "Only a Lead, Assistant Lead, Zone Coordinator, or Intern can update the schedule." });
      }
      return jsonOut_(updateScheduleSlot_(body));
    }
    // Round sign-up grid. Both actions have their own internal two-tier
    // gating (self-service vs. ops-tier override) rather than being listed
    // in ADMIN_ONLY, since a plain Mentor/Cluster Lead/Sub-Lead must be able
    // to sign themselves up without Lead/Assistant Lead involvement — see
    // claimSessionSlot_/releaseSessionSlot_ for the exact rules.
    if (action === "claim_session_slot") return jsonOut_(claimSessionSlot_(body, me));
    if (action === "release_session_slot") return jsonOut_(releaseSessionSlot_(body, me));
    // Coordination Brief email — the client already computed the content
    // (buildCoordinationBrief_ in app.js, from data it already has loaded),
    // so this just sends it. Kept as its own action rather than folded into
    // send_segment_email since the gating shape is different: self-service
    // to your OWN email only, or "ops" tier (Lead/Assistant Lead/Zone
    // Coordinator/Intern) to anyone.
    if (action === "send_coordination_brief") return jsonOut_(sendCoordinationBrief_(body, me));
    // Polls. Creating one is "ops" tier (Lead/Assistant Lead/Zone
    // Coordinator/Intern — same as add_task); voting is self-service for
    // any signed-in person; closing is the creator OR ops tier — see
    // createPoll_/votePoll_/closePoll_ for the exact rules.
    if (action === "create_poll") {
      if (me.accessLevel !== "all" && me.accessLevel !== "zone" && me.accessLevel !== "intern") {
        return jsonOut_({ ok: false, error: "Only a Lead, Assistant Lead, Zone Coordinator, or Intern can create a poll." });
      }
      return jsonOut_(createPoll_(body, me));
    }
    if (action === "vote_poll") return jsonOut_(votePoll_(body, me));
    if (action === "close_poll") return jsonOut_(closePoll_(body, me));
    // Emailing a poll out (one-tap vote links — see sendPollEmail_) is
    // deliberately narrower than create_poll's gate above: per WG2's
    // request this is Lead/Assistant Lead ("all") and Intern only, NOT Zone
    // Coordinators. If that's ever meant to widen to Zone Coordinators too,
    // add "|| me.accessLevel === 'zone'" here (matches create_poll's gate).
    if (action === "send_poll_email") {
      if (me.accessLevel !== "all" && me.accessLevel !== "intern") {
        return jsonOut_({ ok: false, error: "Only a Lead, Assistant Lead, or Intern can email a poll." });
      }
      return jsonOut_(sendPollEmail_(body, me));
    }
    if (action === "submit_feedback") return jsonOut_(submitFeedback_(body));
    if (action === "resolve_feedback") {
      if (me.accessLevel !== "all") return jsonOut_({ ok: false, error: "Only a Lead or Assistant Lead can reply to feedback." });
      return jsonOut_(resolveFeedback_(body));
    }
    if (action === "post_chat") return jsonOut_(postChat_(body));
    if (action === "send_private_message") return jsonOut_(sendPrivateMessage_(body, me));
    if (action === "mark_private_read") return jsonOut_(markPrivateRead_(body, me));
    if (action === "post_group_message") return jsonOut_(postGroupMessage_(body, me));
    if (action === "upload_team_file") return jsonOut_(uploadTeamFile_(body, me));
    if (action === "email_own_qr") return jsonOut_(emailOwnQr_(body));
    if (action === "resend_pin") return jsonOut_(resendPin_(body));
    if (action === "change_own_pin") return jsonOut_(changeOwnPin_(body, me));
    // Self-service "My Details" (Account panel) — name/phone/email only.
    // Deliberately excludes role/accessLevel/zone/cluster/classStream/pin,
    // which stay Lead-controlled via Team Access since they change what
    // someone can SEE, not just how to reach them. Always scoped to the
    // caller's own row (me.id from the verified token), never body.id.
    if (action === "update_my_details") return jsonOut_(updateMyDetails_(body, me));
    // Self-service Mentor Database profile (bio + years participated) and
    // photo upload — same "always scoped to me.id" self-service pattern as
    // update_my_details above, open to every signed-in room mentor tier.
    // Not role-gated: harmless self-descriptive content regardless of role.
    if (action === "update_my_profile") return jsonOut_(updateMyProfile_(body, me));
    if (action === "upload_my_photo") return jsonOut_(uploadMyPhoto_(body, me));
    // Self-service "raise your hand" for Cluster Lead/Sub-Lead/Zone
    // Coordinator — open to every signed-in role on purpose (see
    // requestLeadershipRole_), always scoped to the caller's own row.
    if (action === "request_leadership_role") return jsonOut_(requestLeadershipRole_(body, me));
    // Self-service account deletion — see deleteTeamAccount_. Open to every
    // signed-in role on purpose (an intern or mentor who's stepped down
    // shouldn't have to ask a Lead to remove them), always scoped to the
    // caller's own row.
    if (action === "delete_my_account") return jsonOut_(deleteTeamAccount_(body, me.id, me.name));
    if (action === "approve_mentor_application") return jsonOut_(approveMentorApplication_(body, me));
    if (action === "reject_mentor_application") return jsonOut_(rejectMentorApplication_(body, me));
    if (action === "approve_leadership_role") return jsonOut_(approveLeadershipRole_(body, me));
    if (action === "decline_leadership_interest") return jsonOut_(declineLeadershipInterest_(body, me));
    if (action === "reassign_mentor_cluster") return jsonOut_(reassignMentorCluster_(body, me));
    if (action === "bulk_register_mentors") {
      if (!canBulkImportMentors_(me)) return jsonOut_({ ok: false, error: "Only a Lead, Assistant Lead, or Intern can bulk-import mentors." });
      return jsonOut_(bulkRegisterMentors_(body, me));
    }
    if (action === "submit_mentor_survey") return jsonOut_(submitMentorSurvey_(body, me));

    // Mentor Database actions — all gated to canViewMentorDatabase_ (Lead/
    // Assistant Lead, Zone Coordinators, Interns), same access rule as the
    // mentor_database read action above.
    if (action === "update_mentor_database_entry" || action === "add_mentor_database_entry" || action === "suggest_mentor_fit") {
      if (!canViewMentorDatabase_(me)) return jsonOut_({ ok: false, error: "Only a Lead, Assistant Lead, Zone Coordinator, or Intern can manage the Mentor Database." });
      if (action === "update_mentor_database_entry") return jsonOut_(updateMentorDatabaseEntry_(body, me));
      if (action === "add_mentor_database_entry") return jsonOut_(addMentorDatabaseEntry_(body, me));
      if (action === "suggest_mentor_fit") return jsonOut_(suggestMentorFit_(body));
    }

    return jsonOut_({ ok: false, error: "Unknown action: " + action });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

// ---------------------------------------------------------------------
// READ HELPERS
// ---------------------------------------------------------------------
function readSheet_(name, headers) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return values
    .filter(function(row) { return row[0] !== ""; })
    .map(function(row) {
      const obj = {};
      headers.forEach(function(h, i) { obj[h] = row[i]; });
      return obj;
    });
}

function findRowById_(sheet, headers, id) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) return i + 2; // 1-indexed, +1 for header row
  }
  return -1;
}

function logActivity_(who, action, targetId, detail) {
  const sheet = ensureLogSheet_(SpreadsheetApp.getActiveSpreadsheet());
  sheet.appendRow([new Date().toISOString(), who || "unknown", action, targetId || "", detail || ""]);
}

// ---------------------------------------------------------------------
// WRITE ACTIONS
// ---------------------------------------------------------------------
function updateTaskStatus_(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TASKS_SHEET);
  const row = findRowById_(sheet, TASKS_HEADERS, body.id);
  if (row === -1) return { ok: false, error: "Task not found: " + body.id };
  const stateCol = TASKS_HEADERS.indexOf("state") + 1;
  const updatedCol = TASKS_HEADERS.indexOf("updatedAt") + 1;
  sheet.getRange(row, stateCol).setValue(body.state);
  sheet.getRange(row, updatedCol).setValue(new Date().toISOString());
  logActivity_(body.who, "update_task_status", body.id, body.state);
  return { ok: true };
}

function assignTask_(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TASKS_SHEET);
  const row = findRowById_(sheet, TASKS_HEADERS, body.id);
  if (row === -1) return { ok: false, error: "Task not found: " + body.id };
  const ownerCol = TASKS_HEADERS.indexOf("owner") + 1;
  const updatedCol = TASKS_HEADERS.indexOf("updatedAt") + 1;
  sheet.getRange(row, ownerCol).setValue(body.owner);
  sheet.getRange(row, updatedCol).setValue(new Date().toISOString());
  logActivity_(body.who, "assign_task", body.id, "-> " + body.owner);
  return { ok: true };
}

function addTask_(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TASKS_SHEET);
  const lastRow = sheet.getLastRow();
  const ids = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(function(r) { return r[0]; }) : [];
  let n = ids.length + 1;
  let newId = "K" + String(n).padStart(3, "0");
  while (ids.indexOf(newId) !== -1) { n++; newId = "K" + String(n).padStart(3, "0"); }
  const now = new Date().toISOString();
  const row = TASKS_HEADERS.map(function(h) {
    if (h === "id") return newId;
    if (h === "updatedAt") return now;
    if (h === "state") return body.state || "Pending";
    if (h === "status") return body.status || "Pending";
    return body[h] || "";
  });
  sheet.appendRow(row);
  logActivity_(body.who, "add_task", newId, body.task);
  return { ok: true, id: newId };
}

function updateTeamStatus_(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TEAM_SHEET);
  const row = findRowById_(sheet, TEAM_HEADERS, body.id);
  if (row === -1) return { ok: false, error: "Team member not found: " + body.id };
  const statusCol = TEAM_HEADERS.indexOf("status") + 1;
  const updatedCol = TEAM_HEADERS.indexOf("updatedAt") + 1;
  sheet.getRange(row, statusCol).setValue(body.status);
  sheet.getRange(row, updatedCol).setValue(new Date().toISOString());
  logActivity_(body.who, "update_team_status", body.id, body.status);
  return { ok: true };
}

// requester: the signed-in Team row making this call (from doPost's auth).
// Anyone signed in can register a new team member (keeps the existing
// "recruit a mentor on the spot" flow working), but only a requester with
// "all" access can set anything other than the safe self-registration
// default — so a non-admin can't grant themselves or anyone else broader
// access by just passing accessLevel in the request body. "class" is that
// safe default for role "Class Teacher" (scoped to their own class/stream,
// exactly as narrow as "cluster" is for anyone else — not a privilege
// escalation, just a different scoping axis); everyone else still
// defaults to "cluster".
function addTeamMember_(body, requester) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TEAM_SHEET);
  const lastRow = sheet.getLastRow();
  const existing = readSheet_(TEAM_SHEET, TEAM_HEADERS);
  const ids = existing.map(function(r) { return r.id; });
  let n = ids.length + 1;
  let newId = "T" + String(n).padStart(3, "0");
  while (ids.indexOf(newId) !== -1) { n++; newId = "T" + String(n).padStart(3, "0"); }

  const isAdmin = requester && requester.accessLevel === "all";
  const safeDefault = body.role === "Class Teacher" ? "class" : body.role === "Principal" ? "principal" : "cluster";
  const accessLevel = (isAdmin && body.accessLevel) ? body.accessLevel : safeDefault;
  const pin = generatePin_(); // always auto-generate, so the new person can sign in immediately
  const now = new Date().toISOString();
  const row = TEAM_HEADERS.map(function(h) {
    if (h === "id") return newId;
    if (h === "updatedAt") return now;
    // Whoever fills out this form — the person themselves, or staff
    // adding them on the spot — is actively confirming they're
    // participating right now, not just being logged as a lead to chase
    // later. So the default is "Confirmed"; explicitly passing a status
    // (e.g. "Unconfirmed" for a secondhand/poll entry someone still needs
    // to verify) always overrides it.
    if (h === "status") return body.status || "Confirmed";
    if (h === "accessLevel") return accessLevel;
    if (h === "pin") return pin;
    if (h === "mode") return body.mode || "In-person";
    return body[h] || "";
  });
  sheet.appendRow(row);
  logActivity_(body.who, "add_team_member", newId, body.name);

  // Best-effort only, same pattern as emailOwnQr_ — the registration above
  // has already succeeded, so a bad address or a Gmail quota hiccup here
  // must never look like the signup itself failed.
  emailPinIfPossible_(body.email, body.name, pin);

  const duplicate = similarNameExists_(existing, body.name, null);
  return { ok: true, id: newId, pin: pin, accessLevel: accessLevel, duplicateWarning: duplicate ? "Someone named \"" + body.name + "\" is already on the Team list — double check this isn't a repeat entry." : "" };
}

// Shared by addTeamMember_ (new registrations) and resendPin_ (admin-
// triggered resend for people already on the roster). Silently no-ops if
// the address is missing/invalid or the send throws — callers treat this
// as best-effort and never surface a failure here as if it were their own
// action failing.
function emailPinIfPossible_(email, name, pin) {
  const to = String(email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || !pin) return false;
  try {
    const plainBody =
      "Hi " + (name || "") + ",\n\n" +
      "Here's how to sign in to BOMA Career Day - CMP Mentors Hub:\n\n" +
      "Name: " + (name || "") + "\n" +
      "PIN: " + pin + "\n\n" +
      "Sign in here: " + APP_URL + "\n" +
      "Change your PIN any time after signing in: " + APP_URL + "?intent=changepin\n\n" +
      SENDER_NAME;
    const htmlBody =
      "<p>Hi " + escapeHtml_(name || "") + ",</p>" +
      "<p>Here's how to sign in to BOMA Career Day - CMP Mentors Hub:</p>" +
      "<p>Name: <b>" + escapeHtml_(name || "") + "</b><br>PIN: <b>" + escapeHtml_(pin) + "</b></p>" +
      pinEmailButtonsHtml_() +
      "<p>You can change this PIN any time after signing in — tap your name at the top of the app, or use the button above.</p>" +
      "<p>" + escapeHtml_(SENDER_NAME) + "</p>";
    MailApp.sendEmail({
      to: to,
      subject: "Your WG2 Boma Career Day 2026 sign-in PIN",
      body: plainBody,
      htmlBody: htmlBody,
      name: SENDER_NAME,
      from: SENDER_EMAIL,
    });
    return true;
  } catch (err) {
    return false;
  }
}

// ---------------------------------------------------------------------
// MENTOR APPLICATIONS — public, no-sign-in registration + admin approval
// ---------------------------------------------------------------------
// Reused by publicRegisterMentor_ below.
function isValidEmail_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

// PUBLIC — reachable with no token (see doPost). Anyone with the app link
// can submit one of these; it only ever writes to MentorApplications with
// status "Pending" and never touches the Team sheet, so it cannot grant
// sign-in access on its own. Validation here is deliberately real (not just
// client-side) since an unauthenticated endpoint has to defend itself.
function publicRegisterMentor_(body) {
  const name = String(body.name || "").trim();
  const phone = String(body.phone || "").trim();
  const email = String(body.email || "").trim();
  const exbomarian = String(body.exbomarian || "").trim();
  const refereeName = String(body.refereeName || "").trim();
  const primaryCluster = String(body.primaryCluster || "").trim().toUpperCase();
  const shifts = String(body.shifts || "").trim();
  const mode = String(body.mode || "").trim();
  const consent = body.consent === true || body.consent === "true" || body.consent === "Yes" || body.consent === "I agree";

  if (!name) return { ok: false, error: "Full name is required." };
  if (!phone) return { ok: false, error: "Phone number is required." };
  if (!isValidEmail_(email)) return { ok: false, error: "A valid email address is required." };
  if (exbomarian !== "Yes" && exbomarian !== "No") return { ok: false, error: "Please answer the Bomarian question." };
  if (exbomarian === "No" && !refereeName) return { ok: false, error: "Please give your referee's full name." };
  if (!String(body.jobTitle || "").trim()) return { ok: false, error: "Job title is required." };
  if (!String(body.organisation || "").trim()) return { ok: false, error: "Organisation/employer is required." };
  if (!String(body.profession || "").trim()) return { ok: false, error: "Profession / field of expertise is required." };
  if (!String(body.yearsExperience || "").trim()) return { ok: false, error: "Please select your years of experience." };
  if (!String(body.bio || "").trim()) return { ok: false, error: "A short professional bio is required." };
  const clusters = readSheet_(CLUSTERS_SHEET, CLUSTERS_HEADERS);
  if (!primaryCluster || !clusters.some(function(c) { return c.id === primaryCluster; })) {
    return { ok: false, error: "Please choose a valid career cluster." };
  }
  if (!shifts) return { ok: false, error: "Please select at least one shift you're available for." };
  if (mode !== "In-person" && mode !== "Live virtual" && mode !== "Pre-recorded") {
    return { ok: false, error: "Please tell us how you'll participate (in-person or virtual)." };
  }
  if (!consent) return { ok: false, error: "Please confirm the declaration to submit." };

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MENTOR_APPLICATIONS_SHEET);
  const existing = readSheet_(MENTOR_APPLICATIONS_SHEET, MENTOR_APPLICATIONS_HEADERS);
  const ids = existing.map(function(r) { return r.id; });
  let n = ids.length + 1;
  let newId = "MA" + String(n).padStart(3, "0");
  while (ids.indexOf(newId) !== -1) { n++; newId = "MA" + String(n).padStart(3, "0"); }

  const now = new Date().toISOString();
  const row = MENTOR_APPLICATIONS_HEADERS.map(function(h) {
    if (h === "id") return newId;
    if (h === "submittedAt") return now;
    if (h === "status") return "Pending";
    if (h === "name") return name;
    if (h === "phone") return phone;
    if (h === "email") return email;
    if (h === "exbomarian") return exbomarian;
    if (h === "primaryCluster") return primaryCluster;
    if (h === "secondaryCluster") return String(body.secondaryCluster || "").trim().toUpperCase();
    if (h === "shifts") return shifts;
    if (h === "mode") return mode;
    if (h === "additionalRole") return String(body.additionalRole || "").trim();
    if (h === "consent") return "Yes";
    if (h === "teamMemberId" || h === "reviewedBy" || h === "reviewedAt" || h === "reviewNotes") return "";
    // suggestedClusterId/Name/aiStrengthsSummary are INTERNAL-ONLY — never
    // trust these from the client even if a field with that name were sent;
    // suggestedCluster* is filled in right below via the (free) heuristic
    // matcher, aiStrengthsSummary stays blank until an admin explicitly
    // requests the (optional, external-call) Gemini summary from the Mentor
    // Applications review screen, so submitting the public form never has to
    // wait on a network call to a third party.
    if (h === "suggestedClusterId" || h === "suggestedClusterName" || h === "aiStrengthsSummary") return "";
    return body[h] !== undefined ? String(body[h]).trim() : "";
  });

  // Auto-suggest a matching/alternate cluster from the applicant's own
  // words (job title, profession, bio, and any LinkedIn/profile link they
  // chose to share) — free, synchronous, heuristic-only (no external call on
  // this path) — so a Lead/Assistant Lead reviewing the application already
  // has "this person might also fit X" without asking anyone to run it by
  // hand. See suggestClusterFit_ above.
  try {
    const fitText = [body.jobTitle, body.profession, body.organisation, body.bio, body.linkedinOrProfile].filter(Boolean).join(". ");
    const fits = suggestClusterFit_(fitText, 1);
    if (fits[0]) {
      row[MENTOR_APPLICATIONS_HEADERS.indexOf("suggestedClusterId")] = fits[0].clusterId;
      row[MENTOR_APPLICATIONS_HEADERS.indexOf("suggestedClusterName")] = fits[0].clusterName;
    }
  } catch (err) { /* never block registration on the suggestion */ }

  sheet.appendRow(row);
  logActivity_(name, "public_register_mentor", newId, email);
  return { ok: true, id: newId };
}

// Lead/Assistant Lead only (enforced via ADMIN_ONLY in doPost). Creates the
// real Team row (auto-generated PIN, same as addTeamMember_), links it back
// to the application, and emails the applicant their PIN + cluster
// assignment. body.cluster lets the reviewer override the applicant's
// requested cluster (e.g. if it's oversubscribed) before approving —
// defaults to their primary choice.
// Maps any of the free-text labels used around the app (the public
// application form's checkboxes, the manual Add Team Member role dropdown,
// a self-service request) to the ONE canonical Team.role string each
// leadership role is stored/filtered as elsewhere (ROOM_MENTOR_ROLES in
// app.js, ADMIN_ONLY gating, etc). Notably the application form's checkbox
// says "Cluster Sub-Lead" but the Team role has always been just
// "Sub-Lead" — this is the single place that mismatch gets resolved so a
// promotion never silently creates a role string nothing else recognizes.
// Returns "" for anything that isn't a real leadership role (e.g. "Mentor
// only — no additional role").
function canonicalLeadershipRole_(text) {
  const s = String(text || "").trim().toLowerCase();
  if (s.indexOf("sub-lead") !== -1 || s.indexOf("sub lead") !== -1) return "Sub-Lead";
  if (s.indexOf("cluster lead") !== -1) return "Cluster Lead";
  if (s.indexOf("zone coordinator") !== -1) return "Zone Coordinator";
  return "";
}

// ---------------------------------------------------------------------
// MENTOR CAPACITY HELPERS — server-side mirrors of the same keyword-based
// shift matching app.js already uses (shiftsCoverMorning_/shiftsCoverAfternoon_
// there), kept deliberately in sync in wording so a cell edited by hand
// still matches on both sides. Used only by approveMentorApplication_'s
// capacity check below and reassignMentorCluster_ — the client does the
// same math itself for display (computeClusterCommandData_), this is just
// the authoritative check at the moment a new mentor is actually admitted,
// so two people approved back-to-back can't both slip past a cluster's cap.
// ---------------------------------------------------------------------
const ROOM_MENTOR_ROLES_SERVER_ = ["Mentor", "Cluster Lead", "Sub-Lead"];

function shiftsCoverMorningServer_(raw) {
  const s = String(raw || "").toLowerCase();
  return s.indexOf("morning") !== -1 || s.indexOf("either") !== -1 || s.indexOf("both") !== -1;
}
function shiftsCoverAfternoonServer_(raw) {
  const s = String(raw || "").toLowerCase();
  return s.indexOf("afternoon") !== -1 || s.indexOf("either") !== -1 || s.indexOf("both") !== -1;
}

// Same anchored-match convention as teamMemberCluster() in app.js: a Team
// row's `cluster` cell is free text like "A1 Medical Practitioners", so we
// only trust an ID match at the very start of the string.
function teamRowClusterId_(clusterCellText) {
  const text = String(clusterCellText || "").trim();
  const m = text.match(/^([A-E][1-6])\b/);
  return m ? m[1] : "";
}

function mentorCapacityPerShift_() {
  const settings = settingsToObject_(readSheet_(SETTINGS_SHEET, SETTINGS_HEADERS));
  const n = parseInt(settings.mentorCapacityPerShift, 10);
  return isNaN(n) || n <= 0 ? 8 : n;
}

// Counts active (non-Deleted) room-mentor-tier Team members whose PRIMARY
// cluster is clusterId and whose shifts cover shiftLabel ("Morning" |
// "Afternoon"). Deliberately mirrors clusterStats()'s `mentors` count in
// app.js — same population, same meaning — so "is this cluster full"
// checked here agrees with what the roster/report already shows.
function countActiveMentorsForClusterShift_(teamRows, clusterId, shiftLabel) {
  const shiftCheck = shiftLabel === "Morning" ? shiftsCoverMorningServer_ : shiftsCoverAfternoonServer_;
  return teamRows.filter(function(t) {
    return t.status !== "Deleted" &&
      ROOM_MENTOR_ROLES_SERVER_.indexOf(t.role) !== -1 &&
      teamRowClusterId_(t.cluster) === clusterId &&
      shiftCheck(t.shifts);
  }).length;
}

function approveMentorApplication_(body, me) {
  const apps = readSheet_(MENTOR_APPLICATIONS_SHEET, MENTOR_APPLICATIONS_HEADERS);
  const app = apps.find(function(a) { return a.id === body.id; });
  if (!app) return { ok: false, error: "Application not found." };
  if (app.status === "Approved") return { ok: false, error: "This application was already approved." };

  const clusters = readSheet_(CLUSTERS_SHEET, CLUSTERS_HEADERS);
  const existingTeamForCapacity = readSheet_(TEAM_SHEET, TEAM_HEADERS);

  // Capacity-aware assignment: only when the reviewer did NOT explicitly
  // pick a cluster (body.cluster blank) — an explicit override is a human
  // decision ("we need someone here regardless") and must never be
  // second-guessed by this auto-fallback. Otherwise, check the applicant's
  // own primary choice against mentorCapacityPerShift for every shift
  // they're actually available for; if ALL of those shifts are already at
  // or over capacity there, and their secondary choice is a real cluster
  // with room in at least one of those same shifts, they're auto-placed in
  // the secondary cluster instead — same as WG2 asked for ("when a cluster
  // is full... they can be automatically assigned to their 2nd choice").
  // If only SOME of their shifts are full, they still go to their primary
  // choice (they're still real coverage for the shift that has room).
  let cluster = String(body.cluster || app.primaryCluster || "").trim().toUpperCase();
  let autoAssignedFromPrimary = "";
  if (!body.cluster) {
    const primaryId = cluster;
    const secondaryId = String(app.secondaryCluster || "").trim().toUpperCase();
    const capacity = mentorCapacityPerShift_();
    const coversMorning = shiftsCoverMorningServer_(app.shifts);
    const coversAfternoon = shiftsCoverAfternoonServer_(app.shifts);
    const shiftsToCheck = [];
    if (coversMorning) shiftsToCheck.push("Morning");
    if (coversAfternoon) shiftsToCheck.push("Afternoon");
    const primaryExists = clusters.some(function(c) { return c.id === primaryId; });
    if (primaryExists && shiftsToCheck.length && secondaryId && secondaryId !== primaryId && clusters.some(function(c) { return c.id === secondaryId; })) {
      const allShiftsFullAtPrimary = shiftsToCheck.every(function(sh) {
        return countActiveMentorsForClusterShift_(existingTeamForCapacity, primaryId, sh) >= capacity;
      });
      if (allShiftsFullAtPrimary) {
        const secondaryHasRoom = shiftsToCheck.some(function(sh) {
          return countActiveMentorsForClusterShift_(existingTeamForCapacity, secondaryId, sh) < capacity;
        });
        if (secondaryHasRoom) {
          autoAssignedFromPrimary = primaryId;
          cluster = secondaryId;
        }
      }
    }
  }

  const clusterRow = clusters.find(function(c) { return c.id === cluster; });
  const zoneLetter = cluster.charAt(0);

  // The backup (secondary) choice is always recorded on the Team row when
  // it's a real, distinct cluster — even if it wasn't needed this time —
  // so "who'd consider helping cluster X" (the Cluster Command Center's
  // Backup Mentors list) stays accurate for the rest of the season, not
  // just at the moment of approval. Left blank if it's the same cluster
  // they actually landed in (nothing left to list as a "backup").
  const secondaryClusterId = String(app.secondaryCluster || "").trim().toUpperCase();
  const secondaryClusterRow = secondaryClusterId && secondaryClusterId !== cluster
    ? clusters.find(function(c) { return c.id === secondaryClusterId; })
    : null;

  const teamSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TEAM_SHEET);
  const existingTeam = existingTeamForCapacity;
  const teamIds = existingTeam.map(function(r) { return r.id; });
  let n = teamIds.length + 1;
  let newTeamId = "T" + String(n).padStart(3, "0");
  while (teamIds.indexOf(newTeamId) !== -1) { n++; newTeamId = "T" + String(n).padStart(3, "0"); }

  const pin = generatePin_();
  const now = new Date().toISOString();
  const noteParts = [];
  if (app.profession) noteParts.push(app.profession);
  if (app.organisation) noteParts.push("at " + app.organisation);
  const noteBase = noteParts.length ? noteParts.join(" ") + ". " : "";
  // Optional reviewer remark (body.reviewNotes) — captured at approval time,
  // e.g. "confirm she can make the 27 Aug briefing" — folded straight into
  // this mentor's own Team `notes` field (not just the now-closed
  // application record) specifically so it's visible wherever interns
  // actually look a mentor up to follow up (Mentor Database, Cluster
  // Command Center), not buried in a reviewed application nobody revisits.
  const reviewerRemark = String(body.reviewNotes || "").trim();
  const autoAssignNote = autoAssignedFromPrimary
    ? " Auto-assigned to their 2nd-choice cluster (" + cluster + ") because " + autoAssignedFromPrimary + " was already at capacity for their shift(s)."
    : "";
  const notes = "From mentor application " + app.id + ". " + noteBase + "Shifts: " + (app.shifts || "—") + ". Mode: " + (app.mode || "In-person") + "." +
    autoAssignNote + (reviewerRemark ? " Reviewer note: " + reviewerRemark : "");

  // The application's "additional role" checkboxes (Cluster Lead / Sub-Lead
  // / Zone Coordinator) are a candidate's OWN stated interest, not an
  // automatic promotion — admitting them as a mentor here always creates a
  // plain "Mentor" row; any real leadership role still needs its own
  // separate approval (see approveLeadershipRole_) so a Lead can decide
  // per-cluster/zone rather than rubber-stamping whatever a first-time
  // applicant checked. What DOES happen here is the interest itself gets
  // carried over so it shows up in the Leadership Candidates queue right
  // away instead of being lost once the application is closed out.
  const leadershipRolesRaw = String(app.additionalRole || "").split(",").map(function(s) { return s.trim(); }).filter(Boolean);
  const leadershipRoles = leadershipRolesRaw.map(canonicalLeadershipRole_).filter(Boolean);
  const uniqueLeadershipRoles = leadershipRoles.filter(function(r, i) { return leadershipRoles.indexOf(r) === i; });

  const teamRow = TEAM_HEADERS.map(function(h) {
    if (h === "id") return newTeamId;
    if (h === "name") return app.name;
    if (h === "phone") return app.phone;
    if (h === "email") return app.email;
    if (h === "role") return "Mentor";
    if (h === "zone") return zoneLetter ? "Zone " + zoneLetter : "";
    if (h === "cluster") return cluster + (clusterRow ? " " + clusterRow.name : "");
    if (h === "status") return "Confirmed";
    if (h === "notes") return notes;
    if (h === "updatedAt") return now;
    if (h === "accessLevel") return "cluster";
    if (h === "pin") return pin;
    if (h === "mode") return app.mode || "In-person";
    if (h === "shifts") return app.shifts || "";
    if (h === "preferredContact") return app.preferredContact || "";
    if (h === "leadershipInterest") return uniqueLeadershipRoles.join(", ");
    if (h === "leadershipStatus") return uniqueLeadershipRoles.length ? "Pending" : "";
    if (h === "secondaryCluster") return secondaryClusterRow ? secondaryClusterId + " " + secondaryClusterRow.name : "";
    if (h === "secondaryClusterConfirmed") return "";
    return "";
  });
  teamSheet.appendRow(teamRow);

  const appSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MENTOR_APPLICATIONS_SHEET);
  const appRowNum = findRowById_(appSheet, MENTOR_APPLICATIONS_HEADERS, app.id);
  if (appRowNum !== -1) {
    const set = function(header, value) {
      appSheet.getRange(appRowNum, MENTOR_APPLICATIONS_HEADERS.indexOf(header) + 1).setValue(value);
    };
    set("status", "Approved");
    set("teamMemberId", newTeamId);
    set("reviewedBy", me.name);
    set("reviewedAt", now);
    if (body.reviewNotes) set("reviewNotes", body.reviewNotes);
  }

  logActivity_(me.name, "approve_mentor_application", app.id, "-> " + newTeamId + (autoAssignedFromPrimary ? " (auto 2nd-choice, " + autoAssignedFromPrimary + " was full)" : ""));

  // Keep the Mentor Database current — see upsertMentorDatabaseFromApplication_.
  // Best-effort: a problem here must never make approval itself look like it
  // failed, since the Team row and PIN have already been created above.
  try {
    upsertMentorDatabaseFromApplication_(app, newTeamId, cluster, clusterRow, me);
  } catch (err) { /* never block a successful approval on this */ }

  const emailSent = emailMentorApproval_(app, pin, clusterRow, autoAssignedFromPrimary);
  return { ok: true, teamMemberId: newTeamId, pin: pin, emailSent: emailSent, autoAssignedFromPrimary: autoAssignedFromPrimary };
}

// ---------------------------------------------------------------------
// BULK MENTOR IMPORT — Lead/Assistant Lead or Intern (enforced via
// canBulkImportMentors_ in doPost, checked explicitly rather than via
// ADMIN_ONLY since Interns are included here). For onboarding many mentors
// at once from a list compiled outside
// the app (e.g. WhatsApp/email responses) instead of each person filling in
// the individual public registration form one at a time. Unlike that normal
// flow, this SKIPS the Mentor Applications review queue — every valid row
// becomes a CONFIRMED Team member immediately (own PIN, cluster assignment),
// same end state as an admin approving that many individual applications
// back to back. A matching "Approved" Mentor Applications row is still
// written for each one, purely so that sheet stays a complete history of
// every mentor regardless of how they were added — there's nothing left to
// review there, it's already done.
//
// body.rows: [{ name, phone, email, cluster, mode, shifts, jobTitle,
//   organisation, profession, notes, clientId }]
//   - cluster: a cluster CODE ("A3") or its exact/partial NAME — resolved
//     against the Clusters sheet here (also pre-resolved client-side, but
//     never trusted from the client alone).
//   - mode/shifts: free text, normalized here the same way app.js does
//     (so this works whether rows came from the paste box or an .xlsx
//     upload, which may not follow the exact checkbox wording).
//   - clientId (optional): echoed back paired with the real server-assigned
//     Team id in `results`, same reconciliation pattern as
//     bulkRegisterStudents_.
//
// Rows missing a required field, or whose email already matches someone on
// the Team list, are skipped (reported in `errors`) — never partially
// created. PIN emails are sent best-effort per row (see emailMentorApproval_)
// and never block a row's Team record from being created; emailsSent/
// emailsFailed let the caller warn about Gmail's daily send quota on large
// batches.
function bulkRegisterMentors_(body, me) {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return { ok: false, error: "No rows to import." };

  const clusters = readSheet_(CLUSTERS_SHEET, CLUSTERS_HEADERS);
  const resolveCluster = function(text) {
    const raw = String(text || "").trim();
    if (!raw) return null;
    const upper = raw.toUpperCase();
    let c = clusters.find(function(x) { return x.id === upper; });
    if (c) return c;
    const lower = raw.toLowerCase();
    c = clusters.find(function(x) { return String(x.name || "").trim().toLowerCase() === lower; });
    if (c) return c;
    return clusters.find(function(x) { return String(x.name || "").toLowerCase().indexOf(lower) !== -1; }) || null;
  };
  const normalizeMode = function(text) {
    const s = String(text || "").toLowerCase();
    if (s.indexOf("virtual") !== -1 || s.indexOf("online") !== -1) return "Live virtual";
    if (s.indexOf("record") !== -1) return "Pre-recorded";
    return "In-person";
  };
  const normalizeShifts = function(text) {
    const s = String(text || "").toLowerCase();
    const morning = s.indexOf("morning") !== -1;
    const afternoon = s.indexOf("afternoon") !== -1;
    if (s.indexOf("both") !== -1 || s.indexOf("either") !== -1 || (morning && afternoon)) return "Either / both shifts";
    if (morning) return "Morning shift";
    if (afternoon) return "Afternoon shift";
    return "";
  };

  const teamSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TEAM_SHEET);
  const appSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MENTOR_APPLICATIONS_SHEET);
  const existingTeam = readSheet_(TEAM_SHEET, TEAM_HEADERS);
  const existingApps = readSheet_(MENTOR_APPLICATIONS_SHEET, MENTOR_APPLICATIONS_HEADERS);
  const teamEmails = existingTeam.map(function(r) { return String(r.email || "").trim().toLowerCase(); });

  const usedTeamIds = {};
  existingTeam.forEach(function(r) { usedTeamIds[r.id] = true; });
  let teamCounter = existingTeam.length + 1;
  const nextTeamId = function() {
    let id = "T" + String(teamCounter).padStart(3, "0");
    while (usedTeamIds[id]) { teamCounter++; id = "T" + String(teamCounter).padStart(3, "0"); }
    usedTeamIds[id] = true;
    teamCounter++;
    return id;
  };
  const usedAppIds = {};
  existingApps.forEach(function(r) { usedAppIds[r.id] = true; });
  let appCounter = existingApps.length + 1;
  const nextAppId = function() {
    let id = "MA" + String(appCounter).padStart(3, "0");
    while (usedAppIds[id]) { appCounter++; id = "MA" + String(appCounter).padStart(3, "0"); }
    usedAppIds[id] = true;
    appCounter++;
    return id;
  };

  let created = 0;
  let emailsSent = 0;
  let emailsFailed = 0;
  const errors = [];
  const results = [];
  const now = new Date().toISOString();

  rows.forEach(function(r) {
    const name = String(r.name || "").trim();
    const phone = String(r.phone || "").trim();
    const email = String(r.email || "").trim();
    if (!name) { errors.push("(unnamed row): name is required."); return; }
    if (!phone) { errors.push(name + ": phone is required."); return; }
    if (!isValidEmail_(email)) { errors.push(name + ": a valid email address is required."); return; }
    const clusterRow = resolveCluster(r.cluster);
    if (!clusterRow) { errors.push(name + ": couldn't match \"" + (r.cluster || "") + "\" to a real cluster — use a code like \"A3\" or the cluster's name."); return; }
    const shifts = normalizeShifts(r.shifts);
    if (!shifts) { errors.push(name + ": shift must mention Morning, Afternoon, or Both."); return; }
    const mode = normalizeMode(r.mode);

    if (teamEmails.indexOf(email.toLowerCase()) !== -1) {
      errors.push(name + " (" + email + "): already on the Team list — skipped to avoid a duplicate.");
      return;
    }

    const clusterId = clusterRow.id;
    const zoneLetter = clusterId.charAt(0);
    const pin = generatePin_();
    const newTeamId = nextTeamId();
    const newAppId = nextAppId();

    const noteParts = [];
    if (r.profession) noteParts.push(String(r.profession).trim());
    if (r.organisation) noteParts.push("at " + String(r.organisation).trim());
    const noteBase = noteParts.length ? noteParts.join(" ") + ". " : "";
    const notes = "Bulk-imported by " + (me.name || "admin") + ". " + noteBase + "Shifts: " + shifts + ". Mode: " + mode + "." + (r.notes ? " Note: " + String(r.notes).trim() : "");

    const teamRow = TEAM_HEADERS.map(function(h) {
      if (h === "id") return newTeamId;
      if (h === "name") return name;
      if (h === "phone") return phone;
      if (h === "email") return email;
      if (h === "role") return "Mentor";
      if (h === "zone") return "Zone " + zoneLetter;
      if (h === "cluster") return clusterId + " " + clusterRow.name;
      if (h === "status") return "Confirmed";
      if (h === "notes") return notes;
      if (h === "updatedAt") return now;
      if (h === "accessLevel") return "cluster";
      if (h === "pin") return pin;
      if (h === "mode") return mode;
      if (h === "shifts") return shifts;
      // Not collected by the bulk-import template today, but honored if a
      // future template or a hand-edited paste row includes it.
      if (h === "preferredContact") return r.preferredContact ? String(r.preferredContact).trim() : "";
      return "";
    });
    teamSheet.appendRow(teamRow);
    teamEmails.push(email.toLowerCase()); // guard against dupes within this same batch too

    const appRow = MENTOR_APPLICATIONS_HEADERS.map(function(h) {
      if (h === "id") return newAppId;
      if (h === "submittedAt") return now;
      if (h === "status") return "Approved";
      if (h === "name") return name;
      if (h === "phone") return phone;
      if (h === "email") return email;
      if (h === "primaryCluster") return clusterId;
      if (h === "shifts") return shifts;
      if (h === "mode") return mode;
      if (h === "jobTitle") return String(r.jobTitle || "").trim();
      if (h === "organisation") return String(r.organisation || "").trim();
      if (h === "profession") return String(r.profession || "").trim();
      if (h === "consent") return "Yes (recorded by staff via bulk import)";
      if (h === "notes") return "Bulk import." + (r.notes ? " " + String(r.notes).trim() : "");
      if (h === "teamMemberId") return newTeamId;
      if (h === "reviewedBy") return me.name;
      if (h === "reviewedAt") return now;
      return "";
    });
    appSheet.appendRow(appRow);

    const emailSent = emailMentorApproval_({ email: email, name: name, primaryCluster: clusterId }, pin, clusterRow);
    if (emailSent) emailsSent++; else emailsFailed++;

    try {
      upsertMentorDatabaseFromApplication_(
        { email: email, name: name, profession: r.profession || "", organisation: r.organisation || "", phone: phone, linkedinOrProfile: "" },
        newTeamId, clusterId, clusterRow, me
      );
    } catch (err) { /* never block a successful import on this */ }

    created++;
    results.push({ clientId: r.clientId || "", id: newTeamId });
  });

  logActivity_(me.name, "bulk_register_mentors", "", created + " / " + rows.length + " mentor(s) created");
  return { ok: true, created: created, total: rows.length, errors: errors, results: results, emailsSent: emailsSent, emailsFailed: emailsFailed };
}

// Lead/Assistant Lead only. Doesn't touch Team — the application simply
// never becomes one. reviewNotes is optional internal context (not emailed
// to the applicant automatically).
function rejectMentorApplication_(body, me) {
  const appSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MENTOR_APPLICATIONS_SHEET);
  const rowNum = findRowById_(appSheet, MENTOR_APPLICATIONS_HEADERS, body.id);
  if (rowNum === -1) return { ok: false, error: "Application not found." };
  const now = new Date().toISOString();
  const set = function(header, value) {
    appSheet.getRange(rowNum, MENTOR_APPLICATIONS_HEADERS.indexOf(header) + 1).setValue(value);
  };
  set("status", "Rejected");
  set("reviewedBy", me.name);
  set("reviewedAt", now);
  if (body.reviewNotes) set("reviewNotes", body.reviewNotes);
  logActivity_(me.name, "reject_mentor_application", body.id, body.reviewNotes || "");
  return { ok: true };
}

// Any signed-in person may submit/update their OWN Mentor Feedback Survey
// response — identity comes from the verified token (me), never a
// teamMemberId passed in the body, so there's no way to submit as/overwrite
// someone else. Submitting again (e.g. to fix a typo) UPDATES the existing
// row rather than creating a duplicate — one row per person is what makes
// the admin's "who hasn't responded yet" view a simple diff against Team.
function submitMentorSurvey_(body, me) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MENTOR_SURVEY_SHEET);
  const existing = readSheet_(MENTOR_SURVEY_SHEET, MENTOR_SURVEY_HEADERS);
  const prior = existing.find(function(r) { return r.teamMemberId === me.id; });
  const now = new Date().toISOString();

  const valueFor = function(h) {
    if (h === "submittedAt") return now;
    if (h === "teamMemberId") return me.id;
    if (h === "name") return me.name;
    if (h === "cluster") return me.cluster || "";
    if (h === "id") return prior ? prior.id : "";
    if (body[h] !== undefined) return body[h];
    return "";
  };

  if (prior) {
    const rowNum = findRowById_(sheet, MENTOR_SURVEY_HEADERS, prior.id);
    if (rowNum !== -1) {
      const row = MENTOR_SURVEY_HEADERS.map(valueFor);
      sheet.getRange(rowNum, 1, 1, row.length).setValues([row]);
      logActivity_(me.name, "submit_mentor_survey", prior.id, "updated");
      return { ok: true, id: prior.id, updated: true };
    }
  }

  const ids = existing.map(function(r) { return r.id; });
  let n = ids.length + 1;
  let newId = "MS" + String(n).padStart(3, "0");
  while (ids.indexOf(newId) !== -1) { n++; newId = "MS" + String(n).padStart(3, "0"); }
  const row = MENTOR_SURVEY_HEADERS.map(function(h) { return h === "id" ? newId : valueFor(h); });
  sheet.appendRow(row);
  logActivity_(me.name, "submit_mentor_survey", newId, "new");
  return { ok: true, id: newId, updated: false };
}

// ---------------------------------------------------------------------
// CLUSTER-FIT MATCHING — heuristic keyword matcher (always works, no
// external dependency) + OPTIONAL Gemini AI call for a richer natural-
// language strengths summary. Used two ways: (1) automatically, at mentor
// application submission, to suggest an alternate/matching cluster in case
// that person is needed outside their chosen cluster (see
// publicRegisterMentor_ below calling suggestClusterFit_ directly); and (2)
// on demand, from the Mentor Database admin view, via the suggest_mentor_fit
// action (suggestMentorFit_), which also calls Gemini if a key is
// configured. Keyword lists are drawn from the Society's own 2023 Career Day
// sub-cluster reference document, mapped onto the CURRENT 23-cluster
// structure (SEED_CLUSTERS above) — not guessed from scratch.
// ---------------------------------------------------------------------
const CLUSTER_KEYWORDS_ = {
  A1: ["physician","doctor","dr.","medic","medical","dentist","dental","nurse","nursing","physiotherapist","pharmacist","pharmacy","surgeon","surgery","paediatric","pediatric","obstetric","gynaecolog","gynecolog","radiolog","anaesthe","anesthe","clinical officer","veterinar","hospital"],
  A2: ["public health","psycholog","mental health","counsellor","counselor","social work","epidemiolog","community health","therapist","psychiatr","wellbeing","well-being","wellness"],
  A3: ["sport","coach","fitness","athlete","physical education","rugby","football","referee","gym instructor","personal trainer","sports management","sports marketing"],
  B1: ["software","developer","programmer","data scientist","data analyst","information technology","cyber security","cybersecurity","machine learning","artificial intelligence"," ai ","computer science","systems engineer","network engineer","database","informatics","it manager","tech lead","geomatics"],
  B2: ["mechanical engineer","electrical engineer","industrial design","manufacturing","mechatronics","production engineer","quality assurance engineer","civil engineer","structural engineer","engineer"],
  B3: ["geolog","geoscience","mining","energy sector","petroleum","oil and gas","renewable energy","solar","environmental science","earth science","sustainable energy"],
  B4: ["environment","conservation","wildlife","climate change","sustainability","ecology","natural resource","forestry","waste management","environmentalist"],
  B5: ["agriculture","agribusiness","agronomist","farm","food scien","veterinary","agri-business","agro"],
  B6: ["pilot","aviation","airline","aerospace","air traffic","cabin crew","cabin attendant","maritime","shipping","marine engineer","flight","commercial pilot"],
  C1: ["finance","accountant","accounting","banker","banking","actuary","actuarial","audit","investment","insurance","financial analyst","treasury","tax consultant","relationship manager","reconciliation"],
  C2: ["entrepreneur","founder","co-founder","ceo","startup","business owner","innovation","small business","incubator","managing director"],
  C3: ["human resources"," hr ","talent acquisition","strategy consult","strategic management","organisational development","organizational development","executive director","chief operating officer","administration director","leadership","corporate management"],
  C4: ["supply chain","logistics","procurement","warehousing","distribution manager","freight"],
  C5: ["marketing","public relations"," pr ","communications manager","sales","brand manager","advertising","customer experience"," cx ","social media manager"],
  D1: ["advocate","lawyer","legal","attorney","judge","judiciary","counsel","notary","paralegal","magistrate","law firm"],
  D2: ["diplomat","ngo","policy advisor","governance","international relations","development sector","united nations"," un ","foreign affairs","humanitarian","civic education","conference interpreter"],
  D3: ["police","military","army","navy","security services","defence","defense","intelligence officer","prison","road safety","national security"],
  D4: ["pastor","reverend","theology","chaplain","ministry","clergy","spiritual","priest","pastoral"],
  D5: ["teacher","lecturer","professor","school principal","tutor","education sector","academic","faculty member","curriculum"],
  E1: ["journalist","media house","broadcaster","reporter","editor","blogger","podcast","radio presenter","tv presenter","news anchor"],
  E2: ["hotel","hospitality","tourism","chef","event management","event planning","travel consultant","restaurant","sommelier","oenologist","catering","housekeeping"],
  E3: ["fashion design","graphic design","artist","photograph","musician","dance","drama","film","videograph","creative director","cosmetolog","salon owner","stylist","dj ","styling","model","director","producer","cinematograph","editor","animat","music produc","sound produc","songwrit","composer","conduct","choir","orchestra","voice actor","voiceover","stage manag","theatre","artist management","record label","a&r"],
  E4: ["architect","quantity surveyor","real estate","construction","urban planning","landscape architect","property management","built environment"],
};

// Returns up to `limit` {clusterId, clusterName, score} entries, highest
// score first, for whatever free text (profession/designation/bio/LinkedIn
// blurb) is passed in. Pure substring keyword counting — deterministic, no
// external call, always available even with zero configuration.
function suggestClusterFit_(text, limit) {
  const t = " " + String(text || "").toLowerCase() + " ";
  const scores = [];
  Object.keys(CLUSTER_KEYWORDS_).forEach(function(cid) {
    let score = 0;
    CLUSTER_KEYWORDS_[cid].forEach(function(kw) { if (t.indexOf(kw) !== -1) score++; });
    if (score > 0) scores.push({ clusterId: cid, score: score });
  });
  scores.sort(function(a, b) { return b.score - a.score; });
  const clusters = readSheet_(CLUSTERS_SHEET, CLUSTERS_HEADERS);
  const nameOf = function(cid) { const c = clusters.find(function(x) { return x.id === cid; }); return c ? c.name : cid; };
  return scores.slice(0, limit || 3).map(function(s) {
    return { clusterId: s.clusterId, clusterName: nameOf(s.clusterId), score: s.score };
  });
}

// OPTIONAL — only runs if a Gemini API key has been set in this Apps Script
// project's Script Properties (Project Settings -> Script Properties ->
// GEMINI_API_KEY). Get a free key from https://aistudio.google.com/apikey.
// Without a key, callers fall back to a heuristic-only summary — nothing
// breaks, it's just less rich. Wrapped in try/catch: any failure (bad key,
// quota, network) is swallowed and the caller falls back, same as
// emailMentorApproval_'s best-effort pattern.
function aiStrengthsSummaryViaGemini_(name, profession, bio, linkedinOrProfile, heuristicFits) {
  const apiKey = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!apiKey) return null;
  try {
    const clusters = readSheet_(CLUSTERS_SHEET, CLUSTERS_HEADERS);
    const clusterList = clusters.map(function(c) { return c.id + " " + c.name; }).join("; ");
    const fitList = (heuristicFits || []).map(function(f) { return f.clusterName; }).join(", ");
    const prompt =
      "You are helping a school alumnae mentorship programme (KHS Alumnae Society Boma Career Day) " +
      "match a volunteer mentor to the career cluster(s) where they can add the most value, including " +
      "clusters outside their own first choice if their background fits. The programme's current 23 " +
      "clusters are: " + clusterList + ".\n\n" +
      "Mentor name: " + (name || "unknown") + "\n" +
      "Stated profession/designation: " + (profession || "not given") + "\n" +
      "Bio/background: " + (bio || "not given") + "\n" +
      "Voluntarily shared LinkedIn/profile info: " + (linkedinOrProfile || "not given") + "\n" +
      "Keyword-based cluster suggestions: " + (fitList || "none found") + "\n\n" +
      "In 2-3 short sentences, summarise this mentor's professional strengths and which cluster(s) " +
      "(name them) they would be a strong fit for — including a plausible SECOND cluster if their " +
      "background genuinely supports one, for resource-allocation purposes. Be concrete and concise. " +
      "Do not invent facts not implied by the input.";
    const resp = UrlFetchApp.fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + apiKey,
      {
        method: "post",
        contentType: "application/json",
        muteHttpExceptions: true,
        payload: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );
    const json = JSON.parse(resp.getContentText());
    const out = json && json.candidates && json.candidates[0] && json.candidates[0].content &&
      json.candidates[0].content.parts && json.candidates[0].content.parts[0] &&
      json.candidates[0].content.parts[0].text;
    return out ? String(out).trim() : null;
  } catch (err) {
    return null;
  }
}

// doPost handler for suggest_mentor_fit. body: { text } (free text to match)
// OR { mentorDbId } / { applicationId } (looks up that row's profession/bio/
// LinkedIn and, once computed, WRITES the result back onto that row's
// aiStrengthsSummary — and suggestedClusterId/suggestedClusterName for
// applications — so it only has to be run once per person, not every time
// someone views them).
function suggestMentorFit_(body) {
  let text = body.text || "";
  let targetSheet = null, targetHeaders = null, targetId = null, name = "", profession = "", bio = "", linkedin = "";

  if (body.mentorDbId) {
    const rows = readSheet_(MENTOR_DATABASE_SHEET, MENTOR_DATABASE_HEADERS);
    const row = rows.find(function(r) { return r.id === body.mentorDbId; });
    if (!row) return { ok: false, error: "Mentor Database entry not found: " + body.mentorDbId };
    targetSheet = MENTOR_DATABASE_SHEET; targetHeaders = MENTOR_DATABASE_HEADERS; targetId = body.mentorDbId;
    name = row.name; profession = row.profession || row.designation; bio = row.notes; linkedin = row.linkedinOrProfile;
    text = [profession, bio, linkedin].filter(Boolean).join(". ");
  } else if (body.applicationId) {
    const rows = readSheet_(MENTOR_APPLICATIONS_SHEET, MENTOR_APPLICATIONS_HEADERS);
    const row = rows.find(function(r) { return r.id === body.applicationId; });
    if (!row) return { ok: false, error: "Mentor application not found: " + body.applicationId };
    targetSheet = MENTOR_APPLICATIONS_SHEET; targetHeaders = MENTOR_APPLICATIONS_HEADERS; targetId = body.applicationId;
    name = row.name; profession = [row.jobTitle, row.profession, row.organisation].filter(Boolean).join(", "); bio = row.bio; linkedin = row.linkedinOrProfile;
    text = [profession, bio, linkedin].filter(Boolean).join(". ");
  }

  const heuristic = suggestClusterFit_(text, 3);
  const aiSummary = aiStrengthsSummaryViaGemini_(name, profession, bio, linkedin, heuristic);
  const summary = aiSummary || (heuristic.length
    ? "Heuristic match (no Gemini API key configured): background suggests strongest fit with " +
      heuristic.map(function(h) { return h.clusterName; }).join(", ") + ". Add a GEMINI_API_KEY in " +
      "Script Properties for a richer AI-generated summary."
    : "No clear cluster match found from the text given.");

  if (targetSheet && targetId) {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(targetSheet);
    const rowNum = findRowById_(sheet, targetHeaders, targetId);
    if (rowNum !== -1) {
      if (targetHeaders.indexOf("aiStrengthsSummary") !== -1) {
        sheet.getRange(rowNum, targetHeaders.indexOf("aiStrengthsSummary") + 1).setValue(summary);
      }
      if (targetHeaders.indexOf("suggestedClusterId") !== -1 && heuristic[0]) {
        sheet.getRange(rowNum, targetHeaders.indexOf("suggestedClusterId") + 1).setValue(heuristic[0].clusterId);
        sheet.getRange(rowNum, targetHeaders.indexOf("suggestedClusterName") + 1).setValue(heuristic[0].clusterName);
      }
    }
  }

  return { ok: true, heuristicFits: heuristic, aiStrengthsSummary: summary, usedGemini: !!aiSummary };
}

function addMentorDatabaseEntry_(body, me) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MENTOR_DATABASE_SHEET);
  const existing = readSheet_(MENTOR_DATABASE_SHEET, MENTOR_DATABASE_HEADERS);
  const ids = existing.map(function(r) { return r.id; });
  let n = ids.length + 1;
  let newId = "MD" + String(n).padStart(3, "0");
  while (ids.indexOf(newId) !== -1) { n++; newId = "MD" + String(n).padStart(3, "0"); }
  const row = MENTOR_DATABASE_HEADERS.map(function(h) {
    if (h === "id") return newId;
    if (h === "addedAt") return new Date().toISOString();
    if (h === "outreachStatus" && !body.outreachStatus) return "Not yet contacted (2026)";
    return body[h] !== undefined ? body[h] : "";
  });
  sheet.appendRow(row);
  logActivity_(me.name, "add_mentor_database_entry", newId, body.name || "");
  return { ok: true, id: newId };
}

// Only outreachStatus/outreachNotes/linkedinOrProfile/aiStrengthsSummary are
// meant to be edited from the app day-to-day (see the comment on
// MENTOR_DATABASE_HEADERS) — but this accepts any field on the row so a
// Lead/Assistant Lead can also correct a stale phone/email/name from the
// admin view without having to open the Sheet directly.
function updateMentorDatabaseEntry_(body, me) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MENTOR_DATABASE_SHEET);
  const rowNum = findRowById_(sheet, MENTOR_DATABASE_HEADERS, body.id);
  if (rowNum === -1) return { ok: false, error: "Mentor Database entry not found: " + body.id };
  MENTOR_DATABASE_HEADERS.forEach(function(h) {
    if (h === "id") return;
    if (body[h] !== undefined) sheet.getRange(rowNum, MENTOR_DATABASE_HEADERS.indexOf(h) + 1).setValue(body[h]);
  });
  logActivity_(me.name, "update_mentor_database_entry", body.id, body.outreachStatus || "");
  return { ok: true };
}

// Called automatically when a mentor application is approved (see
// approveMentorApplication_) — keeps the Mentor Database current every year
// without manual work, per WG2's request that the database "grow" as this
// year's mentors sign up rather than staying a frozen 2017-2023 snapshot.
// Matches an existing entry by email, or by name (same normalisation used
// when this database was first compiled — honorifics/parentheticals
// stripped, case-insensitive), so someone who mentored in a past year and
// signs up again for 2026 gets MERGED into their existing record — their
// history is preserved, not duplicated. A person not already on file gets a
// brand new row. Wrapped in try/catch by the caller: this must never block
// an approval that has already succeeded, same as emailMentorApproval_.
function upsertMentorDatabaseFromApplication_(app, teamId, clusterId, clusterRow, me) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(MENTOR_DATABASE_SHEET);
  const existing = readSheet_(MENTOR_DATABASE_SHEET, MENTOR_DATABASE_HEADERS);
  const normName = function(n) {
    return String(n || "").replace(/^(Dr\.?|Prof\.?|Eng\.?|Capt\.?|Cpt\.?|Rev\.?|Hon\.?)\s*/i, "")
      .replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  };
  const appEmail = String(app.email || "").trim().toLowerCase();
  const match = existing.find(function(m) {
    if (appEmail && String(m.email || "").trim().toLowerCase() === appEmail) return true;
    return normName(m.name) === normName(app.name);
  });

  const clusterName = clusterRow ? clusterRow.name : clusterId;
  const now = new Date().toISOString();

  if (match) {
    const rowNum = findRowById_(sheet, MENTOR_DATABASE_HEADERS, match.id);
    if (rowNum === -1) return;
    const set = function(h, v) { sheet.getRange(rowNum, MENTOR_DATABASE_HEADERS.indexOf(h) + 1).setValue(v); };

    const years = new Set(String(match.yearsInvolved || "").split(",").filter(Boolean));
    years.add("2026");
    set("yearsInvolved", Array.from(years).sort().join(","));

    const sources = new Set(String(match.source || "").split(",").map(function(s) { return s.trim(); }).filter(Boolean));
    sources.add("2026 registration");
    set("source", Array.from(sources).join(", "));

    // This year's cluster becomes the primary (freshest, most actionable);
    // whatever was primary before (if different) moves into "other possible
    // fit" so the multi-year history isn't lost, just reordered.
    if (clusterId && clusterId !== match.primaryClusterId) {
      const secIds = new Set(String(match.secondaryClusterIds || "").split(",").filter(Boolean));
      const secNames = new Set(String(match.secondaryClusterNames || "").split(",").map(function(s) { return s.trim(); }).filter(Boolean));
      if (match.primaryClusterId) { secIds.add(match.primaryClusterId); secNames.add(match.primaryClusterName); }
      secIds.delete(clusterId); secNames.delete(clusterName);
      set("primaryClusterId", clusterId);
      set("primaryClusterName", clusterName);
      set("secondaryClusterIds", Array.from(secIds).join(","));
      set("secondaryClusterNames", Array.from(secNames).join(", "));
    }

    // Only fills gaps — never overwrites a value the record already has, in
    // case it was hand-corrected by an admin.
    if (!match.phone && app.phone) set("phone", app.phone);
    if (!match.email && app.email) set("email", app.email);
    if (!match.organisation && app.organisation) set("organisation", app.organisation);
    if (!match.designation && app.jobTitle) set("designation", app.jobTitle);
    if (!match.profession && app.profession) set("profession", app.profession);
    if (!match.linkedinOrProfile && app.linkedinOrProfile) set("linkedinOrProfile", app.linkedinOrProfile);

    set("outreachStatus", "Confirmed for 2026");
    const noteAdd = "Re-registered for 2026 (application " + app.id + ", Team " + teamId + ").";
    set("outreachNotes", (match.outreachNotes ? match.outreachNotes + " " : "") + noteAdd);

    logActivity_(me.name, "mentor_database_auto_merge", match.id, "merged with 2026 application " + app.id);
    return;
  }

  // No match — a mentor not previously on file. Create a fresh row.
  const ids = existing.map(function(r) { return r.id; });
  let n = ids.length + 1;
  let newId = "MD" + String(n).padStart(3, "0");
  while (ids.indexOf(newId) !== -1) { n++; newId = "MD" + String(n).padStart(3, "0"); }
  const row = MENTOR_DATABASE_HEADERS.map(function(h) {
    if (h === "id") return newId;
    if (h === "name") return app.name;
    if (h === "organisation") return app.organisation || "";
    if (h === "designation") return app.jobTitle || "";
    if (h === "profession") return app.profession || "";
    if (h === "primaryClusterId") return clusterId;
    if (h === "primaryClusterName") return clusterName;
    if (h === "yearsInvolved") return "2026";
    if (h === "phone") return app.phone || "";
    if (h === "email") return app.email || "";
    if (h === "location") return "Local";
    if (h === "linkedinOrProfile") return app.linkedinOrProfile || "";
    if (h === "source") return "2026 registration";
    if (h === "outreachStatus") return "Confirmed for 2026";
    if (h === "outreachNotes") return "New 2026 mentor (application " + app.id + ", Team " + teamId + ").";
    if (h === "addedAt") return now;
    return "";
  });
  sheet.appendRow(row);
  logActivity_(me.name, "mentor_database_auto_add", newId, app.name || "");
}

// Best-effort, same pattern as emailPinIfPossible_ — approval has already
// succeeded by the time this runs, so a bad address or Gmail quota hiccup
// here must never look like the approval itself failed.
function emailMentorApproval_(app, pin, clusterRow, autoAssignedFromPrimary) {
  const to = String(app.email || "").trim();
  if (!isValidEmail_(to)) return false;
  const clusterLabel = clusterRow ? clusterRow.id + " — " + clusterRow.name : app.primaryCluster;
  // autoAssignedFromPrimary is the cluster ID they originally asked for
  // ("" if none) — set by approveMentorApplication_ when their 1st choice
  // was already full for their shift(s) and they were placed in their 2nd
  // choice instead. Says so plainly, since a mentor expecting cluster A but
  // landing in cluster B deserves an honest, upfront reason why.
  const autoNote = autoAssignedFromPrimary
    ? "\nA quick heads-up: your first-choice cluster (" + autoAssignedFromPrimary + ") had already reached its mentor capacity for your available shift(s), so we've placed you in your second-choice cluster instead. If that doesn't work for you, just reply to this email or reach out on WhatsApp and we'll sort it out.\n"
    : "";
  const autoNoteHtml = autoAssignedFromPrimary
    ? "<p>A quick heads-up: your first-choice cluster (" + escapeHtml_(autoAssignedFromPrimary) + ") had already reached its mentor capacity for your available shift(s), so we've placed you in your second-choice cluster instead. If that doesn't work for you, just reply to this email or reach out on WhatsApp and we'll sort it out.</p>"
    : "";
  try {
    const plainBody =
      "Hi " + (app.name || "") + ",\n\n" +
      "Asante — you're confirmed as a mentor for Boma Career Day 2026, Saturday 29 August at Kenya High School.\n\n" +
      "Your cluster: " + clusterLabel + "\n" +
      autoNote + "\n" +
      "Here's how to sign in to the BOMA Career Day - CMP Mentors Hub app to see your schedule and details:\n\n" +
      "Name: " + (app.name || "") + "\n" +
      "PIN: " + pin + "\n\n" +
      "Sign in here: " + APP_URL + "\n" +
      "Change your PIN any time after signing in: " + APP_URL + "?intent=changepin\n\n" +
      "A briefing pack and final logistics will follow ahead of the day. Thank you again for volunteering your time and expertise.\n\n" +
      SENDER_NAME;
    const htmlBody =
      "<p>Hi " + escapeHtml_(app.name || "") + ",</p>" +
      "<p>Asante — you're confirmed as a mentor for Boma Career Day 2026, Saturday 29 August at Kenya High School.</p>" +
      "<p>Your cluster: <b>" + escapeHtml_(clusterLabel) + "</b></p>" +
      autoNoteHtml +
      "<p>Name: <b>" + escapeHtml_(app.name || "") + "</b><br>PIN: <b>" + escapeHtml_(pin) + "</b></p>" +
      pinEmailButtonsHtml_() +
      "<p>You can change this PIN any time after signing in — tap your name at the top of the app, or use the button above.</p>" +
      "<p>A briefing pack and final logistics will follow ahead of the day. Thank you again for volunteering your time and expertise.</p>" +
      "<p>" + escapeHtml_(SENDER_NAME) + "</p>";
    MailApp.sendEmail({
      to: to,
      subject: "You're confirmed as a Boma Career Day 2026 Mentor!",
      body: plainBody,
      htmlBody: htmlBody,
      name: SENDER_NAME,
      from: SENDER_EMAIL,
    });
    return true;
  } catch (err) {
    return false;
  }
}

// ---------------------------------------------------------------------
// LEADERSHIP ROLES — Cluster Lead / Sub-Lead / Zone Coordinator. Interest
// reaches this "information bank" from two directions: (1) a new mentor
// application's "additional role" checkboxes, carried over automatically
// on admission (see approveMentorApplication_ above), and (2) an already-
// confirmed Mentor/Cluster Lead/Sub-Lead raising their own hand later via
// requestLeadershipRole_. Both land in the same place — leadershipStatus
// "Pending" on their Team row — so a Lead/Assistant Lead reviews one single
// queue regardless of where the interest came from.
// ---------------------------------------------------------------------

// Self-service — see requestLeadershipRole_ dispatch in doPost. Always
// scoped to the caller's own row (me.id from the verified token, never
// body.id), same pattern as updateMyDetails_/changeOwnPin_. body.roles:
// array of any of "Cluster Lead" / "Sub-Lead" / "Zone Coordinator" (loosely
// matched via canonicalLeadershipRole_, so the exact casing/wording from
// the client doesn't matter). Passing an empty array withdraws a
// still-Pending request — the app.js UI only offers that while status is
// Pending, never after a Lead has already Approved/Declined it.
function requestLeadershipRole_(body, me) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TEAM_SHEET);
  const rowNum = findRowById_(sheet, TEAM_HEADERS, me.id);
  if (rowNum === -1) return { ok: false, error: "Couldn't find your record." };
  const raw = Array.isArray(body.roles) ? body.roles : [];
  const roles = raw.map(canonicalLeadershipRole_).filter(Boolean);
  const unique = roles.filter(function(r, i) { return roles.indexOf(r) === i; });
  const set = function(header, value) { sheet.getRange(rowNum, TEAM_HEADERS.indexOf(header) + 1).setValue(value); };
  set("leadershipInterest", unique.join(", "));
  set("leadershipStatus", unique.length ? "Pending" : "");
  set("updatedAt", new Date().toISOString());
  logActivity_(me.name, "request_leadership_role", me.id, unique.join(", ") || "(withdrawn)");
  return { ok: true, leadershipInterest: unique.join(", "), leadershipStatus: unique.length ? "Pending" : "" };
}

// Lead/Assistant Lead only (enforced via ADMIN_ONLY in doPost). Promotes a
// team member into a real leadership role — their Team `role` becomes the
// approved title, which is what makes it show up everywhere role is
// already displayed (Team list, Cluster Command Center mentor rows, and —
// for Zone Coordinator specifically — the Staff Directory, since that role
// is already in its DIRECTORY_ROLES allowlist). Zone Coordinator also gets
// bumped to "zone" accessLevel so they actually see the exec Dashboard;
// Cluster Lead/Sub-Lead keep whatever accessLevel they already had, same as
// when a Lead adds one manually via Team Access.
//   body.role   — "Cluster Lead" / "Sub-Lead" / "Zone Coordinator" (required)
//   body.zone   — for Zone Coordinator only: a zone letter or "Zone X"
//                 (optional — defaults to whatever zone is already on their
//                 Team row if omitted). This is the "I should be able to
//                 assign" step: it actually SETS which zone they now lead,
//                 not just their role/title — previously this action left
//                 zone/cluster untouched, so approving someone as "Zone
//                 Coordinator" didn't say which zone.
//   body.clusterId — for Cluster Lead/Sub-Lead only: a cluster id like "A1"
//                 (optional — same default-to-current-cluster behavior).
function approveLeadershipRole_(body, me) {
  const role = canonicalLeadershipRole_(body.role);
  if (!role) return { ok: false, error: "Choose Cluster Lead, Sub-Lead, or Zone Coordinator." };
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TEAM_SHEET);
  const rowNum = findRowById_(sheet, TEAM_HEADERS, body.id);
  if (rowNum === -1) return { ok: false, error: "Team member not found." };
  const target = readSheet_(TEAM_SHEET, TEAM_HEADERS).find(function(r) { return r.id === body.id; });
  if (!target) return { ok: false, error: "Team member not found." };

  const set = function(header, value) { sheet.getRange(rowNum, TEAM_HEADERS.indexOf(header) + 1).setValue(value); target[header] = value; };
  set("role", role);
  set("leadershipStatus", "Approved");
  set("updatedAt", new Date().toISOString());
  if (role === "Zone Coordinator") {
    if (target.accessLevel !== "all") set("accessLevel", "zone");
    const zoneLetter = zoneLetterOf_(body.zone || target.zone);
    if (zoneLetter) set("zone", "Zone " + zoneLetter);
  } else {
    const clusterId = String(body.clusterId || "").trim().toUpperCase();
    if (clusterId) {
      const clusterRow = readSheet_(CLUSTERS_SHEET, CLUSTERS_HEADERS).find(function(c) { return c.id === clusterId; });
      if (clusterRow) {
        set("cluster", clusterId + " " + clusterRow.name);
        set("zone", "Zone " + clusterId.charAt(0));
      }
    }
  }
  const reviewerRemark = String(body.reviewNotes || "").trim();
  if (reviewerRemark) {
    const priorNotes = String(target.notes || "").trim();
    set("notes", (priorNotes ? priorNotes + " " : "") + "Leadership approval note: " + reviewerRemark);
  }
  logActivity_(me.name, "approve_leadership_role", body.id, role + (body.zone ? " (" + body.zone + ")" : "") + (body.clusterId ? " (" + body.clusterId + ")" : ""));
  const emailSent = emailLeadershipApproval_(target, role);
  return { ok: true, role: role, zone: target.zone, cluster: target.cluster, emailSent: emailSent };
}

// Emails a Coordination Brief the client already built (see
// buildCoordinationBrief_ in app.js) — who's registered, what rounds
// they've signed up for, and what still needs filling, for one zone or
// cluster. Self-service: a signed-in person may only send it to their OWN
// email on file. Ops tier (Lead/Assistant Lead/Zone Coordinator/Intern —
// same tier as update_cluster_room) may send it to anyone, e.g. re-sending
// a fresh copy to a Zone Coordinator or Cluster Lead.
//   body.to      — recipient email (required)
//   body.subject — email subject (required)
//   body.message — plain-text email body (required)
function sendCoordinationBrief_(body, me) {
  const to = String(body.to || "").trim();
  if (!isValidEmail_(to)) return { ok: false, error: "Enter a valid email address." };
  const isOpsTier = me.accessLevel === "all" || me.accessLevel === "zone" || me.accessLevel === "intern";
  if (!isOpsTier && to.toLowerCase() !== String(me.email || "").trim().toLowerCase()) {
    return { ok: false, error: "You can only email this brief to yourself. Ask a Lead, Assistant Lead, Zone Coordinator, or Intern to send it to someone else." };
  }
  const subject = String(body.subject || "Coordination Brief — Boma Career Day 2026").trim();
  const message = String(body.message || "").trim();
  if (!message) return { ok: false, error: "Nothing to send." };
  try {
    MailApp.sendEmail({ to: to, subject: subject, body: message, name: SENDER_NAME, from: SENDER_EMAIL });
  } catch (err) {
    return { ok: false, error: "Couldn't send: " + String(err) };
  }
  logActivity_(me.name, "send_coordination_brief", to, subject);
  return { ok: true };
}

// ---------------------------------------------------------------------
// POLLS — see POLLS_HEADERS/POLL_VOTES_HEADERS for the data model.
// ---------------------------------------------------------------------
function nextPollId_(existing) {
  let maxN = 0;
  existing.forEach(function(r) {
    if (r.id && String(r.id).indexOf("PL") === 0) {
      const n = parseInt(String(r.id).slice(2), 10);
      if (!isNaN(n) && n > maxN) maxN = n;
    }
  });
  return "PL" + String(maxN + 1).padStart(4, "0");
}

// Ops tier only (enforced in doPost). body.options: array of option text
// (2-8 items after trimming blanks). body.audienceLabel is free text shown
// on the card (e.g. "Mentors", "Zone B") — informational only, it does NOT
// restrict who can vote.
function createPoll_(body, me) {
  const question = String(body.question || "").trim();
  const options = (Array.isArray(body.options) ? body.options : [])
    .map(function(o) { return String(o || "").trim(); })
    .filter(Boolean);
  if (!question) return { ok: false, error: "Enter a question." };
  if (options.length < 2) return { ok: false, error: "Add at least 2 options." };
  if (options.length > 8) return { ok: false, error: "Up to 8 options." };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(POLLS_SHEET);
  const existing = readSheet_(POLLS_SHEET, POLLS_HEADERS);
  const id = nextPollId_(existing);
  const now = new Date().toISOString();
  sheet.appendRow([
    id, question, JSON.stringify(options), body.allowMultiple ? "Yes" : "No",
    String(body.audienceLabel || "").trim(), me.name, me.id, now,
    String(body.closesAt || "").trim(), "Open",
  ]);
  logActivity_(me.name, "create_poll", id, question);
  return { ok: true, id: id };
}

// Self-service — any signed-in person may vote (or change their vote) on
// any OPEN poll. Re-voting overwrites their existing row for this poll
// (found by pollId+voterId) rather than adding a second one, so a tally
// never double-counts someone who changed their mind.
function votePoll_(body, me) {
  const polls = readSheet_(POLLS_SHEET, POLLS_HEADERS);
  const poll = polls.find(function(p) { return p.id === body.pollId; });
  if (!poll) return { ok: false, error: "Poll not found." };
  if (poll.status === "Closed") return { ok: false, error: "This poll is closed." };
  const options = JSON.parse(poll.options || "[]");
  const raw = Array.isArray(body.optionIndexes) ? body.optionIndexes : [];
  const parsed = raw.map(function(n) { return parseInt(n, 10); }).filter(function(n) { return !isNaN(n) && n >= 0 && n < options.length; });
  const unique = parsed.filter(function(n, i) { return parsed.indexOf(n) === i; });
  if (!unique.length) return { ok: false, error: "Pick at least one option." };
  if (poll.allowMultiple !== "Yes" && unique.length > 1) return { ok: false, error: "This poll only allows one choice." };

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(POLL_VOTES_SHEET);
  const existingVotes = readSheet_(POLL_VOTES_SHEET, POLL_VOTES_HEADERS);
  const now = new Date().toISOString();
  const myExisting = existingVotes.find(function(v) { return v.pollId === body.pollId && v.voterId === me.id; });
  if (myExisting) {
    const rowNum = findRowById_(sheet, POLL_VOTES_HEADERS, myExisting.id);
    if (rowNum !== -1) {
      sheet.getRange(rowNum, POLL_VOTES_HEADERS.indexOf("optionIndexes") + 1).setValue(unique.join(","));
      sheet.getRange(rowNum, POLL_VOTES_HEADERS.indexOf("timestamp") + 1).setValue(now);
    }
  } else {
    const ids = existingVotes.map(function(v) { return v.id; });
    let n = ids.length + 1;
    let newId = "PV" + String(n).padStart(5, "0");
    while (ids.indexOf(newId) !== -1) { n++; newId = "PV" + String(n).padStart(5, "0"); }
    sheet.appendRow([newId, body.pollId, me.id, me.name, unique.join(","), now]);
  }
  logActivity_(me.name, "vote_poll", body.pollId, unique.join(","));
  return { ok: true };
}

// The poll's own creator, or ops tier (Lead/Assistant Lead/Zone
// Coordinator/Intern), may close it. Closing only stops new votes — every
// response already cast stays on record.
function closePoll_(body, me) {
  const polls = readSheet_(POLLS_SHEET, POLLS_HEADERS);
  const poll = polls.find(function(p) { return p.id === body.id; });
  if (!poll) return { ok: false, error: "Poll not found." };
  const isOpsTier = me.accessLevel === "all" || me.accessLevel === "zone" || me.accessLevel === "intern";
  if (poll.createdById !== me.id && !isOpsTier) {
    return { ok: false, error: "Only the poll's creator, a Lead, Assistant Lead, Zone Coordinator, or Intern can close it." };
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(POLLS_SHEET);
  const rowNum = findRowById_(sheet, POLLS_HEADERS, body.id);
  if (rowNum === -1) return { ok: false, error: "Poll not found." };
  sheet.getRange(rowNum, POLLS_HEADERS.indexOf("status") + 1).setValue("Closed");
  logActivity_(me.name, "close_poll", body.id, "");
  return { ok: true };
}

// ---------------------------------------------------------------------
// EMAILABLE POLLS — one-tap vote links that work straight from the email,
// no sign-in needed, alongside the existing in-app voting above. Same
// signed-token idea as makeToken_/verifyToken_ (HMAC with SESSION_SECRET),
// just signing (pollId, teamId, optionIndex) instead of (memberId, pin) so
// a link can't be edited to vote as someone else or on a different poll.
// ---------------------------------------------------------------------
function pollVoteToken_(pollId, teamId, optIndex) {
  const raw = pollId + ":" + teamId + ":" + optIndex + ":" + SESSION_SECRET;
  const sig = Utilities.computeHmacSha256Signature(raw, SESSION_SECRET);
  return sig.map(function(b) { return ((b < 0 ? b + 256 : b).toString(16)).padStart(2, "0"); }).join("");
}

function pollVoteLinkUrl_(pollId, teamId, optIndex) {
  const base = ScriptApp.getService().getUrl(); // this deployment's own /exec URL
  const tok = pollVoteToken_(pollId, teamId, optIndex);
  return base + "?action=poll_vote_public&pollId=" + encodeURIComponent(pollId) +
    "&teamId=" + encodeURIComponent(teamId) + "&opt=" + optIndex + "&tok=" + tok;
}

// Small styled confirmation/error page — this is opened directly in a
// browser from an email link, never seen by the app itself, so it needs to
// stand on its own (not just JSON).
function pollLinkPage_(title, bodyHtml) {
  const html =
    '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + escapeHtml_(title) + '</title>' +
    '<style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f6f5f2;margin:0;padding:32px 16px;color:#2b2b2b;}' +
    '.card{max-width:420px;margin:0 auto;background:#fff;border-radius:14px;padding:24px 22px;box-shadow:0 1px 4px rgba(0,0,0,.08);}' +
    'h1{font-size:18px;margin:0 0 10px;color:#7A1319;}p{font-size:14px;line-height:1.5;margin:0 0 12px;}' +
    'a.btn{display:inline-block;background:#7A1319;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:13.5px;margin-top:6px;}</style>' +
    '</head><body><div class="card">' + bodyHtml + '</div></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle(title);
}

// Handles a click on a one-tap vote link from a poll email. Unauthenticated
// on purpose (that's the entire point — no sign-in from the email), but
// the HMAC token in the link is what stands in for auth: it's scoped to one
// specific poll, one specific team member, and one specific option, and
// can't be forged without SESSION_SECRET. Single-choice polls: this sets
// (replaces) their vote to just this option. Multi-select polls: this adds
// this option to whatever they've already picked (never removes, so
// re-clicking an old link in a multi-select poll can't accidentally undo a
// choice made since) — full add/remove control stays in-app.
function handlePublicPollVoteLink_(params) {
  const pollId = String(params.pollId || "");
  const teamId = String(params.teamId || "");
  const opt = parseInt(params.opt, 10);
  const tok = String(params.tok || "");
  if (!pollId || !teamId || isNaN(opt) || !tok || pollVoteToken_(pollId, teamId, opt) !== tok) {
    return pollLinkPage_("Link not valid",
      '<h1>This link isn’t valid</h1><p>It may be old, mistyped, or already used differently than expected. Please open the app to vote instead.</p>' +
      '<a class="btn" href="' + escapeHtml_(APP_URL) + '">Open the app</a>');
  }
  const poll = readSheet_(POLLS_SHEET, POLLS_HEADERS).find(function(p) { return p.id === pollId; });
  if (!poll) {
    return pollLinkPage_("Poll not found", '<h1>Poll not found</h1><p>This poll may have been removed.</p><a class="btn" href="' + escapeHtml_(APP_URL) + '">Open the app</a>');
  }
  const options = JSON.parse(poll.options || "[]");
  if (opt < 0 || opt >= options.length) {
    return pollLinkPage_("Link not valid", '<h1>This link isn’t valid</h1><p>That option no longer exists on this poll.</p><a class="btn" href="' + escapeHtml_(APP_URL) + '">Open the app</a>');
  }
  if (poll.status === "Closed") {
    return pollLinkPage_("Poll closed",
      '<h1>This poll is closed</h1><p>"' + escapeHtml_(poll.question) + '" is no longer accepting responses. Sign in to the app to see the results.</p>' +
      '<a class="btn" href="' + escapeHtml_(APP_URL) + '">Open the app</a>');
  }
  const team = readSheet_(TEAM_SHEET, TEAM_HEADERS);
  const member = team.find(function(t) { return t.id === teamId; });
  if (!member) {
    return pollLinkPage_("Account not found", '<h1>Account not found</h1><p>We couldn’t match this link to a team record.</p><a class="btn" href="' + escapeHtml_(APP_URL) + '">Open the app</a>');
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(POLL_VOTES_SHEET);
  const existingVotes = readSheet_(POLL_VOTES_SHEET, POLL_VOTES_HEADERS);
  const myExisting = existingVotes.find(function(v) { return v.pollId === pollId && v.voterId === teamId; });
  const now = new Date().toISOString();
  let finalIndexes;
  if (poll.allowMultiple === "Yes") {
    const current = myExisting ? String(myExisting.optionIndexes || "").split(",").map(function(s) { return parseInt(s, 10); }).filter(function(n) { return !isNaN(n); }) : [];
    finalIndexes = current.indexOf(opt) === -1 ? current.concat([opt]) : current;
  } else {
    finalIndexes = [opt];
  }
  finalIndexes = finalIndexes.filter(function(n, i) { return finalIndexes.indexOf(n) === i; }).sort(function(a, b) { return a - b; });

  if (myExisting) {
    const rowNum = findRowById_(sheet, POLL_VOTES_HEADERS, myExisting.id);
    if (rowNum !== -1) {
      sheet.getRange(rowNum, POLL_VOTES_HEADERS.indexOf("optionIndexes") + 1).setValue(finalIndexes.join(","));
      sheet.getRange(rowNum, POLL_VOTES_HEADERS.indexOf("timestamp") + 1).setValue(now);
    }
  } else {
    const ids = existingVotes.map(function(v) { return v.id; });
    let n = ids.length + 1;
    let newId = "PV" + String(n).padStart(5, "0");
    while (ids.indexOf(newId) !== -1) { n++; newId = "PV" + String(n).padStart(5, "0"); }
    sheet.appendRow([newId, pollId, teamId, member.name, finalIndexes.join(","), now]);
  }
  logActivity_(member.name, "vote_poll", pollId, finalIndexes.join(",") + " (via email link)");

  const chosenLabels = finalIndexes.map(function(i) { return options[i]; }).join(", ");
  return pollLinkPage_("Response recorded",
    '<h1>Thanks, ' + escapeHtml_(String(member.name).split(" ")[0]) + '!</h1>' +
    '<p><b>' + escapeHtml_(poll.question) + '</b></p>' +
    '<p>Your response is recorded as: <b>' + escapeHtml_(chosenLabels) + '</b></p>' +
    (poll.allowMultiple === "Yes" ? '<p style="font-size:12.5px;color:#777;">This poll allows more than one answer — open the app if you’d like to add or remove a choice.</p>' : '') +
    '<a class="btn" href="' + escapeHtml_(APP_URL) + '">Open the app</a>');
}

// Ops-tier-ish action (gated in doPost to Lead/Assistant Lead/Intern — see
// the send_poll_email branch there) that emails a poll out to a team
// segment (same zone/role/cluster/all filter as sendSegmentEmail_'s "team"
// mode). Unlike sendSegmentEmail_, this can't be a single BCC blast: each
// recipient's one-tap vote links are personal to them (see
// pollVoteLinkUrl_), so this sends one individual email per recipient.
function sendPollEmail_(body, me) {
  const pollId = String(body.pollId || "");
  const poll = readSheet_(POLLS_SHEET, POLLS_HEADERS).find(function(p) { return p.id === pollId; });
  if (!poll) return { ok: false, error: "Poll not found." };
  if (poll.status === "Closed") return { ok: false, error: "This poll is closed — reopen it, or create a new one, before emailing it." };
  const options = JSON.parse(poll.options || "[]");

  const filterField = body.filterField; // "zone" | "role" | "cluster" | "all"
  const filterValue = (body.filterValue || "").trim();
  const teamRows = readSheet_(TEAM_SHEET, TEAM_HEADERS);
  const matched = teamRows.filter(function(r) {
    if (filterField === "all") return true;
    if (filterField === "zone") return String(r.zone || "").toLowerCase().indexOf(filterValue.toLowerCase()) !== -1;
    if (filterField === "role") return r.role === filterValue;
    if (filterField === "cluster") return String(r.cluster || "").indexOf(filterValue) !== -1;
    return false;
  });
  const withEmail = matched.filter(function(r) { return r.email && String(r.email).trim(); });
  if (!withEmail.length) {
    return { ok: false, error: "No email addresses on file for that segment (" + matched.length + " matched, 0 had an email in the Team sheet)." };
  }

  const subject = "Poll: " + poll.question;
  withEmail.forEach(function(r) {
    let htmlBody = '<p>Hi ' + escapeHtml_(String(r.name).split(" ")[0]) + ',</p>' +
      '<p>' + escapeHtml_(me.name) + ' would like your response to this poll' +
      (poll.audienceLabel ? ' (for: ' + escapeHtml_(poll.audienceLabel) + ')' : '') + ':</p>' +
      '<p style="font-size:16px;font-weight:bold;">' + escapeHtml_(poll.question) + '</p>' +
      (poll.allowMultiple === "Yes" ? '<p style="font-size:12.5px;color:#777;">You can pick more than one — tap any that apply below.</p>' : '<p style="font-size:12.5px;color:#777;">Tap the option that applies — no sign-in needed.</p>');
    options.forEach(function(opt, i) {
      const link = pollVoteLinkUrl_(pollId, r.id, i);
      htmlBody += '<p style="margin:6px 0;"><a href="' + link + '" style="display:inline-block;background:#7A1319;color:#fff;text-decoration:none;padding:9px 14px;border-radius:8px;font-size:13.5px;">' + escapeHtml_(opt) + '</a></p>';
    });
    htmlBody += '<p style="margin-top:16px;font-size:12.5px;color:#777;">You can also respond, change your answer, or see live results any time in the app: <a href="' + APP_URL + '">' + APP_URL + '</a></p>';
    htmlBody += '<p>' + escapeHtml_(SENDER_NAME) + '</p>';
    const textFallback = "Poll: " + poll.question + "\n\n" + options.map(function(o, i) { return (i + 1) + ". " + o + " -> " + pollVoteLinkUrl_(pollId, r.id, i); }).join("\n") + "\n\nOr open the app: " + APP_URL;
    MailApp.sendEmail({ to: r.email, subject: subject, body: textFallback, htmlBody: htmlBody, name: SENDER_NAME, from: SENDER_EMAIL });
  });

  logActivity_(body.who, "send_poll_email", pollId, withEmail.length + " recipient(s), " + matched.length + " matched");
  return { ok: true, sent: withEmail.length, matched: matched.length };
}

// Lead/Assistant Lead only. Clears a Pending leadership request without
// promoting — `role` is left exactly as it was (typically stays Mentor).
// Deliberately sends no email, same as reject_mentor_application, so an
// automated "you didn't get it" message never lands without context; the
// optional reviewNotes lands on their Team record for a Lead to follow up
// with personally if there's something worth explaining.
function declineLeadershipInterest_(body, me) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TEAM_SHEET);
  const rowNum = findRowById_(sheet, TEAM_HEADERS, body.id);
  if (rowNum === -1) return { ok: false, error: "Team member not found." };
  const target = readSheet_(TEAM_SHEET, TEAM_HEADERS).find(function(r) { return r.id === body.id; });
  const set = function(header, value) { sheet.getRange(rowNum, TEAM_HEADERS.indexOf(header) + 1).setValue(value); };
  set("leadershipStatus", "Declined");
  set("updatedAt", new Date().toISOString());
  const reviewerRemark = String(body.reviewNotes || "").trim();
  if (reviewerRemark && target) {
    const priorNotes = String(target.notes || "").trim();
    set("notes", (priorNotes ? priorNotes + " " : "") + "Leadership request note: " + reviewerRemark);
  }
  logActivity_(me.name, "decline_leadership_interest", body.id, body.reviewNotes || "");
  return { ok: true };
}

function emailLeadershipApproval_(row, role) {
  const to = String(row.email || "").trim();
  if (!isValidEmail_(to)) return false;
  const placeLine = role === "Zone Coordinator"
    ? (row.zone ? "Zone: " + row.zone : "")
    : (row.cluster ? "Cluster: " + row.cluster : "");
  try {
    MailApp.sendEmail({
      to: to,
      subject: "You're now a " + role + " for Boma Career Day 2026!",
      body:
        "Hi " + (row.name || "") + ",\n\n" +
        "Great news — you've been approved as " + role + " for Boma Career Day 2026, Saturday 29 August at Kenya High School.\n\n" +
        (placeLine ? placeLine + "\n\n" : "") +
        "This is now reflected in the CMP Mentors Hub app under your name, and the wider team can see it too — just sign in as usual.\n\n" +
        "Thank you for stepping up. Reach out to a Lead or Assistant Lead any time if you have questions about what's next.\n\n" +
        SENDER_NAME,
      name: SENDER_NAME,
      from: SENDER_EMAIL,
    });
    return true;
  } catch (err) {
    return false;
  }
}

// Lead/Assistant Lead only (enforced via ADMIN_ONLY in doPost). Moves a
// mentor to a different cluster, or confirms them as a dual/backup mentor
// on top of their existing primary cluster — this is the manual counterpart
// to the automatic 2nd-choice fallback in approveMentorApplication_, used
// from the Cluster Command Center's "Pull a backup mentor" / "Confirm dual
// mentorship" actions.
//   body.id        — Team member id (required)
//   body.clusterId — target cluster id, e.g. "B2" (required)
//   body.mode      — "move" (default): replaces their cluster entirely.
//                     "dual": keeps their current cluster as primary and
//                     sets clusterId as a CONFIRMED secondary — this is the
//                     only path that sets secondaryClusterConfirmed="Yes",
//                     which is what makes a backup mentor start counting
//                     toward the secondary cluster's shift coverage.
//   body.notify    — set false to skip the confirmation email (defaults on).
function reassignMentorCluster_(body, me) {
  const mode = body.mode === "dual" ? "dual" : "move";
  const clusterId = String(body.clusterId || "").trim().toUpperCase();
  if (!clusterId) return { ok: false, error: "Choose a cluster." };
  const clusters = readSheet_(CLUSTERS_SHEET, CLUSTERS_HEADERS);
  const clusterRow = clusters.find(function(c) { return c.id === clusterId; });
  if (!clusterRow) return { ok: false, error: "Unknown cluster: " + clusterId };

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TEAM_SHEET);
  const rowNum = findRowById_(sheet, TEAM_HEADERS, body.id);
  if (rowNum === -1) return { ok: false, error: "Team member not found." };
  const target = readSheet_(TEAM_SHEET, TEAM_HEADERS).find(function(r) { return r.id === body.id; });
  if (!target) return { ok: false, error: "Team member not found." };

  const set = function(header, value) { sheet.getRange(rowNum, TEAM_HEADERS.indexOf(header) + 1).setValue(value); };
  const now = new Date().toISOString();
  const priorNotes = String(target.notes || "").trim();
  const clusterLabel = clusterId + " " + clusterRow.name;
  const oldClusterLabel = target.cluster || "(no cluster)";

  if (mode === "dual") {
    if (teamRowClusterId_(target.cluster) === clusterId) {
      return { ok: false, error: clusterId + " is already this mentor's primary cluster." };
    }
    set("secondaryCluster", clusterLabel);
    set("secondaryClusterConfirmed", "Yes");
    set("notes", (priorNotes ? priorNotes + " " : "") + "Confirmed as a backup/dual mentor for " + clusterLabel + " by " + me.name + " on " + now.slice(0, 10) + ".");
  } else {
    set("cluster", clusterLabel);
    const zoneLetter = clusterId.charAt(0);
    set("zone", zoneLetter ? "Zone " + zoneLetter : target.zone);
    // Moving to a new primary cluster invalidates any prior "confirmed"
    // backup status for whatever their secondary cluster used to be — they
    // can be re-confirmed for a new secondary separately if still needed.
    if (target.secondaryClusterConfirmed === "Yes") set("secondaryClusterConfirmed", "");
    set("notes", (priorNotes ? priorNotes + " " : "") + "Reassigned from " + oldClusterLabel + " to " + clusterLabel + " by " + me.name + " on " + now.slice(0, 10) + ".");
  }
  set("updatedAt", now);
  logActivity_(me.name, "reassign_mentor_cluster", body.id, mode + " -> " + clusterId);

  const emailSent = body.notify === false ? false : emailReassignmentConfirmation_(target, clusterRow, mode, oldClusterLabel);
  return { ok: true, mode: mode, clusterId: clusterId, emailSent: emailSent };
}

function emailReassignmentConfirmation_(row, clusterRow, mode, oldClusterLabel) {
  const to = String(row.email || "").trim();
  if (!isValidEmail_(to)) return false;
  const clusterLabel = clusterRow.id + " — " + clusterRow.name;
  const subject = mode === "dual"
    ? "You're now also backup mentor for " + clusterRow.id + " — Boma Career Day 2026"
    : "Your cluster has changed — Boma Career Day 2026";
  const bodyText = mode === "dual"
    ? "Hi " + (row.name || "") + ",\n\n" +
      "Thanks for offering to help out further — you're now confirmed as a backup/dual mentor for " + clusterLabel + ", in addition to your primary cluster.\n\n" +
      "You may be asked to split your time between the two, or step in at " + clusterLabel + " if it's short on mentors during your shift. A Lead or Assistant Lead will confirm the details with you closer to the day.\n\n" +
      "Thank you again for your flexibility and for volunteering your time.\n\n" + SENDER_NAME
    : "Hi " + (row.name || "") + ",\n\n" +
      "Just a heads-up — your cluster for Boma Career Day 2026 has changed.\n\n" +
      "Previous cluster: " + oldClusterLabel + "\n" +
      "New cluster: " + clusterLabel + "\n\n" +
      "This is now reflected in the CMP Mentors Hub app under your name. If you have any questions about the change, reach out to a Lead or Assistant Lead any time.\n\n" +
      "Thank you again for volunteering your time and expertise.\n\n" + SENDER_NAME;
  try {
    MailApp.sendEmail({ to: to, subject: subject, body: bodyText, name: SENDER_NAME, from: SENDER_EMAIL });
    return true;
  } catch (err) {
    return false;
  }
}

// ---------------------------------------------------------------------
// ROUND SIGN-UP GRID — up to SESSION_ROUND_CAPACITY mentors per round per
// cluster. Self-service for the mentor/Cluster Lead/Sub-Lead signing
// themselves up for their OWN cluster (primary, or a confirmed secondary/
// dual cluster); "ops" tier (Lead/Assistant Lead/Zone Coordinator/Intern —
// same tier as update_cluster_room) may sign up or remove ANY mentor in ANY
// cluster, for filling a thin round on someone's behalf.
//   body.scheduleId — Schedule row id, e.g. "F4-R2" (required)
//   body.mentorId   — defaults to the caller; an ops-tier caller may pass a
//                     different mentor's id to sign them up.
//   body.clusterId  — required when signing up on behalf of someone else
//                     (or to disambiguate a dual-cluster mentor); defaults
//                     to the target mentor's own primary cluster.
function claimSessionSlot_(body, me) {
  const isOpsTier = me.accessLevel === "all" || me.accessLevel === "zone" || me.accessLevel === "intern";
  const targetMentorId = body.mentorId || me.id;
  const actingForSelf = targetMentorId === me.id;
  if (!actingForSelf && !isOpsTier) {
    return { ok: false, error: "You can only sign yourself up. Ask a Lead, Assistant Lead, Zone Coordinator, or Intern to sign someone else up." };
  }
  const team = readSheet_(TEAM_SHEET, TEAM_HEADERS);
  const target = team.find(function(t) { return t.id === targetMentorId; });
  if (!target || target.status === "Deleted") return { ok: false, error: "Team member not found." };
  if (ROOM_MENTOR_ROLES_SERVER_.indexOf(target.role) === -1) {
    return { ok: false, error: "Only Mentors, Cluster Leads, and Sub-Leads sign up for rounds." };
  }

  const schedule = readSheet_(SCHEDULE_SHEET, SCHEDULE_HEADERS);
  const slot = schedule.find(function(s) { return s.id === body.scheduleId; });
  if (!slot) return { ok: false, error: "Unknown session: " + body.scheduleId };
  // Only actual numbered mentorship rounds take sign-ups — Lab/Lunch/
  // Exhibition rows are informational schedule blocks, not mentor-staffed.
  if (!/^\d+$/.test(String(slot.round))) {
    return { ok: false, error: "This isn't a mentorship round." };
  }

  const primaryClusterId = teamRowClusterId_(target.cluster);
  const secondaryClusterId = target.secondaryClusterConfirmed === "Yes" ? teamRowClusterId_(target.secondaryCluster) : "";
  let clusterId = String(body.clusterId || "").trim().toUpperCase();
  if (!clusterId) clusterId = primaryClusterId;
  if (!clusterId) return { ok: false, error: "This mentor has no cluster on file yet." };
  // A self-service caller (or an ops-tier caller acting on their OWN behalf)
  // may only claim a round for a cluster that's actually theirs — never an
  // arbitrary cluster id typed into the request. An ops-tier caller acting
  // FOR SOMEONE ELSE may place them in any real cluster (that's the whole
  // point of the gap-filling override).
  if (actingForSelf && clusterId !== primaryClusterId && clusterId !== secondaryClusterId) {
    return { ok: false, error: "You can only sign up for your own cluster." };
  }
  const clusters = readSheet_(CLUSTERS_SHEET, CLUSTERS_HEADERS);
  if (!clusters.some(function(c) { return c.id === clusterId; })) {
    return { ok: false, error: "Unknown cluster: " + clusterId };
  }

  const existing = readSheet_(SESSION_SIGNUPS_SHEET, SESSION_SIGNUPS_HEADERS);
  // One seat per mentor per round (across ALL clusters) — a mentor can't
  // physically staff two rooms at the same time.
  const already = existing.find(function(r) { return r.scheduleId === body.scheduleId && r.mentorId === targetMentorId; });
  if (already) return { ok: false, error: "Already signed up for this round." };

  const roundSignups = existing.filter(function(r) { return r.scheduleId === body.scheduleId && r.clusterId === clusterId; });
  if (roundSignups.length >= SESSION_ROUND_CAPACITY) {
    return { ok: false, error: "This round is already full for " + clusterId + " (max " + SESSION_ROUND_CAPACITY + " mentors)." };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SESSION_SIGNUPS_SHEET);
  const ids = existing.map(function(r) { return r.id; });
  let n = ids.length + 1;
  let newId = "SU" + String(n).padStart(4, "0");
  while (ids.indexOf(newId) !== -1) { n++; newId = "SU" + String(n).padStart(4, "0"); }
  const now = new Date().toISOString();
  sheet.appendRow([newId, body.scheduleId, slot.cohort, slot.round, clusterId, targetMentorId, target.name, now]);
  logActivity_(me.name, "claim_session_slot", newId, targetMentorId + " -> " + body.scheduleId + " (" + clusterId + ")");
  return { ok: true, id: newId };
}

// Self-service for the mentor who owns the sign-up, or ops-tier removing
// anyone's — same tiering as claimSessionSlot_.
function releaseSessionSlot_(body, me) {
  const existing = readSheet_(SESSION_SIGNUPS_SHEET, SESSION_SIGNUPS_HEADERS);
  const row = existing.find(function(r) { return r.id === body.id; });
  if (!row) return { ok: false, error: "Sign-up not found." };
  const isOpsTier = me.accessLevel === "all" || me.accessLevel === "zone" || me.accessLevel === "intern";
  if (row.mentorId !== me.id && !isOpsTier) {
    return { ok: false, error: "You can only cancel your own sign-up." };
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SESSION_SIGNUPS_SHEET);
  const rowNum = findRowById_(sheet, SESSION_SIGNUPS_HEADERS, body.id);
  if (rowNum === -1) return { ok: false, error: "Sign-up not found." };
  sheet.deleteRow(rowNum);
  logActivity_(me.name, "release_session_slot", body.id, row.mentorId + " <- " + row.scheduleId);
  return { ok: true };
}

// Lead/Assistant Lead only (enforced via ADMIN_ONLY in doPost). Re-sends
// someone's CURRENT pin to the email already on file for them — doesn't
// change anything, just resends what's there. Meant for backfilling people
// who were seeded/added before an email was on file, once you've since
// added one via Team Access, or for anyone who says they lost their PIN.
function resendPin_(body) {
  const team = readSheet_(TEAM_SHEET, TEAM_HEADERS);
  const person = team.find(function(t) { return t.id === body.id; });
  if (!person) return { ok: false, error: "Team member not found." };
  const to = String(person.email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return { ok: false, error: "No email on file for this person yet — add one and Save first." };
  }
  if (!person.pin) return { ok: false, error: "This person doesn't have a PIN set yet." };
  const sent = emailPinIfPossible_(to, person.name, person.pin);
  if (!sent) return { ok: false, error: "Couldn't send the email — try again in a moment." };
  logActivity_(body.who, "resend_pin", body.id, to);
  return { ok: true, email: to };
}

// Any signed-in person may change their OWN pin (not admin-gated — this is
// self-service, scoped to "me" from the verified token, never an id passed
// in the request body, so there's no way to change anyone else's pin this
// way). Changing it immediately invalidates every token issued under the
// old pin (see verifyToken_), including the caller's own current one — the
// new token is returned so the client can swap it in without forcing a
// fresh sign-in.
function changeOwnPin_(body, me) {
  const newPin = String(body.newPin || "").trim() || generatePin_();
  if (!/^\d{4,6}$/.test(newPin)) return { ok: false, error: "PIN must be 4-6 digits." };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TEAM_SHEET);
  const row = findRowById_(sheet, TEAM_HEADERS, me.id);
  if (row === -1) return { ok: false, error: "Couldn't find your record." };
  const pinCol = TEAM_HEADERS.indexOf("pin") + 1;
  const updatedCol = TEAM_HEADERS.indexOf("updatedAt") + 1;
  sheet.getRange(row, pinCol).setValue(newPin);
  sheet.getRange(row, updatedCol).setValue(new Date().toISOString());
  logActivity_(me.name, "change_own_pin", me.id, "");
  return { ok: true, pin: newPin, token: makeToken_(me.id, newPin) };
}

// Exact-match-after-normalization only (case/whitespace-insensitive) — this
// catches the common "added the same person twice" and "registered the same
// student twice under a different admission number" slip-ups, but it is NOT
// fuzzy/typo-tolerant matching (e.g. "Jon" vs "John" won't be caught). It's
// a soft warning either way — it never blocks the registration.
function similarNameExists_(existingRows, name, excludeId) {
  const norm = String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!norm) return false;
  return existingRows.some(function(r) {
    if (excludeId && r.id === excludeId) return false;
    const rn = String(r.name || "").trim().toLowerCase().replace(/\s+/g, " ");
    return rn === norm;
  });
}

// Registration ID format: KHS26-[Cohort]-[NNNN], e.g. KHS26-G10A-0001 — a
// per-cohort sequential counter the app assigns automatically. Nobody types
// or supplies this number; it is never a user input. (Earlier versions of
// this app derived the ID from a school admission number typed in at
// registration — that's gone. The admissionNo column stays in the sheet
// for now purely so existing column positions don't shift, but nothing
// reads or requires it anymore.)
function nextCareerDayId_(existingStudents, cohort) {
  const prefix = "KHS26-" + cohort + "-";
  let maxN = 0;
  existingStudents.forEach(function(r) {
    if (r.id && String(r.id).indexOf(prefix) === 0) {
      const n = parseInt(String(r.id).slice(prefix.length), 10);
      if (!isNaN(n) && n > maxN) maxN = n;
    }
  });
  return prefix + String(maxN + 1).padStart(4, "0");
}

function registerStudent_(body) {
  const cohort = (body.cohort || "").trim();
  if (!body.name || !cohort) {
    return { ok: false, error: "Name and cohort are required." };
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(STUDENTS_SHEET);

  // Two people can submit registrations at the same moment (e.g. an intern
  // running bulk import while someone else registers a walk-in) — without a
  // lock, both requests could read the same "highest number so far" and
  // assign the SAME Career Day ID to two different students. The lock makes
  // "read the highest number, then append" one atomic step across every
  // concurrent request.
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let newId;
  try {
    const existing = readSheet_(STUDENTS_SHEET, STUDENTS_HEADERS);
    newId = nextCareerDayId_(existing, cohort);

    // Same name, same cohort — the most common real double-entry (someone
    // registered twice, e.g. once by themself and once via a class bulk
    // import). Soft warning only; never blocks registration.
    const sameCohort = existing.filter(function(r) { return r.cohort === cohort; });
    var duplicate = similarNameExists_(sameCohort, body.name, null);

    const now = new Date().toISOString();
    const row = STUDENTS_HEADERS.map(function(h) {
      if (h === "id") return newId;
      if (h === "createdAt" || h === "updatedAt") return now;
      if (h === "status") return body.status || "Pending";
      if (h === "admissionNo") return ""; // no longer collected — see comment above
      return body[h] || "";
    });
    sheet.appendRow(row);
  } finally {
    lock.releaseLock();
  }
  logActivity_(body.who, "register_student", newId, body.name);
  return { ok: true, id: newId, duplicateWarning: duplicate ? "A student named \"" + body.name + "\" is already registered in " + cohort + " — double check this isn't a repeat entry." : "" };
}

// PUBLIC — reachable with no token (see doPost). This is the parent-assisted
// registration flow: the app link goes to parents first, and either they
// fill it in on their own device with their daughter, or she fills it in on
// a parent's device — either way, since she's a minor, this path requires
// an explicit parent/guardian name, contact, and consent checkbox that the
// staff-run register_student action doesn't ask for (a class teacher/intern
// present in person already IS the adult-in-the-room check there). Writes
// straight into Students with status "Pending", same as any other
// registration route — there's no separate approval step for students,
// only for the consent itself.
// { CR001: { clusterId, name, description }, ... } — read once per call
// (Careers sheet is small, ~190 rows) rather than cached, since a Lead could
// edit a career's cluster mapping mid-event and this must see that change
// on the very next submission.
function careerClusterMap_() {
  const map = {};
  readSheet_(CAREERS_SHEET, CAREERS_HEADERS).forEach(function(c) {
    map[c.id] = { clusterId: c.clusterId, name: c.name, description: c.description };
  });
  return map;
}

// Turns a student's ranked CAREER picks into the ranked CLUSTER-id list
// every existing downstream system (allocateStudents_, CSV export,
// dashboards) already runs on — unknown/blank career ids are skipped
// silently (never blocks submission over a stale id), and a cluster that two
// different ranked careers both belong to only appears once, at its FIRST
// (highest-priority) position. otherClusterId, if given, is appended at the
// very end only if not already present — an extra, lowest-priority shot at
// that cluster, on top of her real ranked choices, never replacing them.
function deriveClusterChoicesFromCareers_(careerIds, otherClusterId, careerMap) {
  const clusters = [];
  careerIds.forEach(function(cid) {
    const c = careerMap[cid];
    if (c && c.clusterId && clusters.indexOf(c.clusterId) === -1) clusters.push(c.clusterId);
  });
  if (otherClusterId && clusters.indexOf(otherClusterId) === -1) clusters.push(otherClusterId);
  return clusters;
}

// System-generated group message — deliberately bypasses the myGroupIds_
// membership check in postGroupMessage_ (there is no "me": this is triggered
// by an anonymous public form submission, not a signed-in person posting).
// Used only for automated, informational notes (see
// notifyZoneOfCareerRequest_) — never exposed as a callable action, so a
// stranger can't use it to post arbitrary messages into a staff group chat.
function postSystemGroupMessage_(groupId, message) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureSheet_(ss, GROUP_CHAT_SHEET, GROUP_CHAT_HEADERS, []);
  const lastRow = sheet.getLastRow();
  const ids = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(function(r) { return r[0]; }) : [];
  let n = ids.length + 1;
  let newId = "GM" + String(n).padStart(5, "0");
  while (ids.indexOf(newId) !== -1) { n++; newId = "GM" + String(n).padStart(5, "0"); }
  sheet.appendRow([newId, new Date().toISOString(), groupId, "Career Day System", "SYSTEM", message]);
}

// Posts an automated note into the requested cluster's ZONE group chat
// (visible to every mentor/cluster lead/Zone Coordinator working that
// zone — see myGroupIds_) whenever a student's free-text "other career"
// request gets matched to a cluster. Silently does nothing if the cluster
// id doesn't resolve to a real zone — never blocks the registration itself.
function notifyZoneOfCareerRequest_(clusterId, careerText, studentName, classStream) {
  const cluster = readSheet_(CLUSTERS_SHEET, CLUSTERS_HEADERS).find(function(c) { return c.id === clusterId; });
  if (!cluster) return;
  const zoneLetter = zoneLetterOf_(cluster.zone);
  if (!zoneLetter) return;
  const msg = "🔔 Additional career mentorship requested: \"" + careerText + "\" — matched to Cluster " +
    clusterId + " (" + cluster.name + "). Requested by " + studentName + " (" + classStream +
    ") alongside her ranked choices.";
  postSystemGroupMessage_("zone-" + zoneLetter, msg);
}

// K8 (Grade 10) is the one stream WG2 splits roughly in half between Group
// A and Group B, rather than assigning it wholesale like every other
// stream — K1-K7 are entirely Group A, K9-K15 are entirely Group B, K8 is
// ~50/50. Rather than WG2 having to maintain a per-student list of who's in
// which half, the split is driven by registration order: the first
// K8_GROUP_A_THRESHOLD self-registered K8 students land in Group A,
// everyone after that in Group B. Whatever cohort the Classes sheet's K8
// row carries is just a harmless placeholder — publicRegisterStudent_
// below always overrides it for classStream "K8". Adjust the threshold
// here if K8's real headcount turns out different from the assumed 50
// (currently half of that). Only applies to the public self-service form —
// staff-run registration (register_student/bulk import) leaves cohort
// exactly as the class teacher enters it, since she already knows which
// half a given student is in from her own roster.
const K8_GROUP_A_THRESHOLD = 25;
function resolveK8Cohort_(existingStudents) {
  const countA = existingStudents.filter(function(r) {
    return r.classStream === "K8" && r.cohort === "G10A";
  }).length;
  return countA < K8_GROUP_A_THRESHOLD ? "G10A" : "G10B";
}

function publicRegisterStudent_(body) {
  const name = String(body.name || "").trim();
  let cohort = String(body.cohort || "").trim();
  const classStream = String(body.classStream || "").trim();
  const parentName = String(body.parentName || "").trim();
  const parentContact = String(body.parentContact || "").trim();
  const consent = body.parentConsent === true || body.parentConsent === "true" || body.parentConsent === "Yes";
  const careerIds = String(body.careerChoices || "").split(",").map(function(s) { return s.trim(); }).filter(Boolean);
  const otherCareerRequest = String(body.otherCareerRequest || "").trim();

  if (!name) return { ok: false, error: "The student's full name is required." };
  if (!cohort) return { ok: false, error: "Please select a cohort." };
  if (!classStream) return { ok: false, error: "Please select a class/stream." };
  if (!parentName) return { ok: false, error: "Parent/guardian full name is required." };
  if (!parentContact) return { ok: false, error: "Parent/guardian phone or email is required." };
  if (!consent) return { ok: false, error: "A parent or guardian must confirm consent to submit." };

  // Free-text "other career" gets matched to its closest cluster via the
  // same heuristic keyword scorer used for mentor cluster-fit (see
  // suggestClusterFit_/CLUSTER_KEYWORDS_) — a score of 0 means no confident
  // match, in which case the text is still saved (so staff can follow up
  // manually) but nothing is auto-added to her choices or notified.
  let otherCareerClusterId = "";
  if (otherCareerRequest) {
    const fit = suggestClusterFit_(otherCareerRequest, 1);
    if (fit && fit.length && fit[0].score > 0) otherCareerClusterId = fit[0].clusterId;
  }

  const careerMap = careerClusterMap_();
  const derivedChoices = deriveClusterChoicesFromCareers_(careerIds, otherCareerClusterId, careerMap);

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(STUDENTS_SHEET);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let newId, duplicate;
  try {
    const existing = readSheet_(STUDENTS_SHEET, STUDENTS_HEADERS);
    // Resolved inside the lock, using the same read of Students this
    // request already needs for the ID/duplicate check — so two K8
    // registrations submitted at the same moment can't both read the same
    // "count so far" and both land in Group A.
    if (classStream === "K8") cohort = resolveK8Cohort_(existing);
    newId = nextCareerDayId_(existing, cohort);
    const sameCohort = existing.filter(function(r) { return r.cohort === cohort; });
    duplicate = similarNameExists_(sameCohort, name, null);

    const now = new Date().toISOString();
    const row = STUDENTS_HEADERS.map(function(h) {
      if (h === "id") return newId;
      if (h === "name") return name;
      if (h === "cohort") return cohort;
      if (h === "classStream") return classStream;
      if (h === "choices") return derivedChoices.join(",");
      if (h === "careerChoices") return careerIds.join(",");
      if (h === "otherCareerRequest") return otherCareerRequest;
      if (h === "otherCareerClusterId") return otherCareerClusterId;
      if (h === "createdAt" || h === "updatedAt") return now;
      if (h === "status") return "Pending";
      if (h === "admissionNo") return "";
      if (h === "email") return String(body.email || "").trim();
      if (h === "parentName") return parentName;
      if (h === "parentContact") return parentContact;
      if (h === "parentConsent") return "Yes";
      if (h === "consentAt") return now;
      return "";
    });
    sheet.appendRow(row);
  } finally {
    lock.releaseLock();
  }
  logActivity_("Parent-assisted registration (" + parentName + ")", "public_register_student", newId, name);
  if (otherCareerRequest && otherCareerClusterId) {
    try { notifyZoneOfCareerRequest_(otherCareerClusterId, otherCareerRequest, name, classStream); } catch (err) { /* never block registration over a notification failure */ }
  }
  return {
    ok: true, id: newId,
    duplicateWarning: duplicate ? "A student named \"" + name + "\" is already registered in " + cohort + " — double check this isn't a repeat entry." : "",
  };
}

// PUBLIC — reachable with no token. Lets a parent/student come back and
// change ranked career choices (or the "other career" request) any time up
// to STUDENT_CHOICE_DEADLINE_ISO, without needing an account: they prove
// it's really them by supplying BOTH the Career Day ID (given at
// registration, e.g. on the confirmation screen/QR) AND the student's full
// name exactly as registered (case/whitespace-insensitive match) — knowing
// just one or the other isn't enough. Only touches choices-related fields;
// name/class/parent details are NOT editable here (a genuine correction to
// those goes through WG2 staff, not this self-serve form, since those
// aren't time-sensitive the way mentor matching is).
function publicUpdateStudentChoices_(body) {
  const now = new Date();
  if (now > new Date(STUDENT_CHOICE_DEADLINE_ISO)) {
    return { ok: false, error: "The deadline to change career choices (27 Aug 2026, 12:00pm EAT) has passed — changes can no longer be made through this form. Contact WG2 directly if something needs correcting." };
  }
  const careerDayId = String(body.careerDayId || "").trim().toUpperCase();
  const nameInput = String(body.name || "").trim();
  if (!careerDayId || !nameInput) return { ok: false, error: "Both the Career Day ID and the student's full name are required." };

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(STUDENTS_SHEET);
  const rowNum = findRowById_(sheet, STUDENTS_HEADERS, careerDayId);
  if (rowNum === -1) return { ok: false, error: "No registration found for that Career Day ID. Double-check it and try again." };

  const nameIdx = STUDENTS_HEADERS.indexOf("name");
  const rowVals = sheet.getRange(rowNum, 1, 1, STUDENTS_HEADERS.length).getValues()[0];
  const normalize = function(s) { return String(s || "").trim().toLowerCase().replace(/\s+/g, " "); };
  if (normalize(rowVals[nameIdx]) !== normalize(nameInput)) {
    return { ok: false, error: "That Career Day ID and name don't match our records. Double-check both and try again." };
  }

  const careerIds = String(body.careerChoices || "").split(",").map(function(s) { return s.trim(); }).filter(Boolean);
  const otherCareerRequest = String(body.otherCareerRequest || "").trim();
  let otherCareerClusterId = "";
  if (otherCareerRequest) {
    const fit = suggestClusterFit_(otherCareerRequest, 1);
    if (fit && fit.length && fit[0].score > 0) otherCareerClusterId = fit[0].clusterId;
  }
  const careerMap = careerClusterMap_();
  const derivedChoices = deriveClusterChoicesFromCareers_(careerIds, otherCareerClusterId, careerMap);

  const set = function(header, value) {
    const idx = STUDENTS_HEADERS.indexOf(header);
    if (idx !== -1) sheet.getRange(rowNum, idx + 1).setValue(value);
  };
  const prevOtherRequest = rowVals[STUDENTS_HEADERS.indexOf("otherCareerRequest")];
  set("choices", derivedChoices.join(","));
  set("careerChoices", careerIds.join(","));
  set("otherCareerRequest", otherCareerRequest);
  set("otherCareerClusterId", otherCareerClusterId);
  set("updatedAt", new Date().toISOString());

  logActivity_("Self-service edit (" + nameInput + ")", "public_update_student_choices", careerDayId, "Updated career choices");
  // Only re-notify the zone if this is a NEW or CHANGED "other career" text —
  // avoids spamming the same group chat every time she re-saves unrelated
  // ranked-choice edits.
  if (otherCareerRequest && otherCareerClusterId && otherCareerRequest !== prevOtherRequest) {
    try { notifyZoneOfCareerRequest_(otherCareerClusterId, otherCareerRequest, nameInput, rowVals[STUDENTS_HEADERS.indexOf("classStream")]); } catch (err) { /* never block the update */ }
  }
  return { ok: true, id: careerDayId };
}

// PUBLIC — reachable with no token. The read-only counterpart to
// publicUpdateStudentChoices_: looks a registration up by Career Day ID +
// name (same matching rule) and returns just enough for the edit screen to
// prefill itself — never the parent's contact details or consent info,
// since this is reachable by anyone who has the ID and name, not just the
// parent who originally submitted it.
function publicLookupStudent_(body) {
  const careerDayId = String(body.careerDayId || "").trim().toUpperCase();
  const nameInput = String(body.name || "").trim();
  if (!careerDayId || !nameInput) return { ok: false, error: "Both the Career Day ID and the student's full name are required." };
  const all = readSheet_(STUDENTS_SHEET, STUDENTS_HEADERS);
  const normalize = function(s) { return String(s || "").trim().toLowerCase().replace(/\s+/g, " "); };
  const row = all.find(function(r) { return String(r.id).trim().toUpperCase() === careerDayId && normalize(r.name) === normalize(nameInput); });
  if (!row) return { ok: false, error: "No registration found for that Career Day ID and name. Double-check both and try again." };
  return {
    ok: true,
    student: {
      id: row.id, name: row.name, cohort: row.cohort, classStream: row.classStream,
      careerChoices: row.careerChoices || "", otherCareerRequest: row.otherCareerRequest || "",
      status: row.status || "",
    },
    deadlinePassed: new Date() > new Date(STUDENT_CHOICE_DEADLINE_ISO),
  };
}

// Assigns round1-round4 for every student who has ranked cluster choices
// but isn't fully allocated yet (or all candidates, if body.force is true).
// Greedy cascading pass per Playbook Section 18.5: for each round, give each
// student their highest-ranked still-available-and-not-yet-used cluster,
// respecting per-round capacity. Processed in a shuffled order each run so
// no single student is systematically favoured across every round.
// Sets/clears spilloverApproved for one student (body.id, body.approved:
// true/false). Doesn't run allocation itself — the actual round4 cluster
// assignment happens the next time run_allocation runs (see the dedicated
// spillover pass in runAllocation_ below), same as any other allocation
// change. Clearing approval (approved: false) does NOT remove an
// already-assigned round4 — that's a deliberate manual action (edit the
// Students sheet, or clear round4 directly) since a mentor may already be
// expecting that student.
function setStudentSpillover_(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(STUDENTS_SHEET);
  const rowNum = findRowById_(sheet, STUDENTS_HEADERS, body.id);
  if (rowNum === -1) return { ok: false, error: "Student not found: " + body.id };
  const col = STUDENTS_HEADERS.indexOf("spilloverApproved") + 1;
  const approved = body.approved === true || body.approved === "true" || body.approved === "Yes";
  sheet.getRange(rowNum, col).setValue(approved ? "Yes" : "");
  logActivity_(body.who, "set_student_spillover", body.id, approved ? "Approved for extra mentorship round" : "Extra mentorship round approval removed");
  return { ok: true, id: body.id, approved: approved };
}

function runAllocation_(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const studentsSheet = ss.getSheetByName(STUDENTS_SHEET);
  const clustersSheet = ss.getSheetByName(CLUSTERS_SHEET);
  const lastRow = studentsSheet.getLastRow();
  if (lastRow < 2) return { ok: true, roundsAssigned: 0, studentsProcessed: 0, studentsIncomplete: 0 };

  const idIdx = STUDENTS_HEADERS.indexOf("id");
  const cohortIdx = STUDENTS_HEADERS.indexOf("cohort");
  const choicesIdx = STUDENTS_HEADERS.indexOf("choices");
  const round1Idx = STUDENTS_HEADERS.indexOf("round1");
  const statusIdx = STUDENTS_HEADERS.indexOf("status");
  const updatedIdx = STUDENTS_HEADERS.indexOf("updatedAt");
  const spilloverIdx = STUDENTS_HEADERS.indexOf("spilloverApproved");

  const values = studentsSheet.getRange(2, 1, lastRow - 1, STUDENTS_HEADERS.length).getValues();

  const clustersLastRow = clustersSheet.getLastRow();
  const clusterRows = clustersLastRow >= 2 ? clustersSheet.getRange(2, 1, clustersLastRow - 1, CLUSTERS_HEADERS.length).getValues() : [];
  const capIdx = CLUSTERS_HEADERS.indexOf("capacity");
  const clusterIdIdx = CLUSTERS_HEADERS.indexOf("id");
  const baseCapacity = {};
  clusterRows.forEach(function(r) { baseCapacity[r[clusterIdIdx]] = Number(r[capIdx]) || 25; });

  // Each cohort (Form 4 / Grade 10 A / Grade 10 B) uses the same 23 rooms but
  // at a different, non-overlapping time slot (Playbook Section 18.1) — so
  // capacity pools are kept separate PER COHORT, each starting at full room
  // capacity, rather than one shared pool across all 1,246 students.
  // capacity[cohort][round][clusterId] = remaining seats that round.
  const capacity = {};
  function ensureCohortCapacity(co) {
    if (capacity[co]) return;
    capacity[co] = { 1: {}, 2: {}, 3: {}, 4: {} };
    Object.keys(baseCapacity).forEach(function(cid) {
      for (let rr = 1; rr <= 4; rr++) capacity[co][rr][cid] = baseCapacity[cid];
    });
  }
  values.forEach(function(row) { ensureCohortCapacity(row[cohortIdx]); });
  // Existing assignments (from any prior run) still occupy a seat, whether
  // or not that student is being reallocated this time.
  values.forEach(function(row) {
    const co = row[cohortIdx];
    for (let rr = 1; rr <= 4; rr++) {
      const cid = row[round1Idx + (rr - 1)];
      if (cid && capacity[co][rr][cid] !== undefined) capacity[co][rr][cid]--;
    }
  });

  // "Standard complete" = rounds 1-3 filled. Round 4 is the OPTIONAL,
  // separately-gated spillover round (see spilloverIdx below) — it's never
  // part of what counts as "complete", and never auto-assigned here just
  // because a student ranked 4+ choices.
  const force = !!body.force;
  const candidateIdx = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    if (!row[choicesIdx]) continue; // no ranked choices submitted — nothing to allocate from
    const standardFull = row[round1Idx] && row[round1Idx + 1] && row[round1Idx + 2];
    if (standardFull && !force) continue;
    candidateIdx.push(i);
  }
  if (force) {
    candidateIdx.forEach(function(i) {
      for (let rr = 1; rr <= 4; rr++) values[i][round1Idx + (rr - 1)] = "";
    });
  }

  // Fisher-Yates shuffle so round-1-priority isn't always the same students
  for (let i = candidateIdx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = candidateIdx[i]; candidateIdx[i] = candidateIdx[j]; candidateIdx[j] = tmp;
  }

  let roundsAssigned = 0;
  // Standard rounds 1-3 — every candidate is eligible, same greedy
  // cascading pass as before.
  for (let round = 1; round <= 3; round++) {
    const col = round1Idx + (round - 1);
    for (let k = 0; k < candidateIdx.length; k++) {
      const row = values[candidateIdx[k]];
      if (row[col]) continue; // this round already filled (e.g. kept from a prior partial run)
      const co = row[cohortIdx];
      const choices = String(row[choicesIdx]).split(",").map(function(s) { return s.trim(); }).filter(Boolean);
      const used = [row[round1Idx], row[round1Idx + 1], row[round1Idx + 2], row[round1Idx + 3]].filter(Boolean);
      for (let c = 0; c < choices.length; c++) {
        const cid = choices[c];
        if (used.indexOf(cid) !== -1) continue; // no repeat cluster across this student's own rounds
        if (capacity[co][round][cid] > 0) {
          row[col] = cid;
          capacity[co][round][cid]--;
          roundsAssigned++;
          break;
        }
      }
    }
  }

  // Optional round 4 (spillover) — ONLY students explicitly approved in
  // advance (spilloverApproved === "Yes", set via set_student_spillover_),
  // regardless of how many choices they ranked or whether they were part of
  // this run's candidateIdx. Runs over every row on the sheet so approving
  // a student AFTER a previous allocation pass still picks her up on the
  // next run without needing to reset/reshuffle everyone else.
  let round4Assigned = 0;
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    if (spilloverIdx === -1 || row[spilloverIdx] !== "Yes") continue;
    if (row[round1Idx + 3]) continue; // already has a round4
    if (!row[choicesIdx]) continue;
    const co = row[cohortIdx];
    const choices = String(row[choicesIdx]).split(",").map(function(s) { return s.trim(); }).filter(Boolean);
    const used = [row[round1Idx], row[round1Idx + 1], row[round1Idx + 2], row[round1Idx + 3]].filter(Boolean);
    for (let c = 0; c < choices.length; c++) {
      const cid = choices[c];
      if (used.indexOf(cid) !== -1) continue;
      if (capacity[co][4][cid] > 0) {
        row[round1Idx + 3] = cid;
        capacity[co][4][cid]--;
        round4Assigned++;
        break;
      }
    }
  }
  roundsAssigned += round4Assigned;

  let studentsIncomplete = 0;
  const now = new Date().toISOString();
  candidateIdx.forEach(function(i) {
    const row = values[i];
    const standardFull = row[round1Idx] && row[round1Idx + 1] && row[round1Idx + 2];
    if (!standardFull) studentsIncomplete++;
    else if (row[statusIdx] === "Pending" || row[statusIdx] === "Walk-in") row[statusIdx] = "Allocated";
    row[updatedIdx] = now;
  });

  studentsSheet.getRange(2, 1, values.length, STUDENTS_HEADERS.length).setValues(values);
  logActivity_(body.who, "run_allocation", "", roundsAssigned + " round-assignments (" + round4Assigned + " pre-approved spillover) across " + candidateIdx.length + " students, " + studentsIncomplete + " left incomplete (capacity or choice exhausted)");
  return { ok: true, roundsAssigned: roundsAssigned, round4Assigned: round4Assigned, studentsProcessed: candidateIdx.length, studentsIncomplete: studentsIncomplete };
}

// Registers many students from one paste of CSV-ish rows:
// name,classStream,cohort[,choice1,choice2,...]
// Used for teachers/interns running an in-class registration session. The
// Career Day ID is auto-assigned per row by registerStudent_ — nothing in
// the pasted text supplies or influences it.
// Each input row may carry a "clientId" — a client-generated PLACEHOLDER id
// the browser is showing locally before this call resolves (see
// provisionalStudentId_ in app.js). It is never stored anywhere; it's only
// echoed back paired with the real server-assigned id in `results` so the
// client can swap its placeholder for the real one row-by-row.
function bulkRegisterStudents_(body) {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  let created = 0;
  const errors = [];
  const results = [];
  rows.forEach(function(r) {
    const res = registerStudent_({
      name: r.name, classStream: r.classStream,
      cohort: r.cohort, choices: r.choices || "",
      teacherEmail: r.teacherEmail || "", teacherName: r.teacherName || "",
      who: body.who,
    });
    if (res.ok) {
      created++;
      results.push({ clientId: r.clientId || "", id: res.id });
    } else {
      errors.push((r.name || "?") + ": " + res.error);
    }
  });
  return { ok: true, created: created, total: rows.length, errors: errors, results: results };
}

// Logs a check-in (student or team member) to the Attendance sheet.
// Does not block on a "not found" ID — walk-ins and edge cases still get
// logged; the Dashboard can flag unmatched IDs for follow-up rather than
// silently refusing to record a scan on the day.
function checkIn_(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(ATTENDANCE_SHEET);
  const now = new Date().toISOString();
  const row = ATTENDANCE_HEADERS.map(function(h) {
    if (h === "timestamp") return now;
    return body[h] || "";
  });
  sheet.appendRow(row);
  logActivity_(body.who, "check_in", body.personId, (body.method || "") + " @ " + (body.room || ""));
  return { ok: true };
}

// Walk-in registration + immediate check-in, done as ONE server round trip.
// This exists specifically because the Career Day ID is now server-assigned
// (see registerStudent_/nextCareerDayId_) — the old client flow could
// predict an ID locally and check someone in with it instantly, but that's
// no longer possible. Combining both steps into a single action means there
// is only ever ONE id in play for a walk-in (never a client-guessed one that
// has to be reconciled later), and it stays correct even when this request
// sits in the offline sync queue for a while before it finally sends.
function registerWalkinAndCheckIn_(body) {
  const reg = registerStudent_({
    name: body.name,
    classStream: body.classStream,
    cohort: body.cohort,
    status: "Walk-in",
    notes: "Same-day walk-in registration",
    who: body.who,
  });
  if (!reg.ok) return reg;
  checkIn_({
    type: "Student",
    personId: reg.id,
    personName: body.name,
    round: body.round || "",
    room: body.room || "",
    method: "Walk-in",
    checkedInBy: body.who,
    who: body.who,
  });
  return { ok: true, id: reg.id, duplicateWarning: reg.duplicateWarning };
}

// Sends an update to a chosen segment, straight from the app, using the
// WG2 Google account the script is deployed under (no per-mentor email
// setup needed). Two segment types:
//  - "team": filters the Team sheet by zone/role/cluster (or "all") and
//    BCCs every matching, non-blank email — recipients never see each
//    other's addresses. Sent "to" the account owner so there's a reply-to.
//  - "class": a class shares ONE contact (teacherEmail on the Students
//    rows for that classStream+cohort, or one passed in directly) rather
//    than one email per student. If qrImages are supplied (built client-
//    side, since QR generation lives in the browser — see drawQr() in
//    app.js) they're embedded inline in the email via GmailApp so the
//    teacher sees exactly which code belongs to which learner, no mixup.
function sendSegmentEmail_(body, me) {
  const subject = (body.subject || "WG2 Boma Career Day 2026 update").trim();
  const message = body.message || "";
  const segmentType = body.segmentType;

  if (segmentType === "class") {
    // Matched by classStream alone, same as Schedule -> My Class elsewhere
    // in the app — cohort isn't part of the class picker there either.
    const classStream = (body.classStream || "").trim();
    const cohort = (body.cohort || "").trim();
    const classRows = readSheet_(STUDENTS_SHEET, STUDENTS_HEADERS).filter(function(r) {
      return r.classStream === classStream;
    });
    let teacherEmail = (body.teacherEmail || "").trim();
    if (!teacherEmail) {
      const withEmail = classRows.filter(function(r) { return r.teacherEmail; });
      teacherEmail = withEmail.length ? withEmail[0].teacherEmail : "";
    }
    if (!teacherEmail) {
      return { ok: false, error: "No class contact email on file for " + classStream + ". Add one via Register → Bulk Import, or type one in before sending." };
    }

    const images = Array.isArray(body.qrImages) ? body.qrImages : [];
    if (images.length) {
      const inlineImages = {};
      let htmlBody = "<p>" + escapeHtml_(message).replace(/\n/g, "<br>") + "</p><hr>";
      htmlBody += "<p>QR codes for <b>" + escapeHtml_(classStream) + "</b> — " +
        images.length + " student(s). Each code is unique to that student — please keep the right code matched to the right learner when printing/distributing.</p>";
      htmlBody += '<div>';
      images.forEach(function(img, i) {
        const cid = "qr" + i;
        const commaIdx = String(img.dataUrl || "").indexOf(",");
        const b64 = commaIdx !== -1 ? img.dataUrl.slice(commaIdx + 1) : img.dataUrl;
        const bytes = Utilities.base64Decode(b64);
        inlineImages[cid] = Utilities.newBlob(bytes, "image/png", (img.id || "qr" + i) + ".png");
        htmlBody += '<div style="display:inline-block;text-align:center;margin:8px;padding:8px;border:1px solid #ddd;vertical-align:top;">' +
          '<img src="cid:' + cid + '" style="width:140px;height:auto;display:block;"><br>' +
          '<b>' + escapeHtml_(img.name || "") + '</b><br>' +
          '<span style="font-size:11px;color:#666;">' + escapeHtml_(img.id || "") + '</span></div>';
      });
      htmlBody += '</div>';
      GmailApp.sendEmail(teacherEmail, subject, message + "\n\n(This email includes an HTML version with each student's QR code embedded — open it in a browser or email app that shows images if you don't see them.)", {
        htmlBody: htmlBody,
        inlineImages: inlineImages,
        name: SENDER_NAME,
        from: SENDER_EMAIL,
      });
    } else {
      MailApp.sendEmail({ to: teacherEmail, subject: subject, body: message, name: SENDER_NAME, from: SENDER_EMAIL });
    }
    logActivity_(body.who, "send_segment_email", classStream, "class -> " + teacherEmail + (images.length ? ", " + images.length + " QR code(s)" : ""));
    return { ok: true, sent: 1, recipients: [teacherEmail] };
  }

  // segmentType === "team"
  const filterField = body.filterField; // "zone" | "role" | "cluster" | "all"
  const filterValue = (body.filterValue || "").trim();

  // A Zone Coordinator (accessLevel "zone") can only email within their own
  // zone — "all" and cross-zone "role"/"cluster" sends stay Lead/Asst Lead
  // only, since those can reach outside the sender's own patch.
  if (me && me.accessLevel === "zone") {
    const myZoneLetter = zoneLetterOf_(me.zone);
    const requestedZoneLetter = filterField === "zone" ? zoneLetterOf_(filterValue) : "";
    const requestedClusterZone = filterField === "cluster" ? filterValue.charAt(0).toUpperCase() : "";
    const withinOwnZone =
      (filterField === "zone" && requestedZoneLetter === myZoneLetter) ||
      (filterField === "cluster" && requestedClusterZone === myZoneLetter);
    if (!withinOwnZone) {
      return { ok: false, error: "As a Zone Coordinator you can only send updates to your own zone (Zone " + myZoneLetter + ")." };
    }
  }

  const teamRows = readSheet_(TEAM_SHEET, TEAM_HEADERS);
  const matched = teamRows.filter(function(r) {
    if (filterField === "all") return true;
    if (filterField === "zone") return String(r.zone || "").toLowerCase().indexOf(filterValue.toLowerCase()) !== -1;
    if (filterField === "role") return r.role === filterValue;
    if (filterField === "cluster") return String(r.cluster || "").indexOf(filterValue) !== -1;
    return false;
  });
  const emails = matched.map(function(r) { return String(r.email || "").trim(); }).filter(Boolean);
  const uniqueEmails = emails.filter(function(e, i) { return emails.indexOf(e) === i; });
  if (!uniqueEmails.length) {
    return { ok: false, error: "No email addresses on file for that segment (" + matched.length + " matched, 0 had an email in the Team sheet)." };
  }

  const sender = (Session.getActiveUser() && Session.getActiveUser().getEmail()) || uniqueEmails[0];
  MailApp.sendEmail({ to: sender, bcc: uniqueEmails.join(","), subject: subject, body: message, name: SENDER_NAME, from: SENDER_EMAIL });
  logActivity_(body.who, "send_segment_email", filterField + ":" + filterValue, uniqueEmails.length + " recipient(s), " + matched.length + " matched");
  return { ok: true, sent: uniqueEmails.length, matched: matched.length };
}

// Emails a person their own QR code right after they register, if they gave
// an email address on the form (the mentor "Email" field, or the student
// "Student's own email" field). Any signed-in access level may call this —
// it only ever sends to the address the caller just typed into their own
// registration, never a name-based lookup of someone else's address, so
// there's nothing here for accessLevel to gate. Failures (bad address,
// Gmail quota, etc.) come back as {ok:false} rather than throwing, since a
// failed courtesy email should never look like the registration itself
// failed — the app already succeeded before this runs.
function emailOwnQr_(body) {
  const to = String(body.to || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return { ok: false, error: "Not a valid email address." };
  }
  const dataUrl = String(body.dataUrl || "");
  const commaIdx = dataUrl.indexOf(",");
  if (commaIdx === -1) return { ok: false, error: "No QR image supplied." };
  try {
    const bytes = Utilities.base64Decode(dataUrl.slice(commaIdx + 1));
    const blob = Utilities.newBlob(bytes, "image/png", (body.id || "qr") + ".png");
    const htmlBody =
      "<p>Hi " + escapeHtml_(body.name || "") + ",</p>" +
      "<p>Here's your QR code for WG2 Boma Career Day 2026. Save this email or download the code below — you'll need it to check in on the day.</p>" +
      '<div style="text-align:center;margin:16px 0;"><img src="cid:qr" width="220" height="220"><br>' +
      "<b>" + escapeHtml_(body.id || "") + "</b></div>";
    GmailApp.sendEmail(to, "Your WG2 Boma Career Day 2026 QR code",
      "Your QR code is attached — open this email in an app that shows images if you don't see it inline.",
      { htmlBody: htmlBody, inlineImages: { qr: blob }, name: SENDER_NAME, from: SENDER_EMAIL });
    logActivity_(body.who, "email_own_qr", body.id, to);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function escapeHtml_(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Shared "Open the App & Sign In" / "Change My PIN" button pair, dropped
// into every email that carries a PIN so recipients never have to hunt for
// the app URL or remember that a PIN change happens after signing in. The
// "Change My PIN" link carries ?intent=changepin, which the app reads on
// load (see maybeHandleDeepLinkIntent_ in app.js) — it auto-opens the
// account panel's PIN field once that person is signed in, prompting
// sign-in first via the normal name+PIN form if they aren't already.
function pinEmailButtonsHtml_() {
  const btn = function(label, href) {
    return '<a href="' + href + '" style="display:inline-block;background:#7A1319;color:#ffffff;' +
      'text-decoration:none;padding:10px 18px;border-radius:6px;font-family:Arial,sans-serif;' +
      'font-size:14px;font-weight:bold;margin:4px 10px 4px 0;">' + escapeHtml_(label) + "</a>";
  };
  return '<div style="margin:16px 0;">' +
    btn("Open the App & Sign In", APP_URL) +
    btn("Change My PIN", APP_URL + "?intent=changepin") +
    "</div>";
}

// Lead/Assistant Lead only (enforced in doPost before this is called).
// Changes another team member's access level and/or resets their pin. A
// pin reset immediately invalidates every token that person was already
// holding (see verifyToken_) — the standard way to revoke someone's access
// if they leave the team or a phone is lost.
function updateAccess_(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TEAM_SHEET);
  const row = findRowById_(sheet, TEAM_HEADERS, body.id);
  if (row === -1) return { ok: false, error: "Team member not found: " + body.id };
  const accessCol = TEAM_HEADERS.indexOf("accessLevel") + 1;
  const pinCol = TEAM_HEADERS.indexOf("pin") + 1;
  const nameCol = TEAM_HEADERS.indexOf("name") + 1;
  const phoneCol = TEAM_HEADERS.indexOf("phone") + 1;
  const emailCol = TEAM_HEADERS.indexOf("email") + 1;
  const modeCol = TEAM_HEADERS.indexOf("mode") + 1;
  const sessionLinkCol = TEAM_HEADERS.indexOf("sessionLink") + 1;
  const classStreamCol = TEAM_HEADERS.indexOf("classStream") + 1;
  const updatedCol = TEAM_HEADERS.indexOf("updatedAt") + 1;
  let newPin = "";
  if (body.accessLevel) sheet.getRange(row, accessCol).setValue(body.accessLevel);
  // name/phone: added so a Lead/Assistant Lead can fix someone else's
  // details from the same Team Access row as everything else, not just
  // access level/email/mode — the same fields update_my_details lets
  // people fix for themselves.
  if (body.name !== undefined) {
    const newName = String(body.name || "").trim();
    if (newName) sheet.getRange(row, nameCol).setValue(newName); // never blank out a name from here
  }
  if (body.phone !== undefined) sheet.getRange(row, phoneCol).setValue(String(body.phone || "").trim());
  if (body.email !== undefined) sheet.getRange(row, emailCol).setValue(String(body.email || "").trim());
  if (body.mode !== undefined) sheet.getRange(row, modeCol).setValue(String(body.mode || "In-person").trim());
  if (body.sessionLink !== undefined) sheet.getRange(row, sessionLinkCol).setValue(String(body.sessionLink || "").trim());
  if (body.classStream !== undefined) sheet.getRange(row, classStreamCol).setValue(String(body.classStream || "").trim());
  if (body.regeneratePin) {
    newPin = generatePin_();
    sheet.getRange(row, pinCol).setValue(newPin);
  } else if (body.pin) {
    newPin = String(body.pin).trim();
    sheet.getRange(row, pinCol).setValue(newPin);
  }
  sheet.getRange(row, updatedCol).setValue(new Date().toISOString());
  logActivity_(body.who, "update_access", body.id, (body.accessLevel ? "level->" + body.accessLevel + " " : "") + (newPin ? "(pin reset)" : ""));
  return { ok: true, pin: newPin || undefined };
}

// Self-service "My Details" — see update_my_details in doPost. Always
// scoped to me.id (the verified token owner), so the caller can never
// touch anyone else's row through this action no matter what id they send.
// Deliberately narrower than updateAccess_ above: no accessLevel/zone/
// cluster/classStream/pin here, since those affect what data someone can
// see, not just how to reach them — those stay Lead-controlled.
function updateMyDetails_(body, me) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TEAM_SHEET);
  const row = findRowById_(sheet, TEAM_HEADERS, me.id);
  if (row === -1) return { ok: false, error: "Couldn't find your record." };
  const nameCol = TEAM_HEADERS.indexOf("name") + 1;
  const phoneCol = TEAM_HEADERS.indexOf("phone") + 1;
  const emailCol = TEAM_HEADERS.indexOf("email") + 1;
  const updatedCol = TEAM_HEADERS.indexOf("updatedAt") + 1;
  if (body.name !== undefined) {
    const newName = String(body.name || "").trim();
    if (!newName) return { ok: false, error: "Name can't be blank." };
    sheet.getRange(row, nameCol).setValue(newName);
  }
  if (body.phone !== undefined) sheet.getRange(row, phoneCol).setValue(String(body.phone || "").trim());
  if (body.email !== undefined) sheet.getRange(row, emailCol).setValue(String(body.email || "").trim());
  sheet.getRange(row, updatedCol).setValue(new Date().toISOString());
  logActivity_(me.name, "update_my_details", me.id, "Self-updated contact details");
  return { ok: true, name: body.name !== undefined ? String(body.name).trim() : me.name };
}

// Self-service Mentor Database profile — see update_my_profile in doPost.
// Same "always scoped to me.id" pattern as updateMyDetails_ above: bio and
// yearsParticipated are harmless self-descriptive fields (not access-
// affecting like accessLevel/zone/cluster), so any signed-in room mentor can
// edit their own without needing a Lead, same reasoning as My Details.
function updateMyProfile_(body, me) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TEAM_SHEET);
  const row = findRowById_(sheet, TEAM_HEADERS, me.id);
  if (row === -1) return { ok: false, error: "Couldn't find your record." };
  const bioCol = TEAM_HEADERS.indexOf("bio") + 1;
  const yearsCol = TEAM_HEADERS.indexOf("yearsParticipated") + 1;
  const updatedCol = TEAM_HEADERS.indexOf("updatedAt") + 1;
  let bio = "";
  let years = "";
  if (body.bio !== undefined) {
    bio = String(body.bio || "").slice(0, 800).trim(); // gallery cards, not essays
    sheet.getRange(row, bioCol).setValue(bio);
  }
  if (body.yearsParticipated !== undefined) {
    years = String(body.yearsParticipated || "").slice(0, 120).trim();
    sheet.getRange(row, yearsCol).setValue(years);
  }
  sheet.getRange(row, updatedCol).setValue(new Date().toISOString());
  logActivity_(me.name, "update_my_profile", me.id, "Self-updated mentor profile");
  return { ok: true, bio: bio, yearsParticipated: years };
}

// Self-service profile photo upload — see upload_my_photo in doPost. Always
// writes to me.id's own photoUrl column, same scoping guarantee as
// updateMyProfile_/updateMyDetails_ above. Delegates the actual size/mime
// validation and Drive upload to saveProfilePhoto_.
function uploadMyPhoto_(body, me) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TEAM_SHEET);
  const row = findRowById_(sheet, TEAM_HEADERS, me.id);
  if (row === -1) return { ok: false, error: "Couldn't find your record." };
  let saved;
  try {
    saved = saveProfilePhoto_(body.photo);
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
  const photoCol = TEAM_HEADERS.indexOf("photoUrl") + 1;
  const updatedCol = TEAM_HEADERS.indexOf("updatedAt") + 1;
  sheet.getRange(row, photoCol).setValue(saved.url);
  sheet.getRange(row, updatedCol).setValue(new Date().toISOString());
  logActivity_(me.name, "upload_my_photo", me.id, "Self-updated profile photo");
  return { ok: true, photoUrl: saved.url };
}

// Soft-delete, used by both delete_my_account (self) and admin_delete_member
// (a Lead/Assistant Lead acting on someone else) — see doPost. Sets status
// to "Deleted" and clears the PIN, which together block sign-in (see the
// check in login_) without removing the row itself: task ownership,
// activity-log entries, and any place that references this person by name
// stay intact instead of going stale/orphaned. A Lead can reverse this any
// time via Team Access (set a new PIN + change status back), so nothing
// here is irreversible at the spreadsheet level, only at the sign-in level.
function deleteTeamAccount_(body, targetId, actingWho) {
  if (!targetId) return { ok: false, error: "No account specified." };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(TEAM_SHEET);
  const row = findRowById_(sheet, TEAM_HEADERS, targetId);
  if (row === -1) return { ok: false, error: "Team member not found." };
  const statusCol = TEAM_HEADERS.indexOf("status") + 1;
  const pinCol = TEAM_HEADERS.indexOf("pin") + 1;
  const updatedCol = TEAM_HEADERS.indexOf("updatedAt") + 1;
  sheet.getRange(row, statusCol).setValue("Deleted");
  sheet.getRange(row, pinCol).setValue("");
  sheet.getRange(row, updatedCol).setValue(new Date().toISOString());
  logActivity_(actingWho, "delete_team_account", targetId, "");
  return { ok: true };
}

// "all" access, or "zone" access scoped to their own zone's clusters
// (enforced in doPost before this is called).
function updateClusterRoom_(body, me) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CLUSTERS_SHEET);
  const row = findRowById_(sheet, CLUSTERS_HEADERS, body.id);
  if (row === -1) return { ok: false, error: "Cluster not found: " + body.id };
  if (me && me.accessLevel === "zone") {
    const clusters = readSheet_(CLUSTERS_SHEET, CLUSTERS_HEADERS);
    const target = clusters.find(function(c) { return c.id === body.id; });
    if (!target || target.zone !== zoneLetterOf_(me.zone)) {
      return { ok: false, error: "You can only update room assignments within your own zone." };
    }
  }
  const roomCol = CLUSTERS_HEADERS.indexOf("room") + 1;
  sheet.getRange(row, roomCol).setValue(body.room || "");
  logActivity_(body.who, "update_cluster_room", body.id, "-> " + body.room);
  return { ok: true };
}

// [{key,value,...}] -> {key: value}. Used by doGet so the client gets a
// plain object it can index straight into (settings.roomMapUrl) instead of
// searching an array every time.
function settingsToObject_(rows) {
  const obj = {};
  rows.forEach(function(r) { obj[r.key] = r.value; });
  return obj;
}

// Lead/Assistant Lead/Zone Coordinator/Intern (enforced in doPost). Adds
// the key if it doesn't exist yet, so a future new setting added to
// SEED_SETTINGS still works on a live sheet that predates it — same
// safety net as migrateHeaders_, but for rows instead of columns.
function updateSetting_(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SETTINGS_SHEET);
  const row = findRowById_(sheet, SETTINGS_HEADERS, body.key);
  const now = new Date().toISOString();
  if (row === -1) {
    sheet.appendRow([body.key, body.value || "", now]);
  } else {
    const valueCol = SETTINGS_HEADERS.indexOf("value") + 1;
    const updatedCol = SETTINGS_HEADERS.indexOf("updatedAt") + 1;
    sheet.getRange(row, valueCol).setValue(body.value || "");
    sheet.getRange(row, updatedCol).setValue(now);
  }
  logActivity_(body.who, "update_setting", body.key, "-> " + body.value);
  return { ok: true };
}

// Lead/Assistant Lead/Zone Coordinator only (enforced in doPost). No
// delete action on purpose — same "no destructive actions from the app"
// pattern used everywhere else (PIN reset instead of removing a person,
// etc.); fix a typo with update_class, or edit the Sheet directly for the
// rare case a class needs to be removed outright.
function addClass_(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CLASSES_SHEET);
  const existing = readSheet_(CLASSES_SHEET, CLASSES_HEADERS);
  let n = existing.length + 1;
  let newId = "C" + String(n).padStart(3, "0");
  const ids = existing.map(function(r) { return r.id; });
  while (ids.indexOf(newId) !== -1) { n++; newId = "C" + String(n).padStart(3, "0"); }
  const now = new Date().toISOString();
  sheet.appendRow([newId, body.cohort || "", body.name || "", now]);
  logActivity_(body.who, "add_class", newId, (body.cohort || "") + " " + (body.name || ""));
  return { ok: true, id: newId };
}

function updateClass_(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CLASSES_SHEET);
  const row = findRowById_(sheet, CLASSES_HEADERS, body.id);
  if (row === -1) return { ok: false, error: "Class not found: " + body.id };
  const nameCol = CLASSES_HEADERS.indexOf("name") + 1;
  const updatedCol = CLASSES_HEADERS.indexOf("updatedAt") + 1;
  sheet.getRange(row, nameCol).setValue(body.name || "");
  sheet.getRange(row, updatedCol).setValue(new Date().toISOString());
  logActivity_(body.who, "update_class", body.id, "-> " + body.name);
  return { ok: true };
}

// Lead/Assistant Lead/Zone Coordinator/Intern (enforced in doPost).
function updateScheduleSlot_(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SCHEDULE_SHEET);
  const row = findRowById_(sheet, SCHEDULE_HEADERS, body.id);
  if (row === -1) return { ok: false, error: "Schedule slot not found: " + body.id };
  const startCol = SCHEDULE_HEADERS.indexOf("startTime") + 1;
  const endCol = SCHEDULE_HEADERS.indexOf("endTime") + 1;
  const updatedCol = SCHEDULE_HEADERS.indexOf("updatedAt") + 1;
  sheet.getRange(row, startCol).setValue(body.startTime || "");
  sheet.getRange(row, endCol).setValue(body.endTime || "");
  sheet.getRange(row, updatedCol).setValue(new Date().toISOString());
  logActivity_(body.who, "update_schedule_slot", body.id, (body.startTime || "") + "-" + (body.endTime || ""));
  return { ok: true };
}

// Anyone signed in can submit feedback/report an issue. They can see their
// own submissions (and any reply) but not anyone else's — only "all"
// access sees the full list, via visibleFeedback_ on the read side.
function submitFeedback_(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureSheet_(ss, FEEDBACK_SHEET, FEEDBACK_HEADERS, []);
  const lastRow = sheet.getLastRow();
  const ids = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(function(r) { return r[0]; }) : [];
  let n = ids.length + 1;
  let newId = "FB" + String(n).padStart(3, "0");
  while (ids.indexOf(newId) !== -1) { n++; newId = "FB" + String(n).padStart(3, "0"); }
  const now = new Date().toISOString();
  sheet.appendRow([newId, now, body.who || "", body.category || "Other", body.screen || "", body.message || "", "Open", "", now]);
  logActivity_(body.who, "submit_feedback", newId, body.category || "");
  return { ok: true, id: newId };
}

// Lead/Assistant Lead only (enforced in doPost). Replies to and/or
// resolves a feedback item; the submitter will see the reply next time
// they load the app, since visibleFeedback_ always includes their own rows.
function resolveFeedback_(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(FEEDBACK_SHEET);
  const row = findRowById_(sheet, FEEDBACK_HEADERS, body.id);
  if (row === -1) return { ok: false, error: "Feedback item not found: " + body.id };
  const replyCol = FEEDBACK_HEADERS.indexOf("reply") + 1;
  const statusCol = FEEDBACK_HEADERS.indexOf("status") + 1;
  const updatedCol = FEEDBACK_HEADERS.indexOf("updatedAt") + 1;
  if (body.reply !== undefined) sheet.getRange(row, replyCol).setValue(body.reply);
  sheet.getRange(row, statusCol).setValue(body.status || "Resolved");
  sheet.getRange(row, updatedCol).setValue(new Date().toISOString());
  logActivity_(body.who, "resolve_feedback", body.id, body.status || "Resolved");
  return { ok: true };
}

// A single shared, global channel — anyone signed in can post or read it
// (see the "chat" key returned by doGet's default action). Not scoped by
// access level: it's for team-wide questions/answers, not sensitive data.
// ---------------------------------------------------------------------
// ATTACHMENTS — chat file uploads + Shared Team Files both go through
// this one helper. Files land in a single shared Drive folder (created
// automatically on first use, never a manual setup step) and are set to
// "anyone with the link can view" — team sign-in here is name+PIN, not a
// Google account, so per-account Drive sharing would leave most of the
// team unable to open their own teammates' files.
// ---------------------------------------------------------------------
function getAttachmentsFolder_() {
  const folders = DriveApp.getFoldersByName(ATTACHMENTS_FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(ATTACHMENTS_FOLDER_NAME);
}

// attachment: { name, dataUrl } where dataUrl is a browser-generated data
// URL ("data:<mimeType>;base64,<data>") from FileReader.readAsDataURL — see
// readFileAsDataUrl_ in app.js. Returns { url, name } or null if nothing
// (or nothing valid) was supplied — callers treat null as "no attachment",
// never an error, since most messages won't carry a file.
function saveAttachment_(attachment) {
  if (!attachment || !attachment.dataUrl || !attachment.name) return null;
  const dataUrl = String(attachment.dataUrl);
  const commaIdx = dataUrl.indexOf(",");
  if (commaIdx === -1) return null;
  const meta = dataUrl.slice(5, commaIdx); // e.g. "application/pdf;base64"
  const mimeType = (meta.split(";")[0] || "").trim() || "application/octet-stream";
  const bytes = Utilities.base64Decode(dataUrl.slice(commaIdx + 1));
  // Server-side enforcement of the size cap — never trust the client-side
  // check alone (see MAX_ATTACHMENT_BYTES above).
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new Error("Attachment too large (max " + Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024)) + "MB).");
  }
  const safeName = String(attachment.name).slice(0, 150) || "attachment";
  const blob = Utilities.newBlob(bytes, mimeType, safeName);
  const file = getAttachmentsFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { url: file.getUrl(), name: safeName };
}

// Mentor Database profile photos — same shared-Drive-folder pattern as
// saveAttachment_ above, but: (1) capped at MAX_PROFILE_PHOTO_BYTES (1MB,
// not 5MB — these are gallery thumbnails, not documents), (2) rejects
// non-image mime types outright (a profile "photo" that's actually a PDF
// would break the gallery's <img> rendering), and (3) returns a direct
// "uc?export=view" URL rather than the normal Drive "view" page URL, since
// that's the form an <img src="..."> tag can actually load — file.getUrl()
// (what saveAttachment_ returns) opens Drive's viewer page, not the raw
// image, and would render as a broken image in the gallery.
function saveProfilePhoto_(attachment) {
  if (!attachment || !attachment.dataUrl) throw new Error("No photo was provided.");
  const dataUrl = String(attachment.dataUrl);
  const commaIdx = dataUrl.indexOf(",");
  if (commaIdx === -1) throw new Error("That photo could not be read.");
  const meta = dataUrl.slice(5, commaIdx);
  const mimeType = (meta.split(";")[0] || "").trim() || "application/octet-stream";
  if (mimeType.indexOf("image/") !== 0) {
    throw new Error("Please upload an image file (JPG, PNG, etc).");
  }
  const bytes = Utilities.base64Decode(dataUrl.slice(commaIdx + 1));
  // Server-side enforcement — never trust the client-side 1MB check alone.
  if (bytes.length > MAX_PROFILE_PHOTO_BYTES) {
    throw new Error("Photo too large (max " + Math.round(MAX_PROFILE_PHOTO_BYTES / (1024 * 1024)) + "MB). Try a smaller or more compressed image.");
  }
  const safeName = String(attachment.name || "profile-photo").slice(0, 150) || "profile-photo";
  const blob = Utilities.newBlob(bytes, mimeType, safeName);
  const file = getAttachmentsFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { url: "https://drive.google.com/uc?export=view&id=" + file.getId(), name: safeName };
}

function postChat_(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureSheet_(ss, CHAT_SHEET, CHAT_HEADERS, []);
  const msg = String(body.message || "").trim();
  let att;
  try {
    att = saveAttachment_(body.attachment);
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
  if (!msg && !att) return { ok: false, error: "Empty message." };
  const lastRow = sheet.getLastRow();
  const ids = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(function(r) { return r[0]; }) : [];
  let n = ids.length + 1;
  let newId = "M" + String(n).padStart(4, "0");
  while (ids.indexOf(newId) !== -1) { n++; newId = "M" + String(n).padStart(4, "0"); }
  sheet.appendRow([newId, new Date().toISOString(), body.who || "", msg, att ? att.url : "", att ? att.name : ""]);
  return { ok: true, id: newId };
}

// Any signed-in person may DM any other signed-in person — there's no role
// restriction (Leads, Zone Coordinators, Interns, Mentors, Class Teachers
// can all message each other privately), same "everyone on the roster is a
// legitimate participant" reasoning as the existing broadcast Chat. Sender
// identity comes from the verified token (me), never body.fromId, so no one
// can send a DM as someone else.
function sendPrivateMessage_(body, me) {
  const toId = String(body.toId || "").trim();
  const msg = String(body.message || "").trim();
  let att;
  try {
    att = saveAttachment_(body.attachment);
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
  if (!msg && !att) return { ok: false, error: "Empty message." };
  if (!toId) return { ok: false, error: "No recipient chosen." };
  if (toId === me.id) return { ok: false, error: "You can't message yourself." };
  const team = readSheet_(TEAM_SHEET, TEAM_HEADERS);
  const recipient = team.find(function(t) { return t.id === toId; });
  if (!recipient) return { ok: false, error: "Recipient not found." };

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureSheet_(ss, PRIVATE_CHAT_SHEET, PRIVATE_CHAT_HEADERS, []);
  const lastRow = sheet.getLastRow();
  const ids = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(function(r) { return r[0]; }) : [];
  let n = ids.length + 1;
  let newId = "PM" + String(n).padStart(5, "0");
  while (ids.indexOf(newId) !== -1) { n++; newId = "PM" + String(n).padStart(5, "0"); }
  sheet.appendRow([newId, new Date().toISOString(), me.id, me.name, toId, recipient.name, msg, "No", att ? att.url : "", att ? att.name : ""]);
  return { ok: true, id: newId };
}

// Marks every message FROM body.fromId TO the caller as read — called when
// the caller opens that thread. Scoped to "me" from the verified token
// (never a toId passed in the body), so this can only ever mark the
// caller's OWN inbox as read, never anyone else's.
function markPrivateRead_(body, me) {
  const fromId = String(body.fromId || "").trim();
  if (!fromId) return { ok: false, error: "No conversation specified." };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(PRIVATE_CHAT_SHEET);
  if (!sheet) return { ok: true, updated: 0 };
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, updated: 0 };
  const values = sheet.getRange(2, 1, lastRow - 1, PRIVATE_CHAT_HEADERS.length).getValues();
  const fromIdx = PRIVATE_CHAT_HEADERS.indexOf("fromId");
  const toIdx = PRIVATE_CHAT_HEADERS.indexOf("toId");
  const readIdx = PRIVATE_CHAT_HEADERS.indexOf("readByRecipient");
  let updated = 0;
  values.forEach(function(row, i) {
    if (row[fromIdx] === fromId && row[toIdx] === me.id && row[readIdx] !== "Yes") {
      sheet.getRange(2 + i, readIdx + 1).setValue("Yes");
      updated++;
    }
  });
  return { ok: true, updated: updated };
}

// Server-enforced membership, not just client-side filtering — posting to a
// group you're not actually in (by role/zone/accessLevel, computed fresh
// via myGroupIds_) is rejected here regardless of what groupId the client
// sends.
function postGroupMessage_(body, me) {
  const groupId = String(body.groupId || "").trim();
  const msg = String(body.message || "").trim();
  let att;
  try {
    att = saveAttachment_(body.attachment);
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
  if (!msg && !att) return { ok: false, error: "Empty message." };
  if (myGroupIds_(me).indexOf(groupId) === -1) {
    return { ok: false, error: "You're not a member of that group." };
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureSheet_(ss, GROUP_CHAT_SHEET, GROUP_CHAT_HEADERS, []);
  const lastRow = sheet.getLastRow();
  const ids = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(function(r) { return r[0]; }) : [];
  let n = ids.length + 1;
  let newId = "GM" + String(n).padStart(5, "0");
  while (ids.indexOf(newId) !== -1) { n++; newId = "GM" + String(n).padStart(5, "0"); }
  sheet.appendRow([newId, new Date().toISOString(), groupId, me.name, me.id, msg, att ? att.url : "", att ? att.name : ""]);
  return { ok: true, id: newId };
}

// ---------------------------------------------------------------------
// SHARED TEAM FILES — a standing library, independent of any one chat
// thread. Core team only (same audience as canViewDocs() on the client),
// enforced here too since the client gate is convenience only.
// ---------------------------------------------------------------------
function uploadTeamFile_(body, me) {
  if (me.role === "Mentor") return { ok: false, error: "Only core team members can upload shared files." };
  let att;
  try {
    att = saveAttachment_(body.attachment);
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
  if (!att) return { ok: false, error: "No file supplied." };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureSheet_(ss, TEAM_FILES_SHEET, TEAM_FILES_HEADERS, []);
  const lastRow = sheet.getLastRow();
  const ids = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(function(r) { return r[0]; }) : [];
  let n = ids.length + 1;
  let newId = "TF" + String(n).padStart(5, "0");
  while (ids.indexOf(newId) !== -1) { n++; newId = "TF" + String(n).padStart(5, "0"); }
  sheet.appendRow([newId, new Date().toISOString(), me.name, me.id, att.name, att.url, String(body.description || "").trim()]);
  logActivity_(me.name, "upload_team_file", newId, att.name);
  return { ok: true, id: newId, url: att.url };
}

// ---------------------------------------------------------------------
// OUTPUT HELPER
// ---------------------------------------------------------------------
function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
