// ---------------------------------------------------------------------
// WG2 Team & Tasks — app logic (no framework, no build step)
// ---------------------------------------------------------------------
(function () {
  "use strict";

  const CFG = window.APP_CONFIG || {};
  const API_URL = (CFG.API_URL || "").trim();
  const DEMO_MODE = !API_URL;

  // Client-side guard for chat/Team-Files attachments — the real cap is
  // enforced server-side too (MAX_ATTACHMENT_BYTES in Code.gs); this one
  // just avoids reading and base64-encoding a huge file only to have the
  // server reject it after the round trip.
  const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5MB

  const state = {
    team: [],
    tasks: [],
    students: [],
    attendance: [],
    clusters: [],
    fetchedAt: null,
    activeTab: "tasks",
    taskFilters: { phase: "All", state: "All", q: "" },
    teamFilters: { role: "All", q: "" },
    who: localStorage.getItem("wg2_whoami") || "", // demo-mode-only cosmetic label; live mode uses state.session.name instead
    session: null, // { memberId, name, role, accessLevel, zone, cluster, token } — set on successful login, null until then
    openTaskId: null,
    openTeamId: null,
    regType: "student",
    checkinMode: "scan",
    scheduleMode: "find",
    capacityFilter: "all",
    mentorOpsZone: "All",
    scanStream: null,
    scanLoopId: null,
    scanning: false,
    pendingCheckin: null, // { type, id, name }
    syncQueue: [], // writes made while offline, replayed in order once back online
    lastSyncNote: "",
    lastBulkBatch: null, // { students, teacherEmail, teacherName } — most recent bulk import, for the Print/Email buttons right after it
    feedback: [],
    chat: [],
    helpTab: "feedback",
    settings: {},
    classes: [],
    schedule: [],
    mentorApplications: [], // admin-only, loaded separately — see refreshMentorApplications
    classPaneAutoApplied: false, // true once we've auto-selected a signed-in Class Teacher's own class in My Class, so it doesn't keep snapping back after they browse elsewhere
    privateChat: [], // this person's DMs only (server-filtered — see visiblePrivateChat_)
    dmActiveWith: null, // { id, name } of the open conversation, or null (showing the conversation list)
    mentorSurveyMine: null,
    mentorSurveyResponses: [], // admin-only, populated by loadMentorSurvey
    myGroups: [], // group ids this person belongs to (server-computed — see myGroupIds_)
    groupChat: [], // messages across those groups only
    activeGroup: null, // group id of the open thread, or null (showing the group list)
    mentorDatabase: [], // ops-only (all/zone/intern), loaded separately — see loadMentorDatabase
    mentorDbShowCount: 30, // how many filtered rows to render — "Show more" grows this, any filter change resets it
    reportSource: "students", // Reports tab — see REPORT_SOURCES/renderReportsTab_
    reportColumns: null, // null = all columns for the current source
    reportSort: { col: null, dir: 1 },
    reportRows: [], // last computed result set — kept for re-sorting and CSV export without recomputing
    reportPreviewMode: "table", // Reports tab preview — "table" | "chart" | "text", see renderReportPreview_
    teamFiles: [], // Shared Team Files — core-team only, loaded when the Docs tab opens (see loadTeamFiles_)
    staffDirectory: [], // Live Lead/Assistant Lead/Zone Coordinator/Intern roster — core-team only, see loadStaffDirectory_
    pendingAttachment: { chat: null, dm: null, group: null }, // File objects staged for the next send in each chat context — see wireAttachInput_
    clusterCommandExpanded: {}, // { [clusterId]: true } — which Cluster Command Center cards are expanded; shared by the Dashboard and Intern My Day renders of the same component
    careerQuiz: { step: 0, answers: [], selectedCareerIds: [] }, // Discover Your Career quiz — see resetCareerQuizState_
    pendingQuizCareerIds: null, // quiz picks awaiting the registration picker to finish loading — see applyPendingQuizChoicesIfAny_
  };

  function accessLevel() {
    return (state.session && state.session.accessLevel) || (DEMO_MODE ? "all" : "cluster");
  }
  function isAdmin() {
    return accessLevel() === "all";
  }
  function canManageZone() {
    return accessLevel() === "all" || accessLevel() === "zone";
  }
  function isIntern() {
    return accessLevel() === "intern";
  }
  function isClassTeacher() {
    return accessLevel() === "class";
  }
  // "Operational" access — Leads, Assistant Leads, Zone Coordinators, and
  // Interns. Mirrors the server-side gating on update_cluster_room/
  // update_setting/update_schedule_slot — these are room/logistics jobs
  // that get delegated to interns, not just a Lead-only concern. Explicitly
  // NOT "everyone except cluster": Class Teachers ("class" access) are
  // scoped to their own class, not event-wide room/schedule logistics.
  function canManageOps() {
    const lvl = accessLevel();
    return lvl === "all" || lvl === "zone" || lvl === "intern";
  }

  // Narrower than canManageOps on purpose — mirrors the server-side gate on
  // set_student_spillover in Code.gs (Lead/Assistant Lead/Zone Coordinator
  // only, NOT Intern). Approving a student's optional 4th round is WG2
  // privately arranging a specific mentor/cluster ahead of time, a judgment
  // call kept one notch narrower than the room/logistics jobs interns
  // handle.
  function canApproveSpillover() {
    const lvl = accessLevel();
    return lvl === "all" || lvl === "zone";
  }

  // Core-team gate for the Docs & Orientation tab (Playbook + SOPs). This is
  // deliberately keyed off role, not accessLevel: a plain Mentor and a
  // Cluster Lead/Sub-Lead can share the same accessLevel ("cluster"), but
  // Mentors are explicitly NOT meant to see these documents while
  // Cluster Leads/Sub-Leads and every other team role are. Defaults closed
  // (no session, or role not yet set, hides the tab) so a Mentor account
  // never sees a flash of gated content before the role loads.
  function canViewDocs() {
    return !!(state.session && state.session.role && state.session.role !== "Mentor");
  }

  const COHORT_TARGETS = { F4: 450, G10A: 398, G10B: 398 };
  const COHORT_LABELS = { F4: "Form 4", G10A: "Grade 10 — Group A", G10B: "Grade 10 — Group B" };
  // Zone letter -> theme, shown alongside "Zone X" wherever a zone is
  // picked, so people know at a glance what a zone actually focuses on
  // (matches the Key Contacts naming already used in the Mentor Handbook).
  const ZONE_NAMES = {
    A: "Health, Medicine & Human Performance",
    B: "Engineering, Technology, Earth & Life Sciences (STEM)",
    C: "Business, Finance, Trade & Leadership",
    D: "Law, Governance, Public Service & Faith",
    E: "Creative Industries, Media, Hospitality & Built Environment",
  };
  const REG_OPEN = new Date("2026-08-15T00:00:00");
  const REG_CLOSE = new Date("2026-08-20T23:59:59");

  // Fallback cluster catalog for the public (no-sign-in) Mentor Registration
  // screen — used only in DEMO_MODE (no backend to ask) or if the live
  // "clusters_public" fetch fails, so the dropdown never shows up empty.
  // Mirrors the Clusters sheet's SEED_CLUSTERS in Code.gs; if a cluster is
  // ever renamed there, update it here too so the two stay in sync.
  const CLUSTER_CATALOG = [
    { id: "A1", zone: "A", name: "Medical Practitioners" },
    { id: "A2", zone: "A", name: "Public Health & Psychosocial Services" },
    { id: "A3", zone: "A", name: "Sports Science & Physical Fitness" },
    { id: "B1", zone: "B", name: "Computing, Data & Cyber Sciences" },
    { id: "B2", zone: "B", name: "Engineering & Manufacturing" },
    { id: "B3", zone: "B", name: "Earth Sciences, Energy & Mining" },
    { id: "B4", zone: "B", name: "Environment & Conservation" },
    { id: "B5", zone: "B", name: "Agriculture, Food & Agribusiness" },
    { id: "B6", zone: "B", name: "Aviation, Aerospace & Maritime" },
    { id: "C1", zone: "C", name: "Finance & Actuarial Sciences" },
    { id: "C2", zone: "C", name: "Entrepreneurship & Innovation" },
    { id: "C3", zone: "C", name: "Leadership & Strategic/HR Management" },
    { id: "C4", zone: "C", name: "Supply Chain, Logistics & Procurement" },
    { id: "C5", zone: "C", name: "Marketing, PR, Sales, Comms & CX" },
    { id: "D1", zone: "D", name: "Legal Practitioners" },
    { id: "D2", zone: "D", name: "Int'l Relations, Development & Governance" },
    { id: "D3", zone: "D", name: "Uniformed & National Security Services" },
    { id: "D4", zone: "D", name: "Theology & Pastoral Care" },
    { id: "D5", zone: "D", name: "Education" },
    { id: "E1", zone: "E", name: "Journalism & The Media" },
    { id: "E2", zone: "E", name: "Hospitality & Tourism" },
    { id: "E3", zone: "E", name: "The Arts — Applied, Visual, Performing & Literary" },
    { id: "E4", zone: "E", name: "The Built Environment & Real Estate" },
  ];

  // Fallback career catalog — used only in DEMO_MODE or if the live
  // "careers_public"/"careers" fetch fails, so the student-facing career
  // picker never shows up empty. Mirrors SEED_CAREERS in Code.gs — name and
  // description are taken verbatim from "Your Career Guide" and its "Career
  // Briefs Addendum" (the two official WG2 PDFs also offered to students as
  // downloads — see the Careers & Clusters Guide screen), so the app never
  // shows a career under wording that conflicts with those documents. If a
  // career or its cluster mapping ever changes in Code.gs, update it here too.
  const CAREER_CATALOG = [
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

  // -----------------------------------------------------------------------
  // DISCOVER YOUR CAREER — "AI Career Guide" interest quiz for students. No
  // sign-in required (see careerQuizScreen), reachable from the login
  // screen and from mid-registration (openCareersGuideBtnInline's sibling
  // link). Every question option is weighted toward specific cluster ids;
  // answering all 10 sums those weights into a ranked list of all 23
  // clusters (see computeCareerQuizResults_) — same clusters/careers as
  // the real registration picker, so a fun result always turns into a real,
  // actionable choice, not a dead end. CLUSTER_QUIZ_INSIGHTS_ supplies the
  // "why this fits you" / "subjects to focus on" copy per cluster; example
  // careers on the result screen are pulled live from CAREER_CATALOG (or
  // the live careers_public fetch — see cqData_) so they never drift out of
  // sync with the real catalog.
  // -----------------------------------------------------------------------
  const CAREER_QUIZ_QUESTIONS_ = [
    {
      q: "Pick a Saturday afternoon:",
      options: [
        { text: "Taking apart a gadget to see how it works, then rebuilding it better", weights: { B2: 3, B1: 2, B6: 1 } },
        { text: "Volunteering at a clinic or helping a sick neighbour", weights: { A1: 3, A2: 2 } },
        { text: "Organising a fundraiser or small business pop-up with friends", weights: { C2: 3, C4: 1, C5: 1 } },
        { text: "Rehearsing a play, a dance, or a music performance — or sketching, or editing a video", weights: { E3: 3, E1: 1 } },
        { text: "Hiking, birdwatching, or planting something in the garden", weights: { B4: 3, B5: 1, A3: 1 } },
      ],
    },
    {
      q: "In a group project, you're usually the one who…",
      options: [
        { text: "Crunches the numbers and checks everyone's budget makes sense", weights: { C1: 3, C4: 1 } },
        { text: "Keeps everyone on schedule and settles arguments fairly", weights: { C3: 3, D1: 1 } },
        { text: "Comes up with the wild idea nobody else thought of", weights: { C2: 3, E3: 1 } },
        { text: "Researches the facts so the group doesn't get anything wrong", weights: { D2: 2, B1: 1, E1: 1 } },
        { text: "Makes sure the youngest or quietest person in the room understands what's going on", weights: { A2: 2, D4: 1, D5: 2 } },
      ],
    },
    {
      q: "Which subject do you secretly enjoy the homework for?",
      options: [
        { text: "Biology or Chemistry", weights: { A1: 3, A2: 1, B5: 1 } },
        { text: "Mathematics or Computer Studies", weights: { B1: 3, C1: 2 } },
        { text: "Business Studies or Economics", weights: { C2: 2, C1: 1, C4: 1 } },
        { text: "History, CRE, or Geography", weights: { D2: 2, D4: 1, D5: 1 } },
        { text: "English, Kiswahili, Art & Design, or Music", weights: { E1: 2, E3: 2 } },
      ],
    },
    {
      q: "A stranger needs help on the street. What's your instinct?",
      options: [
        { text: "Check if they're physically hurt first", weights: { A1: 3, A3: 1 } },
        { text: "Ask what happened and really listen", weights: { A2: 2, D4: 2 } },
        { text: "Direct traffic or manage the crowd so it's safe", weights: { D3: 3, C3: 1 } },
        { text: "Figure out the fastest, most efficient way to solve it", weights: { C4: 2, B2: 1, C2: 1 } },
        { text: "Film it or write it up so people know what's happening", weights: { E1: 3 } },
      ],
    },
    {
      q: "Pick a place you'd love to spend a whole day:",
      options: [
        { text: "A hospital ward or a physiotherapy clinic", weights: { A1: 3, A3: 1 } },
        { text: "A construction site or an architecture studio", weights: { E4: 3, B2: 1 } },
        { text: "An airport control tower or a ship's bridge", weights: { B6: 3 } },
        { text: "A courtroom or a government office", weights: { D1: 3, D2: 1 } },
        { text: "A farm, a game reserve, or a research field station", weights: { B5: 2, B4: 2 } },
        { text: "A geothermal plant, a mine, or an oil & gas exploration site", weights: { B3: 3 } },
        { text: "A bank, a stock exchange floor, or an actuary's office", weights: { C1: 3 } },
      ],
    },
    {
      q: "What would make you proudest at your 10-year reunion?",
      options: [
        { text: "Running my own company", weights: { C2: 3, C4: 1 } },
        { text: "Having genuinely helped hundreds of people heal or cope", weights: { A1: 2, A2: 2 } },
        { text: "Being the person people trust to lead a team", weights: { C3: 3 } },
        { text: "Having built or fixed something that's still standing, still used", weights: { B2: 2, E4: 2 } },
        { text: "Having told a story that changed how people saw an issue", weights: { E1: 2, E3: 1, D2: 1, C5: 1 } },
      ],
    },
    {
      q: "Which of these headlines would you click first?",
      options: [
        { text: "\"New vaccine trial shows promising results\"", weights: { A1: 2, A2: 1 } },
        { text: "\"Local startup raises funding after viral pitch\"", weights: { C2: 3, C5: 1 } },
        { text: "\"Kenya's forest cover hits new record — how they did it\"", weights: { B4: 3 } },
        { text: "\"Inside the cockpit: a day with a commercial pilot\"", weights: { B6: 3 } },
        { text: "\"How this small hotel became a 5-star destination\"", weights: { E2: 3 } },
        { text: "\"This ad campaign made a brand go viral overnight\"", weights: { C5: 3 } },
      ],
    },
    {
      q: "Your friends would describe you as…",
      options: [
        { text: "The calm one who stays steady under pressure", weights: { D3: 2, A1: 1 } },
        { text: "The organiser who never loses a WhatsApp poll", weights: { C3: 2, C4: 1 } },
        { text: "The creative one always making something", weights: { E3: 3 } },
        { text: "The logical one who fact-checks everything", weights: { B1: 2, D1: 1 } },
        { text: "The warm one everyone tells their problems to", weights: { A2: 2, D4: 2, D5: 2 } },
      ],
    },
    {
      q: "If money were no object, what would you study just for fun?",
      options: [
        { text: "Astronomy, engineering, or what's inside the Earth (rocks, energy, mining)", weights: { B2: 2, B1: 1, B3: 2 } },
        { text: "Nutrition, sports science, or the human body", weights: { A3: 3, A1: 1 } },
        { text: "Languages, cultures, and how countries get along", weights: { D2: 3 } },
        { text: "Cooking, hospitality, or event design", weights: { E2: 3 } },
        { text: "Law, debate, or how justice systems work", weights: { D1: 3 } },
      ],
    },
    {
      q: "Pick your dream Saturday job (just for the vibe):",
      options: [
        { text: "Tour guide showing visitors the best of Kenya", weights: { E2: 2, D2: 1 } },
        { text: "Sports coach or team trainer", weights: { A3: 3 } },
        { text: "Radio or TV presenter", weights: { E1: 3 } },
        { text: "Running a small farm stand or food stall", weights: { B5: 3, C2: 1 } },
        { text: "Youth pastor or counsellor at a church camp", weights: { D4: 3, A2: 1 } },
        { text: "Running a free tutoring session for younger students", weights: { D5: 3 } },
      ],
    },
  ];

  // Per-cluster quiz result copy — a fun archetype name + emoji, why the
  // cluster fits someone who leans this way, and the subjects worth paying
  // close attention to for that path. Deliberately short (this is a result
  // card, not a brief) — the full detail already lives in the Careers &
  // Clusters Guide / the two official PDFs, both linked from the result
  // screen. Subjects use standard KCSE/CBC subject names.
  const CLUSTER_QUIZ_INSIGHTS_ = {
    A1: { archetype: "The Healer", emoji: "🩺", fit: "You're drawn to the human body and the satisfaction of directly fixing what's wrong — diagnosing, easing pain, or saving a life. This path rewards steady hands, a strong stomach, and years of patient study.", subjects: ["Biology", "Chemistry", "Mathematics", "English"] },
    A2: { archetype: "The Community Carer", emoji: "🤝", fit: "You care less about one dramatic case and more about lifting the whole room — a community's health, a family's wellbeing, or a friend's mental state on a hard day.", subjects: ["Biology", "Chemistry", "English / Kiswahili", "CRE / Social Studies"] },
    A3: { archetype: "The Performance Coach", emoji: "🏃", fit: "You're fascinated by how the body performs under pressure — and you love pushing people (including yourself) to get stronger, faster, or healthier.", subjects: ["Biology", "Physical Education", "Chemistry", "Mathematics"] },
    B1: { archetype: "The Digital Architect", emoji: "💻", fit: "You think in logic and patterns, and you'd rather build the system than just use it. A bug doesn't frustrate you — it's a puzzle you haven't solved yet.", subjects: ["Mathematics", "Computer Studies", "Physics", "English"] },
    B2: { archetype: "The Builder", emoji: "🔧", fit: "You want to see how things actually work — then make them work better. Give you a problem with moving parts and you're still thinking about it at dinner.", subjects: ["Mathematics", "Physics", "Chemistry", "Computer Studies"] },
    B3: { archetype: "The Resource Explorer", emoji: "⛏️", fit: "You're curious about what's beneath our feet and how to power the world responsibly — rocks, minerals, oil, gas, and the next generation of energy.", subjects: ["Geography", "Chemistry", "Physics", "Mathematics"] },
    B4: { archetype: "The Guardian", emoji: "🌿", fit: "You feel a real pull toward protecting the natural world — wildlife, forests, water, climate — and want a career that leaves the planet better than you found it.", subjects: ["Biology", "Geography", "Chemistry", "English"] },
    B5: { archetype: "The Grower", emoji: "🌾", fit: "You see farming and food as one of the biggest problems — and businesses — of our time: feeding people, running a farm smartly, or building the supply chain behind dinner.", subjects: ["Biology", "Agriculture", "Chemistry", "Business Studies"] },
    B6: { archetype: "The Navigator", emoji: "✈️", fit: "Planes, ships, and the systems that move the world excite you. You want precision, big machines, and the kind of job most people only dream about.", subjects: ["Physics", "Mathematics", "Geography", "English"] },
    C1: { archetype: "The Numbers Strategist", emoji: "📊", fit: "Numbers calm you down, not stress you out. You like predicting risk, growing money responsibly, and being the person a company trusts with the books.", subjects: ["Mathematics", "Business Studies", "Economics", "English"] },
    C2: { archetype: "The Founder", emoji: "🚀", fit: "You don't wait for permission — you see a gap and want to build something to fill it. Risk excites you more than it scares you.", subjects: ["Business Studies", "Mathematics", "English", "Computer Studies"] },
    C3: { archetype: "The People Leader", emoji: "🧭", fit: "You're the one who naturally organises the group, settles disputes, and gets people rowing in the same direction — leadership isn't a title to you, it's a habit.", subjects: ["Business Studies", "English", "Mathematics", "CRE / Social Studies"] },
    C4: { archetype: "The Systems Fixer", emoji: "📦", fit: "You think in efficiency — how do things get from A to B faster, cheaper, and without anything going missing? Behind-the-scenes problem-solving is your happy place.", subjects: ["Mathematics", "Business Studies", "Geography", "Computer Studies"] },
    C5: { archetype: "The Storyteller-Strategist", emoji: "📣", fit: "You understand what makes people click, buy, or believe something — and you love the challenge of making a message land.", subjects: ["English", "Business Studies", "Art & Design", "Kiswahili"] },
    D1: { archetype: "The Advocate", emoji: "⚖️", fit: "You argue to win — respectfully — and you have a strong sense of fairness. Rules and evidence excite you more than they bore you.", subjects: ["English", "History & Government", "Mathematics", "Kiswahili"] },
    D2: { archetype: "The Bridge Builder", emoji: "🌍", fit: "You think beyond Kenya's borders — how countries work together, how development actually happens, and how policy changes real lives.", subjects: ["History & Government", "Geography", "English", "CRE"] },
    D3: { archetype: "The Protector", emoji: "🛡️", fit: "You stay calm when things get tense, and you feel a real duty to keep people safe — structure and discipline don't scare you, they suit you.", subjects: ["Physical Education", "English", "Mathematics", "CRE / Social Studies"] },
    D4: { archetype: "The Shepherd", emoji: "🕊️", fit: "You're the one people quietly come to when life gets hard, and you find real meaning in faith, service, and walking with others through difficulty.", subjects: ["CRE", "English", "History", "Kiswahili"] },
    D5: { archetype: "The Mentor-in-Training", emoji: "📚", fit: "You already like explaining things until they click for someone else — teaching isn't just a job to you, it's basically what you do for fun.", subjects: ["English", "Mathematics", "Your strongest subject", "CRE / Social Studies"] },
    E1: { archetype: "The Truth-Teller", emoji: "🎙️", fit: "You want to know what's really going on — and you want to tell everyone else. Curiosity and a good sentence are your favourite tools.", subjects: ["English", "Kiswahili", "History", "Computer Studies"] },
    E2: { archetype: "The Host", emoji: "🌴", fit: "You light up making someone else's experience unforgettable — a meal, a trip, or a whole event.", subjects: ["English", "Geography", "Business Studies", "Kiswahili"] },
    E3: { archetype: "The Creator", emoji: "🎭", fit: "\"The Arts\" here is much bigger than drawing and painting — it covers acting and drama, music and dance, sculpture, design, photography, film, and creative writing. If you need to MAKE something and come alive performing, painting, playing an instrument, or writing, this is your cluster.", subjects: ["Art & Design", "Music", "Drama / Theatre", "English or Kiswahili (creative writing)"] },
    E4: { archetype: "The Placemaker", emoji: "🏗️", fit: "You notice buildings and spaces the way other people notice outfits — and you want to be the one designing, building, or developing them.", subjects: ["Mathematics", "Physics", "Art & Design", "Geography"] },
  };

  // ---- DOM refs ----
  const $ = (id) => document.getElementById(id);
  const statusLine = $("statusLine");
  const demoBanner = $("demoBanner");
  const syncIndicator = $("syncIndicator");
  const whoamiBtn = $("whoamiBtn");

  // ---------------------------------------------------------------------
  // DATA LOADING
  // ---------------------------------------------------------------------
  function apiGet(action) {
    const token = state.session ? encodeURIComponent(state.session.token) : "";
    const url = API_URL + (API_URL.indexOf("?") === -1 ? "?" : "&") + "action=" + action + "&token=" + token;
    return fetch(url).then((r) => r.json());
  }

  // Every write goes through here. If the network is down (or the request
  // fails for a connectivity reason), the write is queued to localStorage
  // and replayed in order once the connection comes back — see the SYNC
  // QUEUE block below. This is what makes Check-In safe to use with a spotty
  // signal on event day (Playbook Section 19.4): a scan never just vanishes.
  function apiPost(body) {
    body.who = (state.session && state.session.name) || state.who || "Someone";
    body.token = state.session ? state.session.token : "";
    if (!navigator.onLine) {
      return Promise.resolve(queueWrite(body));
    }
    return fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // avoids CORS preflight
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .catch(() => queueWrite(body)); // fetch threw — treat as offline, not a lost write
  }

  // ---------------------------------------------------------------------
  // SYNC QUEUE — offline-safe writes
  // ---------------------------------------------------------------------
  function loadQueue() {
    try {
      const raw = localStorage.getItem("wg2_sync_queue");
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }
  function persistQueue() {
    try {
      localStorage.setItem("wg2_sync_queue", JSON.stringify(state.syncQueue));
    } catch (e) {}
  }
  function queueWrite(body) {
    state.syncQueue.push({ queuedAt: new Date().toISOString(), body });
    persistQueue();
    renderSyncIndicator();
    return { ok: true, queued: true };
  }

  let flushing = false;
  function flushQueue() {
    if (DEMO_MODE || flushing || !state.syncQueue.length || !navigator.onLine || !state.session) return;
    flushing = true;
    const item = state.syncQueue[0];
    item.body.token = state.session.token; // always retry under the CURRENT session, in case it was refreshed since queuing
    item.body.who = state.session.name;
    fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(item.body),
    })
      .then((r) => r.json())
      .then((res) => {
        if (res && res.error === "AUTH_REQUIRED") {
          // Session died (pin was reset, etc.) — pause the queue rather than
          // drop it. It resumes automatically once this person signs in
          // again; nothing is lost in the meantime.
          flushing = false;
          return;
        }
        if (res && res.ok === false) {
          // Server actively rejected it for a real data reason (not auth,
          // not connectivity) — don't retry forever, but don't lose it
          // silently either.
          console.warn("Queued write rejected by server, dropping:", item.body, res.error);
        }
        state.syncQueue.shift();
        persistQueue();
        flushing = false;
        renderSyncIndicator();
        if (state.syncQueue.length) flushQueue();
        else refresh(false); // pull the now-authoritative server state once caught up
      })
      .catch(() => {
        flushing = false; // still offline / flaky — next timer tick or 'online' event retries
      });
  }

  // Re-applies any not-yet-synced writes on top of freshly loaded data, so a
  // reload while offline (or before the queue has drained) doesn't make a
  // pending check-in or registration seem to disappear from the UI. Keyed to
  // be safe to call on every refresh without creating duplicates.
  function applyQueuedOverlay() {
    state.syncQueue.forEach((item) => {
      const b = item.body;
      if (b.action === "check_in") {
        const already = state.attendance.some((a) => a.personId === b.personId && a.timestamp === b.timestamp);
        if (!already) state.attendance.unshift(b);
      } else if (b.action === "register_student") {
        // Career Day IDs are server-assigned, so a still-queued write can
        // only be re-shown under the client-side PLACEHOLDER id it was
        // given at submit time (b.clientId — see provisionalStudentId_ in
        // submitStudentForm). It's replaced by the real id the moment this
        // item actually syncs and refresh() pulls the authoritative record.
        const id = b.clientId;
        if (id && !state.students.some((s) => s.id === id)) {
          state.students.push({
            id, name: b.name, admissionNo: "", classStream: b.classStream, cohort: b.cohort, choices: b.choices || "",
            round1: "", round2: "", round3: "", round4: "", status: "Pending", notes: "",
            teacherEmail: b.teacherEmail || "", teacherName: "",
          });
        }
      } else if (b.action === "bulk_register_students") {
        (b.rows || []).forEach((r) => {
          const id = r.clientId;
          if (id && !state.students.some((s) => s.id === id)) {
            state.students.push({
              id, name: r.name, admissionNo: "", classStream: r.classStream, cohort: r.cohort, choices: r.choices || "",
              round1: "", round2: "", round3: "", round4: "", status: "Pending", notes: "",
              teacherEmail: r.teacherEmail || "", teacherName: r.teacherName || "",
            });
          }
        });
      } else if (b.action === "walkin_register_checkin") {
        // Same server round trip covers both the registration AND the
        // check-in (see registerWalkinAndCheckIn_ in Code.gs) — re-apply
        // both halves under the same placeholder id so neither the student
        // record nor the attendance row is missing after a reload.
        const id = b.clientId;
        if (id && !state.students.some((s) => s.id === id)) {
          state.students.push({
            id, name: b.name, admissionNo: "", classStream: b.classStream, cohort: b.cohort,
            round1: "", round2: "", round3: "", round4: "", status: "Walk-in", notes: "Same-day walk-in registration",
          });
        }
        if (id && !state.attendance.some((a) => a.personId === id)) {
          state.attendance.unshift({
            timestamp: item.queuedAt, type: "Student", personId: id, personName: b.name,
            round: b.round || "", room: b.room || "", method: "Walk-in", checkedInBy: b.who || "Someone",
          });
        }
      }
    });
  }

  function renderSyncIndicator() {
    const n = state.syncQueue.length;
    if (n > 0) {
      syncIndicator.textContent = n + " change" + (n === 1 ? "" : "s") + " waiting to sync" + (navigator.onLine ? "…" : " (offline)");
      syncIndicator.classList.add("pending");
    } else {
      syncIndicator.textContent = state.lastSyncNote;
      syncIndicator.classList.remove("pending");
    }
  }

  function loadDemoData() {
    return Promise.all([
      fetch("data/team.json").then((r) => r.json()),
      fetch("data/tasks.json").then((r) => r.json()),
      fetch("data/students.json").then((r) => r.json()),
      fetch("data/attendance.json").then((r) => r.json()),
      fetch("data/clusters.json").then((r) => r.json()),
    ]).then(([team, tasks, students, attendance, clusters]) => ({ team, tasks, students, attendance, clusters, fetchedAt: null, demo: true }));
  }

  function loadLiveData() {
    return apiGet("all").then((res) => {
      if (!res.ok) {
        const err = new Error(res.error || "API error");
        if (res.error === "AUTH_REQUIRED") err.authRequired = true;
        throw err;
      }
      return {
        team: res.team,
        tasks: res.tasks,
        students: res.students || [],
        attendance: res.attendance || [],
        clusters: res.clusters || [],
        careers: res.careers || [],
        feedback: res.feedback || [],
        chat: res.chat || [],
        me: res.me || null,
        fetchedAt: res.fetchedAt,
        demo: false,
      };
    });
  }

  function cacheData(data) {
    try {
      localStorage.setItem("wg2_cache", JSON.stringify({ ...data, savedAt: new Date().toISOString() }));
    } catch (e) {}
  }

  function loadCachedData() {
    try {
      const raw = localStorage.getItem("wg2_cache");
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function refresh(showLoading) {
    if (showLoading) statusLine.textContent = "Syncing…";
    const loader = DEMO_MODE ? loadDemoData() : loadLiveData();
    return loader
      .then((data) => {
        state.team = data.team || [];
        state.tasks = data.tasks || [];
        state.students = data.students || [];
        state.attendance = data.attendance || [];
        state.clusters = data.clusters || [];
        state.careers = data.careers || [];
        state.feedback = data.feedback || [];
        state.chat = data.chat || [];
        state.settings = data.settings || {};
        state.classes = data.classes || [];
        state.schedule = data.schedule || [];
        state.fetchedAt = data.fetchedAt;
        // Keep the session's accessLevel/zone/cluster in sync with the server
        // (e.g. a Lead just changed this person's access — no need to force
        // a fresh login for that to take effect on their next sync).
        if (data.me && state.session) {
          state.session.role = data.me.role;
          state.session.accessLevel = data.me.accessLevel;
          state.session.zone = data.me.zone;
          state.session.cluster = data.me.cluster;
          saveSession(state.session);
        }
        demoBanner.classList.toggle("hidden", !DEMO_MODE);
        if (!DEMO_MODE) cacheData(data);
        statusLine.textContent = DEMO_MODE
          ? "Demo data — not connected"
          : "Synced just now";
        statusLine.classList.remove("offline");
        state.lastSyncNote = "";
        applyQueuedOverlay();
        renderSyncIndicator();
        renderAll();
        renderAccessGatedUI();
        flushQueue();
        loadPrivateChat(); // keeps the DM unread badge current even without opening Help
        loadGroupChat(); // same, for group chat unread badges
      })
      .catch((err) => {
        console.error(err);
        if (err && err.authRequired) {
          // Not a connectivity problem — the token itself is no longer
          // valid (PIN was reset, etc.). Send them back to sign in rather
          // than silently showing stale cached data as if all were well.
          clearSession();
          showLoginScreen("Your session expired. Please sign in again.");
          return;
        }
        const cached = loadCachedData();
        if (cached) {
          state.team = cached.team || [];
          state.tasks = cached.tasks || [];
          state.students = cached.students || [];
          state.attendance = cached.attendance || [];
          state.clusters = cached.clusters || [];
          state.careers = cached.careers || [];
          state.feedback = cached.feedback || [];
          state.chat = cached.chat || [];
          state.settings = cached.settings || {};
          state.classes = cached.classes || [];
          state.schedule = cached.schedule || [];
          statusLine.textContent = "Offline — showing last synced data";
          statusLine.classList.add("offline");
          state.lastSyncNote = "Last synced " + timeAgo(cached.savedAt);
          applyQueuedOverlay();
          renderSyncIndicator();
          renderAll();
          renderAccessGatedUI();
        } else {
          statusLine.textContent = "Couldn't connect, and no cached data yet";
          statusLine.classList.add("offline");
        }
      });
  }

  function timeAgo(iso) {
    if (!iso) return "unknown";
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " hr ago";
    return Math.floor(s / 86400) + " day(s) ago";
  }

  // ---------------------------------------------------------------------
  // RENDER: TASKS
  // ---------------------------------------------------------------------
  function uniqueSorted(arr) {
    return Array.from(new Set(arr.filter(Boolean))).sort();
  }

  // Plain string sort puts "K10" before "K2" (lexicographic — "1" < "2"
  // character-by-character), so a K1-K15 stream list reads K1, K10, K11...
  // K2, K3 instead of numeric order. This splits each name into its
  // trailing digits ("K1" -> prefix "K", number 1) and compares those
  // numerically when both names share the same prefix — covering K1-K15
  // and 4S1-4S8 alike. Anything that doesn't end in digits (or has a
  // different prefix) just falls back to a normal string compare, so it's
  // safe to use on any classStream name, not just the K.../4S... pattern.
  function naturalClassCompare_(a, b) {
    const pa = /^(.*?)(\d+)$/.exec(String(a));
    const pb = /^(.*?)(\d+)$/.exec(String(b));
    if (pa && pb && pa[1] === pb[1]) return Number(pa[2]) - Number(pb[2]);
    return String(a).localeCompare(String(b));
  }

  function renderTaskChips() {
    const phases = ["All"].concat(uniqueSorted(state.tasks.map((t) => t.phase)));
    $("phaseChips").innerHTML = phases
      .map(
        (p) =>
          `<button class="chip ${p === state.taskFilters.phase ? "active" : ""}" data-phase="${escAttr(p)}">${esc(
            p
          )}</button>`
      )
      .join("");
    const states = ["All", "Pending", "In Progress", "Done"];
    $("stateChips").innerHTML = states
      .map(
        (s) =>
          `<button class="chip ${s === state.taskFilters.state ? "active" : ""}" data-state="${escAttr(s)}">${esc(
            s
          )}</button>`
      )
      .join("");
  }

  // 27 Aug 2026 request: Done tasks were sitting wherever they happened to
  // fall in sheet order, so someone opening the list could land on an
  // already-finished task first and risk redoing it. This keeps everything
  // else in its original relative order (stable sort) but demotes every
  // Done task below every Pending/In Progress one — see the "Completed"
  // divider renderTaskList adds at the boundary.
  function filteredTasks() {
    const f = state.taskFilters;
    const q = f.q.trim().toLowerCase();
    const matched = state.tasks.filter((t) => {
      if (f.phase !== "All" && t.phase !== f.phase) return false;
      if (f.state !== "All" && t.state !== f.state) return false;
      if (q && !(t.task.toLowerCase().includes(q) || (t.owner || "").toLowerCase().includes(q))) return false;
      return true;
    });
    return matched
      .map((t, i) => ({ t, i, done: t.state === "Done" ? 1 : 0 }))
      .sort((a, b) => a.done - b.done || a.i - b.i)
      .map((x) => x.t);
  }

  function renderTaskSummary() {
    const total = state.tasks.length;
    const done = state.tasks.filter((t) => t.state === "Done").length;
    const prog = state.tasks.filter((t) => t.state === "In Progress").length;
    const pending = total - done - prog;
    $("taskSummary").innerHTML = `
      <div class="box"><div class="n">${done}</div><div class="l">Done</div></div>
      <div class="box"><div class="n">${prog}</div><div class="l">In Progress</div></div>
      <div class="box"><div class="n">${pending}</div><div class="l">Pending</div></div>
      <div class="box"><div class="n">${total}</div><div class="l">Total</div></div>
    `;
    const pct = (n) => (total ? (n / total) * 100 : 0);
    $("taskProgress").innerHTML = `
      <div class="seg done" style="width:${pct(done)}%"></div>
      <div class="seg prog" style="width:${pct(prog)}%"></div>
      <div class="seg pending" style="width:${pct(pending)}%"></div>
    `;
  }

  function stateClass(s) {
    return (s || "Pending").replace(/\s+/g, "-");
  }

  function renderTaskList() {
    const items = filteredTasks();
    if (!items.length) {
      $("taskList").innerHTML = `<div class="empty">No tasks match this filter.</div>`;
      return;
    }
    // Insert a "Completed" divider right where Done tasks start — filteredTasks
    // already sorted them to the bottom, so this is just a single boundary,
    // not a per-item check. Skipped when the Status chip is already narrowed
    // to one state (e.g. "Done" alone), since a divider adds nothing there.
    const showDivider = state.taskFilters.state === "All";
    const firstDoneIdx = showDivider ? items.findIndex((t) => t.state === "Done") : -1;
    $("taskList").innerHTML = items
      .map((t, i) => {
        const divider = i === firstDoneIdx ? `<div class="task-divider">Completed</div>` : "";
        return `${divider}
      <div class="card ${t.state === "Done" ? "task-done" : ""}" data-task-id="${escAttr(t.id)}">
        <div class="toprow">
          <div>
            <div class="phase-tag">${esc(t.phase)}</div>
            <div class="tasktext">${esc(t.task)}</div>
          </div>
          <button class="pill ${stateClass(t.state)}" data-quickstate="${escAttr(t.id)}">${esc(t.state || "Pending")}</button>
        </div>
        <div class="meta">
          <span><b>Owner:</b> ${esc(t.owner || "Unassigned")}</span>
          <span><b>Due:</b> ${esc(t.due || "—")}</span>
        </div>
        ${t.notes ? `<div class="notes">${esc(t.notes)}</div>` : ""}
      </div>
    `;
      })
      .join("");
  }

  // ---------------------------------------------------------------------
  // RENDER: TEAM
  // ---------------------------------------------------------------------
  function roleGroup(role) {
    if (!role) return "Other";
    if (role === "Lead" || role === "Assistant Lead") return "Leadership";
    if (role === "Zone Coordinator") return "Zone Coordinators";
    if (role === "Cluster Lead" || role === "Sub-Lead") return "Cluster Leads";
    if (role === "Mentor") return "Mentors";
    if (role === "Intern") return "Interns";
    if (role === "Class Teacher") return "Class Teachers";
    return "Members";
  }

  function renderTeamChips() {
    const roles = ["All"].concat(uniqueSorted(state.team.map((p) => p.role)));
    $("roleChips").innerHTML = roles
      .map(
        (r) =>
          `<button class="chip ${r === state.teamFilters.role ? "active" : ""}" data-role="${escAttr(r)}">${esc(
            r
          )}</button>`
      )
      .join("");
  }

  function filteredTeam() {
    const f = state.teamFilters;
    const q = f.q.trim().toLowerCase();
    return state.team.filter((p) => {
      if (f.role !== "All" && p.role !== f.role) return false;
      if (
        q &&
        !(
          p.name.toLowerCase().includes(q) ||
          (p.role || "").toLowerCase().includes(q) ||
          (p.zone || "").toLowerCase().includes(q)
        )
      )
        return false;
      return true;
    });
  }

  function initials(name) {
    return name
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase();
  }

  function renderTeamList() {
    const items = filteredTeam();
    if (!items.length) {
      $("teamList").innerHTML = `<div class="empty">No one matches this search.</div>`;
      return;
    }
    // group by role bucket, preserving a sensible order
    const order = ["Leadership", "Zone Coordinators", "Cluster Leads", "Mentors", "Class Teachers", "Interns", "Members", "Other"];
    const groups = {};
    items.forEach((p) => {
      const g = roleGroup(p.role);
      (groups[g] = groups[g] || []).push(p);
    });
    let html = "";
    order.forEach((g) => {
      if (!groups[g]) return;
      html += `<div class="group-label">${esc(g)} (${groups[g].length})</div>`;
      html += groups[g]
        .map(
          (p) => `
        <div class="person" data-person-id="${escAttr(p.id)}">
          <div class="avatar">${esc(initials(p.name))}</div>
          <div class="info">
            <div class="name">${esc(p.name)}</div>
            <div class="role">${esc(p.role)}${p.notes ? " · " + esc(p.notes) : ""}</div>
            ${p.zone ? `<span class="zone-tag">${esc(p.zone)}</span>` : ""}
            ${p.role === "Mentor" && p.mode && p.mode !== "In-person" ? `<span class="mode-tag">${esc(p.mode)}</span>` : ""}
            ${p.role === "Class Teacher" && p.classStream ? `<span class="mode-tag">${esc(p.classStream)}</span>` : ""}
          </div>
          <div class="statuspill ${p.status === "Confirmed" ? "Confirmed" : "Unconfirmed"}">${esc(p.status || "—")}</div>
        </div>
      `
        )
        .join("");
    });
    $("teamList").innerHTML = html;
  }

  function renderAll() {
    renderTaskChips();
    renderTaskSummary();
    renderTaskList();
    buildOwnerSuggestions();
    buildClassSelect();
    renderTeamChips();
    renderTeamList();
    renderRecentCheckins();
    renderDashboard();
    renderSchedule();
  }

  // ---------------------------------------------------------------------
  // ESCAPING HELPERS
  // ---------------------------------------------------------------------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escAttr(s) {
    return esc(s);
  }

  // ---------------------------------------------------------------------
  // DOWNLOADS — CSV exports (client-side, no server round trip)
  // ---------------------------------------------------------------------
  function csvCell(v) {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function downloadCSV(filename, headers, rows) {
    const lines = [headers.map(csvCell).join(",")];
    rows.forEach((row) => lines.push(headers.map((h) => csvCell(row[h])).join(",")));
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ---------------------------------------------------------------------
  // MODALS
  // ---------------------------------------------------------------------
  function openTaskModal(id) {
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    state.openTaskId = id;
    $("taskModalTitle").textContent = t.task;
    $("taskModalPhase").textContent = t.phase;
    $("taskModalOwner").value = t.owner || "";
    $("taskModalDue").textContent = t.due || "—";
    $("taskModalState").value = t.state || "Pending";
    $("taskModalNotes").textContent = t.notes || "None";
    $("taskModal").classList.remove("hidden");
  }
  function closeTaskModal() {
    $("taskModal").classList.add("hidden");
    state.openTaskId = null;
  }

  function openTeamModal(id) {
    const p = state.team.find((x) => x.id === id);
    if (!p) return;
    state.openTeamId = id;
    $("teamModalName").textContent = p.name;
    $("teamModalRole").textContent = p.role + (p.zone ? " · " + p.zone : "") + (p.notes ? " · " + p.notes : "");
    const contact = [p.phone, p.email].filter(Boolean).join("  ·  ");
    $("teamModalContact").textContent = contact || "No contact on file";
    $("teamModalStatus").value = p.status === "Confirmed" ? "Confirmed" : "Unconfirmed";
    const owned = state.tasks.filter((t) => (t.owner || "").toLowerCase().includes(p.name.toLowerCase()));
    $("teamModalTasks").innerHTML = owned.length
      ? owned.map((t) => `• ${esc(t.task)} <i>(${esc(t.state)})</i>`).join("<br>")
      : "No tasks currently assigned by name.";
    $("teamModal").classList.remove("hidden");
  }
  function closeTeamModal() {
    $("teamModal").classList.add("hidden");
    state.openTeamId = null;
  }

  // ---------------------------------------------------------------------
  // QR LOOKUP — view/download/resend anyone's QR code on demand, without
  // re-registering them. QR codes aren't stored as images anywhere; they're
  // always a deterministic encoding of the person's id (see drawQr), so
  // "looking up" a QR just means re-rendering it from an id we already
  // have — the result is byte-for-byte identical to what they were
  // originally issued. Opened from the Team modal and from Find Student.
  // ---------------------------------------------------------------------
  let qrLookup = null; // { id, name, email }

  function openQrLookup(id, name, email) {
    qrLookup = { id, name, email: email || "" };
    $("qrLookupName").textContent = name || "";
    $("qrLookupId").textContent = id || "";
    drawQr($("qrLookupCanvas"), id);
    const emailBtn = $("qrLookupEmail");
    const status = $("qrLookupEmailStatus");
    status.textContent = "";
    status.classList.add("hidden");
    if (email) {
      $("qrLookupEmailAddr").textContent = email;
      emailBtn.classList.remove("hidden");
    } else {
      emailBtn.classList.add("hidden");
    }
    $("qrLookupModal").classList.remove("hidden");
  }

  function closeQrLookup() {
    $("qrLookupModal").classList.add("hidden");
    qrLookup = null;
  }

  function downloadLookupQr() {
    if (!qrLookup) return;
    const record = state.students.find((s) => s.id === qrLookup.id);
    const link = document.createElement("a");
    link.download = qrLookup.id + ".png";
    link.href = labeledQrDataUrl(qrLookup.id, qrLookup.name, 240, studentScheduleLines_(record));
    link.click();
  }

  function emailLookupQr() {
    if (!qrLookup || !qrLookup.email || DEMO_MODE) return;
    const { id, name, email } = qrLookup;
    const record = state.students.find((s) => s.id === id);
    const status = $("qrLookupEmailStatus");
    status.textContent = "Emailing QR code to " + email + "…";
    status.classList.remove("hidden");
    apiPost({ action: "email_own_qr", to: email, name, id, dataUrl: labeledQrDataUrl(id, name, 240, studentScheduleLines_(record)) })
      .then((res) => {
        if (!qrLookup || qrLookup.id !== id) return; // lookup moved on to someone else
        status.textContent = res && res.ok ? "Emailed to " + email + "." : "Couldn't email the QR code.";
      })
      .catch(() => {
        if (qrLookup && qrLookup.id === id) status.textContent = "Couldn't email the QR code.";
      });
  }

  function saveTask() {
    const id = state.openTaskId;
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    const newOwner = $("taskModalOwner").value.trim();
    const newState = $("taskModalState").value;
    const ownerChanged = newOwner !== (t.owner || "");
    const stateChanged = newState !== (t.state || "Pending");
    t.owner = newOwner;
    t.state = newState;
    renderAll();
    closeTaskModal();
    if (DEMO_MODE) return;
    const calls = [];
    if (stateChanged) calls.push(apiPost({ action: "update_task_status", id, state: newState }));
    if (ownerChanged) calls.push(apiPost({ action: "assign_task", id, owner: newOwner }));
    Promise.all(calls).catch((e) => console.error(e));
  }

  function saveTeam() {
    const id = state.openTeamId;
    const p = state.team.find((x) => x.id === id);
    if (!p) return;
    const newStatus = $("teamModalStatus").value;
    p.status = newStatus;
    renderAll();
    closeTeamModal();
    if (DEMO_MODE) return;
    apiPost({ action: "update_team_status", id, status: newStatus }).catch((e) => console.error(e));
  }

  // Quick-tap cycling of task state pill without opening the full modal
  function cycleState(id) {
    const order = ["Pending", "In Progress", "Done"];
    const t = state.tasks.find((x) => x.id === id);
    if (!t) return;
    const idx = order.indexOf(t.state || "Pending");
    const next = order[(idx + 1) % order.length];
    t.state = next;
    renderAll();
    if (!DEMO_MODE) apiPost({ action: "update_task_status", id, state: next }).catch((e) => console.error(e));
  }

  // ---------------------------------------------------------------------
  // ADD TASK — lets a Lead/Assistant Lead/Zone Coordinator create and
  // delegate a new coordination task from the app (e.g. "chase unconfirmed
  // WG2 members"), instead of editing the Tasks sheet directly. Owner is
  // free text, same convention the tracker already uses ("Interns",
  // "Cizarina + Interns", a person's name, ...) — see buildOwnerSuggestions
  // for the autocomplete list.
  // ---------------------------------------------------------------------
  function buildOwnerSuggestions() {
    const dl = $("ownerSuggestions");
    if (!dl) return;
    const groups = ["Interns", "Zone Coordinators", "Cluster Leads", "Sub-Leads", "Mentors", "All WG2"];
    const names = state.team.map((t) => t.name);
    const existingOwners = state.tasks.map((t) => t.owner).filter(Boolean);
    const all = uniqueSorted(groups.concat(names, existingOwners));
    dl.innerHTML = all.map((o) => `<option value="${escAttr(o)}"></option>`).join("");
  }

  function buildPhaseSuggestions() {
    const dl = $("phaseSuggestions");
    if (!dl) return;
    const phases = uniqueSorted(state.tasks.map((t) => t.phase).filter(Boolean));
    dl.innerHTML = phases.map((p) => `<option value="${escAttr(p)}"></option>`).join("");
  }

  function openAddTaskModal() {
    $("newTaskText").value = "";
    $("newTaskPhase").value = "";
    $("newTaskOwner").value = "";
    $("newTaskDue").value = "";
    $("newTaskDelegable").value = "Y";
    $("newTaskNotes").value = "";
    buildPhaseSuggestions();
    $("addTaskModal").classList.remove("hidden");
  }
  function closeAddTaskModal() {
    $("addTaskModal").classList.add("hidden");
  }
  function submitAddTask() {
    const task = $("newTaskText").value.trim();
    if (!task) { alert("Task text is required."); return; }
    const body = {
      action: "add_task",
      task,
      phase: $("newTaskPhase").value.trim() || "Uncategorized",
      owner: $("newTaskOwner").value.trim(),
      due: $("newTaskDue").value.trim(),
      delegable: $("newTaskDelegable").value,
      notes: $("newTaskNotes").value.trim(),
    };
    closeAddTaskModal();
    if (DEMO_MODE) {
      const id = "K" + String(state.tasks.length + 1).padStart(3, "0");
      state.tasks.push(Object.assign({ id, status: "Pending", state: "Pending", updatedAt: new Date().toISOString() }, body));
      renderAll();
      return;
    }
    apiPost(body).then((res) => {
      if (!res || !res.ok) { alert((res && res.error) || "Couldn't add task."); return; }
      if (!res.queued) refresh(false);
    });
  }

  // ---------------------------------------------------------------------
  // WHOAMI (demo mode only — cosmetic name label, no auth involved)
  // ---------------------------------------------------------------------
  function renderWhoami() {
    if (!DEMO_MODE) {
      whoamiBtn.textContent = state.session ? state.session.name.split(" ")[0] : "Sign in";
      return;
    }
    whoamiBtn.textContent = state.who ? state.who.split(" ")[0] : "Sign in";
  }
  function openWhoami() {
    if (!DEMO_MODE) {
      // Live mode: this button opens the account panel — who's signed in,
      // My Details (self-service contact-info edit), a self-service PIN
      // change, delete-my-account, and sign out. Anyone can do all of this
      // for themselves, not just admins via Team Access.
      if (!state.session) return;
      $("accountName").textContent = state.session.name;
      $("accountMeta").textContent = state.session.role + " · " + state.session.accessLevel + " access";
      // state.session itself doesn't carry phone/email (login_ never
      // returns them) — pull the full row from state.team, which always
      // includes the signed-in user's own record regardless of role (see
      // visibleTeam_ in Code.gs, every branch keeps t.id === me.id).
      const myRow = state.team.find((t) => t.id === state.session.memberId) || {};
      $("accountMyName").value = state.session.name || "";
      $("accountMyPhone").value = myRow.phone || "";
      $("accountMyEmail").value = myRow.email || "";
      const dResult = $("accountDetailsResult");
      dResult.textContent = "";
      dResult.classList.add("hidden");
      $("accountNewPin").value = "";
      const result = $("accountPinResult");
      result.textContent = "";
      result.classList.add("hidden");
      $("accountModal").classList.remove("hidden");
      return;
    }
    $("whoamiInput").value = state.who;
    $("whoamiModal").classList.remove("hidden");
  }
  function closeWhoami() {
    $("whoamiModal").classList.add("hidden");
  }
  function saveWhoami() {
    state.who = $("whoamiInput").value.trim();
    localStorage.setItem("wg2_whoami", state.who);
    renderWhoami();
    closeWhoami();
  }

  function closeAccountModal() {
    $("accountModal").classList.add("hidden");
  }

  // Changes the SIGNED-IN user's own PIN (never anyone else's — the server
  // scopes this to the caller's verified session, see changeOwnPin_). A
  // successful change returns a fresh token for the new PIN, which we save
  // immediately so the person isn't logged out by their own PIN change.
  function changeMyPin() {
    const typed = $("accountNewPin").value.trim();
    if (typed && !/^\d{4,6}$/.test(typed)) {
      alert("PIN must be 4-6 digits.");
      return;
    }
    apiPost({ action: "change_own_pin", newPin: typed })
      .then((res) => {
        if (!res || !res.ok) {
          alert((res && res.error) || "Couldn't change your PIN.");
          return;
        }
        saveSession(Object.assign({}, state.session, { token: res.token }));
        const result = $("accountPinResult");
        result.textContent = "Your new PIN is " + res.pin + ". Use it next time you sign in.";
        result.classList.remove("hidden");
        $("accountNewPin").value = "";
      })
      .catch(() => alert("Couldn't reach the server. Check your connection and try again."));
  }

  function signOutFromAccount() {
    if (!confirm("Sign out?")) return;
    closeAccountModal();
    logout();
  }

  // Self-service "My Details" save — name/phone/email only, always scoped
  // to the signed-in caller server-side (see update_my_details/
  // updateMyDetails_ in Code.gs), never able to touch anyone else's row.
  function saveMyDetails() {
    const name = $("accountMyName").value.trim();
    const phone = $("accountMyPhone").value.trim();
    const email = $("accountMyEmail").value.trim();
    if (!name) { alert("Name can't be blank."); return; }
    const result = $("accountDetailsResult");
    apiPost({ action: "update_my_details", name, phone, email })
      .then((res) => {
        if (!res || (!res.ok && !res.queued)) {
          result.textContent = (res && res.error) || "Couldn't save your details.";
          result.style.color = "var(--red)";
          result.classList.remove("hidden");
          return;
        }
        // Renamed themselves — keep the local session/team-list labels in
        // sync immediately rather than waiting on the next refresh, same
        // idea as changeMyPin swapping in a fresh token right away.
        if (name !== state.session.name) {
          saveSession(Object.assign({}, state.session, { name }));
          $("accountName").textContent = name;
          renderWhoami();
        }
        result.textContent = res.queued ? "Saved offline — will sync once back online." : "Saved.";
        result.style.color = "var(--green)";
        result.classList.remove("hidden");
        if (!res.queued) refresh(false);
      })
      .catch(() => {
        result.textContent = "Couldn't reach the server. Check your connection and try again.";
        result.style.color = "var(--red)";
        result.classList.remove("hidden");
      });
  }

  // ---- Delete My Account (self-service) ----
  // Two-step, deliberately: the Danger Zone button opens a dedicated
  // confirm modal that requires TYPING the signed-in name (not just
  // clicking through a browser confirm()) before the delete actually
  // fires — this is a harder-to-misfire pattern than confirm() for
  // something this consequential, since it can't be dismissed by a reflex
  // keypress. See deleteTeamAccount_ in Code.gs for what "delete" means
  // server-side (soft-delete, blocks sign-in, keeps the row for audit).
  function openDeleteAccountModal() {
    $("deleteAccountConfirmInput").value = "";
    const err = $("deleteAccountError");
    err.textContent = "";
    err.classList.add("hidden");
    $("deleteAccountModal").classList.remove("hidden");
  }
  function closeDeleteAccountModal() {
    $("deleteAccountModal").classList.add("hidden");
  }
  function confirmDeleteMyAccount() {
    const typed = $("deleteAccountConfirmInput").value.trim().toLowerCase();
    const mine = (state.session.name || "").trim().toLowerCase();
    const err = $("deleteAccountError");
    if (!typed || typed !== mine) {
      err.textContent = "Type your name exactly as shown (" + state.session.name + ") to confirm.";
      err.classList.remove("hidden");
      return;
    }
    apiPost({ action: "delete_my_account" })
      .then((res) => {
        if (!res || (!res.ok && !res.queued)) {
          err.textContent = (res && res.error) || "Couldn't delete your account.";
          err.classList.remove("hidden");
          return;
        }
        closeDeleteAccountModal();
        closeAccountModal();
        alert("Your account has been deleted. You're now signed out — contact a WG2 Lead or Assistant Lead if you need it restored.");
        logout();
      })
      .catch(() => {
        err.textContent = "Couldn't reach the server. Check your connection and try again.";
        err.classList.remove("hidden");
      });
  }

  // ---------------------------------------------------------------------
  // LOGIN — real auth for live mode. Demo mode never shows this screen.
  // ---------------------------------------------------------------------
  function showLoginScreen(message) {
    $("loginScreen").classList.remove("hidden");
    $("app").style.display = "none";
    if (message) {
      $("loginError").textContent = message;
      $("loginError").classList.remove("hidden");
    } else {
      $("loginError").classList.add("hidden");
    }
  }
  function hideLoginScreen() {
    $("loginScreen").classList.add("hidden");
    $("app").style.display = "";
  }

  function saveSession(session) {
    state.session = session;
    state.classPaneAutoApplied = false; // let My Class re-apply this (possibly new) person's own class on next visit
    try {
      localStorage.setItem("wg2_session", JSON.stringify(session));
    } catch (e) {}
  }
  function loadSavedSession() {
    try {
      const raw = localStorage.getItem("wg2_session");
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function clearSession() {
    state.session = null;
    try {
      localStorage.removeItem("wg2_session");
    } catch (e) {}
  }

  function submitLogin(e) {
    e.preventDefault();
    const name = $("loginName").value.trim();
    const pin = $("loginPin").value.trim();
    if (!name || !pin) {
      $("loginError").textContent = "Enter your name and PIN.";
      $("loginError").classList.remove("hidden");
      return;
    }
    const btn = $("loginSubmitBtn");
    btn.disabled = true;
    btn.textContent = "Signing in…";
    fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "login", name, pin }),
    })
      .then((r) => r.json())
      .then((res) => {
        btn.disabled = false;
        btn.textContent = "Sign In";
        if (!res.ok) {
          $("loginError").textContent = res.error || "Sign in failed.";
          $("loginError").classList.remove("hidden");
          return;
        }
        saveSession({
          memberId: res.memberId, name: res.name, role: res.role,
          accessLevel: res.accessLevel, zone: res.zone, cluster: res.cluster, token: res.token,
        });
        hideLoginScreen();
        renderWhoami();
        setTab("tasks");
        refresh(true).then(() => { buildChoiceSelects(); maybeHandleDeepLinkIntent_(); });
      })
      .catch(() => {
        btn.disabled = false;
        btn.textContent = "Sign In";
        $("loginError").textContent = "Couldn't reach the server. Check your connection and try again.";
        $("loginError").classList.remove("hidden");
      });
  }

  function logout() {
    clearSession();
    renderWhoami();
    showLoginScreen();
  }

  // Reads a one-shot "intent" carried in the page URL — currently only
  // ?intent=changepin, used by the "Change My PIN" button in PIN emails
  // (see pinEmailButtonsHtml_ in Code.gs) so a recipient lands straight on
  // the account panel's PIN field instead of having to find it themselves.
  // Only fires once someone is actually signed in (if they weren't, they
  // hit the normal login form first — this runs again right after login
  // succeeds, since the query string is still there). The param is then
  // stripped from the URL so refreshing the page doesn't reopen the panel.
  function maybeHandleDeepLinkIntent_() {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get("intent") === "changepin" && state.session) {
        openWhoami();
        params.delete("intent");
        const rest = params.toString();
        window.history.replaceState(null, "", window.location.pathname + (rest ? "?" + rest : ""));
      }
    } catch (e) {}
  }

  // ---------------------------------------------------------------------
  // PUBLIC MENTOR REGISTRATION — no sign-in required. Reachable from a link
  // on the login screen. Uses its own fetch calls (not apiGet/apiPost)
  // because it deliberately carries no token/session and must never be
  // queued into the authenticated sync queue (see apiPost) — if the network
  // is down, this just tells the applicant to try again, rather than
  // silently stashing a stranger's submission in this browser's storage.
  // ---------------------------------------------------------------------
  function publicApiGet(action) {
    const url = API_URL + (API_URL.indexOf("?") === -1 ? "?" : "&") + "action=" + action;
    return fetch(url).then((r) => r.json());
  }
  function publicApiPost(body) {
    return fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
    }).then((r) => r.json());
  }

  // Mentors choose by CAREER FIELD first, not by administrative zone/cluster
  // code — so the picker leads with the zone's career theme (e.g. "Health,
  // Medicine & Human Performance") as the optgroup heading, then the actual
  // cluster name (e.g. "Sports Science & Physical Fitness") as the option a
  // mentor picks. The Zone/Cluster codes (e.g. "Zone A · A3") are shown
  // trailing, in parentheses — that's logistics (where they'll physically
  // sit on the day), useful to know but not what drives the choice.
  function populatePublicClusterSelects_(clusters) {
    const byZone = {};
    clusters.forEach((c) => { (byZone[c.zone] = byZone[c.zone] || []).push(c); });
    const zoneOrder = Object.keys(ZONE_NAMES); // fixed A..E order, not alphabetical-by-theme
    const buildOptions = (placeholder) => {
      const groups = zoneOrder.map((z) => {
        const list = (byZone[z] || []).slice().sort((a, b) => a.id.localeCompare(b.id));
        if (!list.length) return "";
        const opts = list.map((c) => `<option value="${escAttr(c.id)}">${esc(c.name)} (Zone ${esc(z)} · Cluster ${esc(c.id)})</option>`).join("");
        return `<optgroup label="${escAttr(ZONE_NAMES[z])}">${opts}</optgroup>`;
      }).join("");
      return `<option value="">${placeholder}</option>` + groups;
    };
    $("pmPrimaryCluster").innerHTML = buildOptions("— choose one —");
    $("pmSecondaryCluster").innerHTML = buildOptions("N/A — no second choice");
  }

  function loadPublicClusters() {
    if (DEMO_MODE) {
      populatePublicClusterSelects_(CLUSTER_CATALOG);
      return;
    }
    publicApiGet("clusters_public")
      .then((res) => {
        if (res && res.ok && res.clusters && res.clusters.length) {
          populatePublicClusterSelects_(res.clusters);
        } else {
          populatePublicClusterSelects_(CLUSTER_CATALOG);
        }
      })
      .catch(() => populatePublicClusterSelects_(CLUSTER_CATALOG));
  }

  function resetPublicMentorForm_() {
    $("pubMentorForm").reset();
    $("pmRefereeWrap").classList.add("hidden");
    $("pmGradYearWrap").classList.add("hidden");
    document.querySelectorAll("#publicMentorScreen .pubreg-check-row").forEach((row) => row.classList.remove("checked"));
    $("pubMentorError").classList.add("hidden");
    $("pubMentorFormWrap").classList.remove("hidden");
    $("pubMentorSuccess").classList.add("hidden");
    const btn = $("pubMentorSubmitBtn");
    btn.disabled = false;
    btn.textContent = "Submit Registration";
  }

  function showPublicMentorRegister() {
    $("loginScreen").classList.add("hidden");
    $("publicMentorScreen").classList.remove("hidden");
    resetPublicMentorForm_();
    loadPublicClusters();
  }
  function hidePublicMentorRegister() {
    $("publicMentorScreen").classList.add("hidden");
    $("loginScreen").classList.remove("hidden");
  }

  function updateExbomarianConditional_() {
    const val = $("pmExbomarian").value;
    const showReferee = val === "No";
    const showGradYear = val === "Yes";
    $("pmRefereeWrap").classList.toggle("hidden", !showReferee);
    $("pmGradYearWrap").classList.toggle("hidden", !showGradYear);
    $("pmRefereeName").required = showReferee;
  }

  function checkedValues_(name) {
    return Array.from(document.querySelectorAll(`input[name="${name}"]:checked`)).map((el) => el.value);
  }

  function submitPublicMentorRegister(e) {
    e.preventDefault();
    const errEl = $("pubMentorError");
    errEl.classList.add("hidden");

    const exbomarian = $("pmExbomarian").value;
    const refereeName = $("pmRefereeName").value.trim();
    const shifts = checkedValues_("pmShift");
    const consent = $("pmConsent").checked;

    if (!exbomarian) { errEl.textContent = "Please answer the Bomarian question."; errEl.classList.remove("hidden"); return; }
    if (exbomarian === "No" && !refereeName) { errEl.textContent = "Please give your referee's full name."; errEl.classList.remove("hidden"); return; }
    if (!$("pmMode").value) { errEl.textContent = "Please tell us how you'll participate (in-person or virtual)."; errEl.classList.remove("hidden"); return; }
    if (!shifts.length) { errEl.textContent = "Please select at least one shift you're available for."; errEl.classList.remove("hidden"); return; }
    if (!$("pmPrimaryCluster").value) { errEl.textContent = "Please choose a career cluster."; errEl.classList.remove("hidden"); return; }
    if (!consent) { errEl.textContent = "Please confirm the declaration to submit."; errEl.classList.remove("hidden"); return; }

    const body = {
      action: "public_register_mentor",
      exbomarian: exbomarian,
      refereeName: exbomarian === "No" ? refereeName : "",
      refereeContact: exbomarian === "No" ? $("pmRefereeContact").value.trim() : "",
      gradYear: exbomarian === "Yes" ? $("pmGradYear").value.trim() : "",
      name: $("pmName").value.trim(),
      phone: $("pmPhone").value.trim(),
      email: $("pmEmail").value.trim(),
      preferredContact: $("pmPreferredContact").value,
      jobTitle: $("pmJobTitle").value.trim(),
      organisation: $("pmOrganisation").value.trim(),
      profession: $("pmProfession").value.trim(),
      yearsExperience: $("pmYearsExperience").value,
      bio: $("pmBio").value.trim(),
      linkedinOrProfile: $("pmLinkedin").value.trim(),
      primaryCluster: $("pmPrimaryCluster").value,
      secondaryCluster: $("pmSecondaryCluster").value,
      mode: $("pmMode").value,
      shifts: shifts.join(", "),
      additionalRole: checkedValues_("pmAddRole").join(", "),
      priorMentor: $("pmPriorMentor").value,
      briefingAttend: $("pmBriefingAttend").value,
      tshirtSize: $("pmTshirtSize").value,
      accessNeeds: $("pmAccessNeeds").value.trim(),
      consent: true,
      notes: $("pmNotes").value.trim(),
    };

    if (DEMO_MODE) {
      errEl.textContent = "Demo mode has no live backend to submit to — connect the app in config.js to try this for real.";
      errEl.classList.remove("hidden");
      return;
    }

    const btn = $("pubMentorSubmitBtn");
    btn.disabled = true;
    btn.textContent = "Submitting…";
    publicApiPost(body)
      .then((res) => {
        btn.disabled = false;
        btn.textContent = "Submit Registration";
        if (!res || !res.ok) {
          errEl.textContent = (res && res.error) || "Couldn't submit — please try again.";
          errEl.classList.remove("hidden");
          return;
        }
        $("pubMentorFormWrap").classList.add("hidden");
        $("pubMentorSuccess").classList.remove("hidden");
      })
      .catch(() => {
        btn.disabled = false;
        btn.textContent = "Submit Registration";
        errEl.textContent = "Couldn't reach the server. Check your connection and try again.";
        errEl.classList.remove("hidden");
      });
  }

  // ---------------------------------------------------------------------
  // PUBLIC PARENT-ASSISTED STUDENT REGISTRATION — no sign-in required.
  // Same reasoning as the public Mentor Registration above (own fetch
  // helpers, no token/session, no sync queue) — the only difference is this
  // one requires explicit parent/guardian consent fields, since students
  // are minors and there's no WG2 staff member present to vouch for them.
  // ---------------------------------------------------------------------
  // Parents/students pick their real class name only — never "Group A" or
  // "Group B". Grade 10's two groups exist purely for WG2's internal
  // scheduling (splitting Grade 10 across two session waves so rooms/
  // mentors aren't overloaded — see the Schedule sheet), and every class is
  // already tagged G10A or G10B by a Lead/Assistant Lead/Zone Coordinator in
  // Dashboard -> Classes & Streams. So here, G10A and G10B are merged into
  // one visible "Grade 10" optgroup — each <option> still carries its real
  // cohort (F4/G10A/G10B) via data-cohort, read back at submit time (see
  // submitPublicStudentRegister) — so the whole class is grouped together
  // automatically, with nobody outside WG2 ever needing to know or guess
  // which group/time slot a given class landed in.
  function populatePublicClassSelect_(classes) {
    const sel = $("psClass");
    const byGrade = { F4: [], G10: [] }; // G10 = G10A + G10B merged for display only
    classes.forEach((c) => { (byGrade[c.cohort === "F4" ? "F4" : "G10"] = byGrade[c.cohort === "F4" ? "F4" : "G10"] || []).push(c); });
    const gradeLabels = { F4: "Form 4", G10: "Grade 10" };
    const groups = Object.keys(gradeLabels)
      .map((grade) => {
        const opts = (byGrade[grade] || [])
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((c) => `<option value="${escAttr(c.name)}" data-cohort="${escAttr(c.cohort)}">${esc(c.name)}</option>`)
          .join("");
        return opts ? `<optgroup label="${escAttr(gradeLabels[grade])}">${opts}</optgroup>` : "";
      })
      .join("");
    sel.innerHTML = '<option value="">— pick a class —</option>' + groups;
    $("psClassEmptyHint").classList.toggle("hidden", classes.length > 0);
  }

  function loadPublicClasses() {
    if (DEMO_MODE) { populatePublicClassSelect_([]); return; }
    publicApiGet("classes_public")
      .then((res) => populatePublicClassSelect_(res && res.ok ? res.classes || [] : []))
      .catch(() => populatePublicClassSelect_([]));
  }

  // Career-first picker (see CAREERS_HEADERS/SEED_CAREERS in Code.gs) — a
  // single flat, alphabetically-sorted list of career NAMES per rank (no
  // zone/cluster grouping), since a student thinks "I want to be a Surgeon",
  // not "I want Zone A". Shared builder: used for both the registration
  // form (#psChoiceSelects) and the self-service edit form
  // (#peChoiceSelects) — containerId/rankAttr keep the two independent so
  // they never accidentally read/write each other's selects.
  function careerOptionsHtml_(careers) {
    const sorted = careers.slice().sort((a, b) => a.name.localeCompare(b.name));
    return sorted.map((c) => `<option value="${escAttr(c.id)}" data-desc="${escAttr(c.description || "")}">${esc(c.name)}</option>`).join("");
  }

  function buildCareerChoiceSelects_(containerId, rankAttr, careers) {
    const optionsHtml = `<option value="">— not selected —</option>` + careerOptionsHtml_(careers);
    let html = "";
    for (let i = 1; i <= 6; i++) {
      html += `
      <div class="choice-block">
        <div class="choice-row">
          <span class="rank">${i}.</span>
          <select data-${rankAttr}="${i}">${optionsHtml}</select>
        </div>
        <div class="career-desc" data-${rankAttr}-desc="${i}"></div>
      </div>`;
    }
    const container = $(containerId);
    container.innerHTML = html;
    container.querySelectorAll(`[data-${rankAttr}]`).forEach((sel) => {
      sel.addEventListener("change", () => {
        const rank = sel.dataset[rankAttr === "ps-choice-rank" ? "psChoiceRank" : "peChoiceRank"];
        const opt = sel.options[sel.selectedIndex];
        const descEl = container.querySelector(`[data-${rankAttr}-desc="${rank}"]`);
        if (descEl) descEl.textContent = opt && opt.dataset.desc ? opt.dataset.desc : "";
      });
    });
  }

  // Pre-selects rank 1..N selects from a comma-separated list of career ids
  // (e.g. loading an existing registration into the edit form) and fires
  // the description text for each, same as a real user selection would.
  function prefillCareerChoiceSelects_(containerId, rankAttr, careerIdsCsv) {
    const ids = String(careerIdsCsv || "").split(",").map((s) => s.trim()).filter(Boolean);
    const container = $(containerId);
    const selects = Array.from(container.querySelectorAll(`[data-${rankAttr}]`));
    selects.forEach((sel, i) => {
      sel.value = ids[i] || "";
      sel.dispatchEvent(new Event("change"));
    });
  }

  // After building the picker, applies+clears state.pendingQuizCareerIds if
  // the student got here via the Discover Your Career quiz's "Register now
  // with these picks" button (see handleCareerQuizRegisterNow_) — the
  // quiz's whole point is a wasted trip if her picks don't actually land in
  // the real form.
  function applyPendingQuizChoicesIfAny_() {
    if (state.pendingQuizCareerIds && state.pendingQuizCareerIds.length) {
      prefillCareerChoiceSelects_("psChoiceSelects", "ps-choice-rank", state.pendingQuizCareerIds.join(","));
      state.pendingQuizCareerIds = null;
    }
  }

  function loadPublicCareersForStudentForm_() {
    if (DEMO_MODE) { buildCareerChoiceSelects_("psChoiceSelects", "ps-choice-rank", CAREER_CATALOG); applyPendingQuizChoicesIfAny_(); return; }
    publicApiGet("careers_public")
      .then((res) => { buildCareerChoiceSelects_("psChoiceSelects", "ps-choice-rank", res && res.ok && res.careers && res.careers.length ? res.careers : CAREER_CATALOG); applyPendingQuizChoicesIfAny_(); })
      .catch(() => { buildCareerChoiceSelects_("psChoiceSelects", "ps-choice-rank", CAREER_CATALOG); applyPendingQuizChoicesIfAny_(); });
  }

  function collectCareerChoices_(containerId, rankAttr) {
    const selects = document.querySelectorAll(`#${containerId} [data-${rankAttr}]`);
    const picked = [];
    selects.forEach((s) => { const v = s.value.trim(); if (v && picked.indexOf(v) === -1) picked.push(v); });
    return picked.join(",");
  }

  function resetPublicStudentForm_() {
    $("pubStudentForm").reset();
    $("pubStudentError").classList.add("hidden");
    $("pubStudentFormWrap").classList.remove("hidden");
    $("pubStudentSuccess").classList.add("hidden");
    const btn = $("pubStudentSubmitBtn");
    btn.disabled = false;
    btn.textContent = "Submit Registration";
  }

  function showPublicStudentRegister() {
    $("loginScreen").classList.add("hidden");
    $("publicStudentScreen").classList.remove("hidden");
    resetPublicStudentForm_();
    loadPublicClasses();
    loadPublicCareersForStudentForm_();
  }
  function hidePublicStudentRegister() {
    $("publicStudentScreen").classList.add("hidden");
    $("loginScreen").classList.remove("hidden");
  }

  function submitPublicStudentRegister(e) {
    e.preventDefault();
    const errEl = $("pubStudentError");
    errEl.classList.add("hidden");

    const parentName = $("psParentName").value.trim();
    const parentContact = $("psParentContact").value.trim();
    const name = $("psName").value.trim();
    const classSel = $("psClass");
    const classStream = classSel.value;
    // The cohort (F4/G10A/G10B) rides along on the selected <option> as
    // data-cohort — set by populatePublicClassSelect_ from that class's own
    // record in Classes & Streams — never asked of the parent directly. This
    // is what keeps a whole class together in the same Grade 10 group/time
    // slot automatically. Falls back to "F4" only if something odd happens
    // (e.g. the option somehow has no data-cohort) so submission can't
    // silently send a blank cohort the server would reject.
    const selectedOption = classSel.options[classSel.selectedIndex];
    const cohort = (selectedOption && selectedOption.dataset.cohort) || "F4";
    const consent = $("psConsent").checked;

    if (!parentName) { errEl.textContent = "Parent/guardian full name is required."; errEl.classList.remove("hidden"); return; }
    if (!parentContact) { errEl.textContent = "Parent/guardian phone or email is required."; errEl.classList.remove("hidden"); return; }
    if (!name) { errEl.textContent = "Student's full name is required."; errEl.classList.remove("hidden"); return; }
    if (!classStream) { errEl.textContent = "Please select a class/stream."; errEl.classList.remove("hidden"); return; }
    if (!consent) { errEl.textContent = "A parent or guardian must confirm consent to submit."; errEl.classList.remove("hidden"); return; }

    const body = {
      action: "public_register_student",
      parentName, parentContact, name,
      cohort,
      classStream,
      careerChoices: collectCareerChoices_("psChoiceSelects", "ps-choice-rank"),
      otherCareerRequest: $("psOtherCareer").value.trim(),
      email: $("psEmail").value.trim(),
      parentConsent: true,
    };

    if (DEMO_MODE) {
      errEl.textContent = "Demo mode has no live backend to submit to — connect the app in config.js to try this for real.";
      errEl.classList.remove("hidden");
      return;
    }

    const btn = $("pubStudentSubmitBtn");
    btn.disabled = true;
    btn.textContent = "Submitting…";
    publicApiPost(body)
      .then((res) => {
        btn.disabled = false;
        btn.textContent = "Submit Registration";
        if (!res || !res.ok) {
          errEl.textContent = (res && res.error) || "Couldn't submit — please try again.";
          errEl.classList.remove("hidden");
          return;
        }
        if (res.duplicateWarning) $("pubStudentSuccessMsg").textContent = res.duplicateWarning + " If this was already submitted, no need to do it again.";
        $("pubStudentSuccessId").textContent = res.id || "—";
        $("pubStudentFormWrap").classList.add("hidden");
        $("pubStudentSuccess").classList.remove("hidden");
      })
      .catch(() => {
        btn.disabled = false;
        btn.textContent = "Submit Registration";
        errEl.textContent = "Couldn't reach the server. Check your connection and try again.";
        errEl.classList.remove("hidden");
      });
  }

  // ---------------------------------------------------------------------
  // PUBLIC EDIT CAREER CHOICES — no sign-in required. Career Day ID + full
  // name proves ownership (checked server-side in publicLookupStudent_/
  // publicUpdateStudentChoices_); open until STUDENT_CHOICE_DEADLINE_ISO.
  // ---------------------------------------------------------------------
  let peCurrentStudent_ = null;

  function resetPublicEditForm_() {
    $("peLookupWrap").classList.remove("hidden");
    $("peEditWrap").classList.add("hidden");
    $("peLookupError").classList.add("hidden");
    $("peEditError").classList.add("hidden");
    $("peEditSuccess").classList.add("hidden");
    $("peCareerDayId").value = "";
    $("peName").value = "";
    const btn = $("peLookupBtn");
    btn.disabled = false;
    btn.textContent = "Find Registration";
    peCurrentStudent_ = null;
  }

  function showPublicEditChoices_() {
    $("loginScreen").classList.add("hidden");
    $("publicEditScreen").classList.remove("hidden");
    resetPublicEditForm_();
  }
  function hidePublicEditChoices_() {
    $("publicEditScreen").classList.add("hidden");
    $("loginScreen").classList.remove("hidden");
  }

  function lookupPublicStudent_() {
    const errEl = $("peLookupError");
    errEl.classList.add("hidden");
    const careerDayId = $("peCareerDayId").value.trim();
    const name = $("peName").value.trim();
    if (!careerDayId || !name) {
      errEl.textContent = "Both the Career Day ID and the student's full name are required.";
      errEl.classList.remove("hidden");
      return;
    }
    if (DEMO_MODE) {
      errEl.textContent = "Demo mode has no live backend to look up a real registration.";
      errEl.classList.remove("hidden");
      return;
    }
    const btn = $("peLookupBtn");
    btn.disabled = true;
    btn.textContent = "Looking up…";
    publicApiPost({ action: "public_lookup_student", careerDayId, name })
      .then((res) => {
        btn.disabled = false;
        btn.textContent = "Find Registration";
        if (!res || !res.ok) {
          errEl.textContent = (res && res.error) || "Couldn't find that registration — please try again.";
          errEl.classList.remove("hidden");
          return;
        }
        peCurrentStudent_ = res.student;
        $("peEditingWhoMsg").textContent = "Editing career choices for " + res.student.name + " (" + res.student.classStream + ").";
        publicApiGet("careers_public")
          .then((cres) => {
            const careers = cres && cres.ok && cres.careers && cres.careers.length ? cres.careers : CAREER_CATALOG;
            buildCareerChoiceSelects_("peChoiceSelects", "pe-choice-rank", careers);
            prefillCareerChoiceSelects_("peChoiceSelects", "pe-choice-rank", res.student.careerChoices);
            $("peOtherCareer").value = res.student.otherCareerRequest || "";
          })
          .catch(() => buildCareerChoiceSelects_("peChoiceSelects", "pe-choice-rank", CAREER_CATALOG));
        $("peLookupWrap").classList.add("hidden");
        $("peEditWrap").classList.remove("hidden");
        if (res.deadlinePassed) {
          $("peEditError").textContent = "The 27 Aug 2026, 12:00pm EAT deadline has passed — choices shown here are read-only. Contact WG2 directly if something needs correcting.";
          $("peEditError").classList.remove("hidden");
          $("peSaveBtn").disabled = true;
        } else {
          $("peSaveBtn").disabled = false;
        }
      })
      .catch(() => {
        btn.disabled = false;
        btn.textContent = "Find Registration";
        errEl.textContent = "Couldn't reach the server. Check your connection and try again.";
        errEl.classList.remove("hidden");
      });
  }

  function savePublicStudentChoices_() {
    if (!peCurrentStudent_) return;
    const errEl = $("peEditError");
    errEl.classList.add("hidden");
    $("peEditSuccess").classList.add("hidden");
    const btn = $("peSaveBtn");
    btn.disabled = true;
    btn.textContent = "Saving…";
    publicApiPost({
      action: "public_update_student_choices",
      careerDayId: peCurrentStudent_.id,
      name: peCurrentStudent_.name,
      careerChoices: collectCareerChoices_("peChoiceSelects", "pe-choice-rank"),
      otherCareerRequest: $("peOtherCareer").value.trim(),
    })
      .then((res) => {
        btn.disabled = false;
        btn.textContent = "Save Changes";
        if (!res || !res.ok) {
          errEl.textContent = (res && res.error) || "Couldn't save — please try again.";
          errEl.classList.remove("hidden");
          return;
        }
        $("peEditSuccess").classList.remove("hidden");
      })
      .catch(() => {
        btn.disabled = false;
        btn.textContent = "Save Changes";
        errEl.textContent = "Couldn't reach the server. Check your connection and try again.";
        errEl.classList.remove("hidden");
      });
  }

  // ---------------------------------------------------------------------
  // PUBLIC CAREERS & CLUSTERS GUIDE — no sign-in required. Read-only
  // reference combining what used to live in two separate documents
  // (student-facing Career Guide + Careers Handbook): room-per-cluster,
  // careers-per-cluster, and an alphabetical glossary, all searchable.
  // Reachable from the login screen, from mid-registration (so a parent can
  // check a career's description before picking it), and — see setTab/
  // renderAccessGatedUI — from inside the signed-in app too.
  // ---------------------------------------------------------------------
  let cgData_ = null; // { careers, clusters } — fetched once per screen open
  let cgReturnTo_ = "loginScreen"; // which screen to reveal again on close

  function loadCareersGuideData_() {
    $("cgIntro").textContent = "Loading…";
    const fetchCareers = DEMO_MODE
      ? Promise.resolve({ ok: true, careers: CAREER_CATALOG })
      : publicApiGet("careers_public").catch(() => ({ ok: false }));
    const fetchClusters = DEMO_MODE
      ? Promise.resolve({ ok: true, clusters: CLUSTER_CATALOG })
      : publicApiGet("clusters_public").catch(() => ({ ok: false }));
    Promise.all([fetchCareers, fetchClusters]).then(([cRes, zRes]) => {
      cgData_ = {
        careers: cRes && cRes.ok && cRes.careers && cRes.careers.length ? cRes.careers : CAREER_CATALOG,
        clusters: zRes && zRes.ok && zRes.clusters && zRes.clusters.length ? zRes.clusters : CLUSTER_CATALOG,
      };
      $("cgIntro").textContent = "Every mentorship cluster on Boma Career Day 2026, the careers under it, and which room hosts it. Search a career by name, or filter by zone below. A full alphabetical glossary is at the bottom.";
      renderCareersGuideZoneChips_();
      renderCareersGuideContent_();
    });
  }

  function renderCareersGuideZoneChips_() {
    const zones = Object.keys(ZONE_NAMES);
    const active = state.cgActiveZone || "";
    const chips = [`<button class="chip${active === "" ? " active" : ""}" data-zone="">All Zones</button>`]
      .concat(zones.map((z) => `<button class="chip${active === z ? " active" : ""}" data-zone="${escAttr(z)}">Zone ${esc(z)}</button>`));
    $("cgZoneChips").innerHTML = chips.join("");
  }

  function handleCareersGuideZoneChipClick_(e) {
    const btn = e.target.closest("[data-zone]");
    if (!btn) return;
    state.cgActiveZone = btn.dataset.zone;
    renderCareersGuideZoneChips_();
    renderCareersGuideContent_();
  }

  function renderCareersGuideContent_() {
    if (!cgData_) return;
    const q = ($("cgSearch").value || "").trim().toLowerCase();
    const activeZone = state.cgActiveZone || "";
    const clustersByZone = {};
    cgData_.clusters.forEach((c) => { (clustersByZone[c.zone] = clustersByZone[c.zone] || []).push(c); });
    const careersByCluster = {};
    cgData_.careers.forEach((c) => { (careersByCluster[c.clusterId] = careersByCluster[c.clusterId] || []).push(c); });
    const zoneOrder = Object.keys(ZONE_NAMES).filter((z) => !activeZone || z === activeZone);

    // Content page (table of contents) — every cluster, in zone order, with
    // its room, so a student/parent can jump straight to a cluster or check
    // room assignments at a glance without reading the whole guide.
    let toc = '<div class="cg-section"><h3>Contents — Clusters &amp; Rooms</h3><ul class="cg-toc">';
    zoneOrder.forEach((z) => {
      (clustersByZone[z] || []).slice().sort((a, b) => a.id.localeCompare(b.id)).forEach((c) => {
        toc += `<li><a href="#cg-${esc(c.id)}">${esc(c.id)} — ${esc(c.name)}</a><span class="cg-room">Room ${esc(c.room || c.id)}</span></li>`;
      });
    });
    toc += "</ul></div>";

    let sections = "";
    zoneOrder.forEach((z) => {
      const clusters = (clustersByZone[z] || []).slice().sort((a, b) => a.id.localeCompare(b.id));
      if (!clusters.length) return;
      sections += `<div class="cg-zone-heading">Zone ${esc(z)} — ${esc(ZONE_NAMES[z])}</div>`;
      clusters.forEach((c) => {
        let careers = (careersByCluster[c.id] || []).slice().sort((a, b) => a.name.localeCompare(b.name));
        if (q) careers = careers.filter((cr) => cr.name.toLowerCase().indexOf(q) !== -1 || (cr.description || "").toLowerCase().indexOf(q) !== -1);
        if (q && !careers.length) return;
        sections += `<div class="cg-cluster" id="cg-${esc(c.id)}">
          <div class="cg-cluster-head"><b>${esc(c.id)} — ${esc(c.name)}</b><span class="cg-room">Room ${esc(c.room || c.id)}</span></div>
          <ul class="cg-careers">${careers.map((cr) => `<li><b>${esc(cr.name)}</b> — ${esc(cr.description || "")}</li>`).join("")}</ul>
        </div>`;
      });
    });

    // Alphabetical glossary of every career, regardless of zone filter —
    // this is the reference list, so it always shows the full picture
    // (still respects the search box, since that's "find a specific
    // career," not "browse by zone").
    let glossaryCareers = cgData_.careers.slice().sort((a, b) => a.name.localeCompare(b.name));
    if (q) glossaryCareers = glossaryCareers.filter((cr) => cr.name.toLowerCase().indexOf(q) !== -1 || (cr.description || "").toLowerCase().indexOf(q) !== -1);
    let glossary = '<div class="cg-section"><h3>Glossary — All Careers A–Z</h3><ul class="cg-glossary">';
    glossaryCareers.forEach((cr) => {
      const cluster = cgData_.clusters.find((c) => c.id === cr.clusterId);
      glossary += `<li><b>${esc(cr.name)}</b><span class="cg-room">${esc(cr.clusterId)}${cluster ? " — " + esc(cluster.name) : ""}</span><br>${esc(cr.description || "")}</li>`;
    });
    glossary += "</ul></div>";

    $("cgContent").innerHTML = toc + sections + glossary;
  }

  // source: true/"studentForm" (opened mid-registration), "app" (opened by
  // a signed-in team member from the topbar — #app itself is never given a
  // "hidden" class, it just sits behind this fixed-position overlay, same
  // as every login-screen — so closing just removes the overlay), or
  // anything else/undefined -> back to the sign-in screen.
  function showCareersGuide_(source) {
    cgReturnTo_ = source === "app" ? "app" : source ? "publicStudentScreen" : "loginScreen";
    ["loginScreen", "publicMentorScreen", "publicStudentScreen", "publicEditScreen"].forEach((id) => $(id).classList.add("hidden"));
    $("careersGuideScreen").classList.remove("hidden");
    $("closeCareersGuideBtn").textContent = cgReturnTo_ === "app" ? "← Close" : "← Back to Sign In";
    $("cgSearch").value = "";
    state.cgActiveZone = "";
    loadCareersGuideData_();
  }
  function hideCareersGuide_() {
    $("careersGuideScreen").classList.add("hidden");
    if (cgReturnTo_ !== "app") $(cgReturnTo_).classList.remove("hidden");
  }

  // ---------------------------------------------------------------------
  // DISCOVER YOUR CAREER — the "AI Career Guide" quiz screen. No sign-in
  // required, same public-screen overlay pattern as the Careers Guide
  // above (cqReturnTo_ mirrors cgReturnTo_). Reachable two ways:
  //   - from the login screen (openCareerQuizBtn) — a student explores on
  //     her own; the result screen's CTA is "Register now with these
  //     picks", which opens registration and carries her selected careers
  //     forward via state.pendingQuizCareerIds (applied once the picker
  //     finishes loading — see loadPublicCareersForStudentForm_).
  //   - from mid-registration (openCareerQuizBtnInline, next to "See all
  //     careers & descriptions") — she's already on the form, so the
  //     result screen's CTA writes straight into the live #psChoiceSelects
  //     picker via prefillCareerChoiceSelects_ and drops her right back
  //     into the form with her picks already filled in.
  // Either way, nothing is auto-submitted — "suggest, then she still
  // picks": she taps which suggested careers she actually wants, in the
  // order she wants them, before anything touches the real form.
  // ---------------------------------------------------------------------
  let cqData_ = null; // { careers, clusters } — same shape/fetch as cgData_
  let cqReturnTo_ = "loginScreen";
  const CQ_TOTAL_ = CAREER_QUIZ_QUESTIONS_.length;

  function resetCareerQuizState_() {
    state.careerQuiz = { step: 0, answers: [], selectedCareerIds: [] };
  }

  function loadCareerQuizCareerData_() {
    const fetchCareers = DEMO_MODE
      ? Promise.resolve({ ok: true, careers: CAREER_CATALOG })
      : publicApiGet("careers_public").catch(() => ({ ok: false }));
    const fetchClusters = DEMO_MODE
      ? Promise.resolve({ ok: true, clusters: CLUSTER_CATALOG })
      : publicApiGet("clusters_public").catch(() => ({ ok: false }));
    return Promise.all([fetchCareers, fetchClusters]).then(([cRes, zRes]) => {
      cqData_ = {
        careers: cRes && cRes.ok && cRes.careers && cRes.careers.length ? cRes.careers : CAREER_CATALOG,
        clusters: zRes && zRes.ok && zRes.clusters && zRes.clusters.length ? zRes.clusters : CLUSTER_CATALOG,
      };
    });
  }

  function showCareerQuiz_(source) {
    cqReturnTo_ = source ? "publicStudentScreen" : "loginScreen";
    ["loginScreen", "publicMentorScreen", "publicStudentScreen", "publicEditScreen", "careersGuideScreen"].forEach((id) => $(id).classList.add("hidden"));
    $("careerQuizScreen").classList.remove("hidden");
    resetCareerQuizState_();
    $("cqBody").innerHTML = '<p class="pubreg-desc">Loading…</p>';
    (cqData_ ? Promise.resolve() : loadCareerQuizCareerData_()).then(renderCareerQuizQuestion_);
  }

  function hideCareerQuiz_() {
    $("careerQuizScreen").classList.add("hidden");
    $(cqReturnTo_).classList.remove("hidden");
  }

  const CQ_MAX_PICKS_PER_QUESTION_ = 3;

  // Sums every SELECTED option's cluster weights across every question
  // answered so far. Multi-select is intentional — a student who's genuinely
  // torn between "hospital ward" and "construction site" shouldn't have to
  // pretend she isn't; picking both just means both clusters fairly earn
  // points from that question, same as if she'd answered it twice. Each
  // question stores an ARRAY of selected option indices (see
  // resetCareerQuizState_/handleCareerQuizBodyClick_), capped at
  // CQ_MAX_PICKS_PER_QUESTION_ so one question can't single-handedly decide
  // the result. Returns every cluster with any score, ranked highest first;
  // ties broken alphabetically by cluster id so results are reproducible.
  function computeCareerQuizResults_() {
    const totals = {};
    (state.careerQuiz.answers || []).forEach((optIndices, qIndex) => {
      const q = CAREER_QUIZ_QUESTIONS_[qIndex];
      if (!q || !optIndices) return;
      optIndices.forEach((optIndex) => {
        const opt = q.options[optIndex];
        if (!opt) return;
        Object.keys(opt.weights).forEach((clusterId) => {
          totals[clusterId] = (totals[clusterId] || 0) + opt.weights[clusterId];
        });
      });
    });
    return Object.keys(totals)
      .map((clusterId) => ({ clusterId, score: totals[clusterId] }))
      .sort((a, b) => b.score - a.score || a.clusterId.localeCompare(b.clusterId));
  }

  function renderCareerQuizQuestion_() {
    const step = state.careerQuiz.step;
    const q = CAREER_QUIZ_QUESTIONS_[step];
    if (!q) { renderCareerQuizResult_(); return; }
    const picked = state.careerQuiz.answers[step] || [];
    const pct = Math.round((step / CQ_TOTAL_) * 100);
    $("cqBody").innerHTML = `
      <div class="cq-progress-track"><div class="cq-progress-fill" style="width:${pct}%;"></div></div>
      <div class="cq-step-label">Question ${step + 1} of ${CQ_TOTAL_}</div>
      <div class="cq-question">${esc(q.q)}</div>
      <p class="hint" style="margin:-8px 0 12px 0;">Pick 1–${CQ_MAX_PICKS_PER_QUESTION_} that feel most like you.</p>
      <div class="cq-options">
        ${q.options
          .map((opt, i) => {
            const isPicked = picked.indexOf(i) !== -1;
            const rank = isPicked ? picked.indexOf(i) + 1 : null;
            return `<button type="button" class="cq-option${isPicked ? " cq-option-picked" : ""}" data-cq-answer="${i}">${isPicked ? `<span class="cq-option-check">✓</span>` : ""}${esc(opt.text)}</button>`;
          })
          .join("")}
      </div>
      <div class="cq-nav-row">
        ${step > 0 ? `<button type="button" class="link-btn" id="cqBackBtn">← Previous</button>` : "<span></span>"}
        <button type="button" class="btn primary" id="cqNextBtn"${picked.length ? "" : " disabled"}>${step === CQ_TOTAL_ - 1 ? "See my result →" : "Next question →"}</button>
      </div>
    `;
  }

  function handleCareerQuizBodyClick_(e) {
    const answerBtn = e.target.closest("[data-cq-answer]");
    if (answerBtn) {
      const optIndex = Number(answerBtn.dataset.cqAnswer);
      const step = state.careerQuiz.step;
      const picked = state.careerQuiz.answers[step] || (state.careerQuiz.answers[step] = []);
      const at = picked.indexOf(optIndex);
      if (at !== -1) picked.splice(at, 1);
      else if (picked.length < CQ_MAX_PICKS_PER_QUESTION_) picked.push(optIndex);
      renderCareerQuizQuestion_();
      return;
    }
    if (e.target.closest("#cqNextBtn")) {
      if (!(state.careerQuiz.answers[state.careerQuiz.step] || []).length) return;
      state.careerQuiz.step += 1;
      renderCareerQuizQuestion_();
      return;
    }
    if (e.target.closest("#cqBackBtn")) {
      state.careerQuiz.step = Math.max(0, state.careerQuiz.step - 1);
      renderCareerQuizQuestion_();
      return;
    }
    const chip = e.target.closest("[data-cq-career-chip]");
    if (chip) {
      const id = chip.dataset.cqCareerChip;
      const sel = state.careerQuiz.selectedCareerIds;
      const at = sel.indexOf(id);
      if (at !== -1) sel.splice(at, 1);
      else if (sel.length < 6) sel.push(id);
      renderCareerQuizResult_();
      return;
    }
    if (e.target.closest("#cqRetakeBtn")) { resetCareerQuizState_(); renderCareerQuizQuestion_(); return; }
    if (e.target.closest("#cqUseChoicesBtn")) { handleCareerQuizUseChoices_(); return; }
    if (e.target.closest("#cqRegisterNowBtn")) { handleCareerQuizRegisterNow_(); return; }
  }

  // Result-screen career chips — every career in the top-matched cluster
  // (plus its #2/#3 runners-up), tappable to build the ordered list that
  // "Use these as my choices"/"Register now with these picks" will apply.
  // Tap order IS rank order, exactly like manually filling the real
  // ranked-choice picker, just faster and grounded in her actual answers.
  function careerChipsHtml_(clusterId) {
    const careers = (cqData_.careers || []).filter((c) => c.clusterId === clusterId).sort((a, b) => a.name.localeCompare(b.name));
    if (!careers.length) return "";
    return `<div class="cq-chip-row">${careers
      .map((c) => {
        const rank = state.careerQuiz.selectedCareerIds.indexOf(c.id);
        return `<button type="button" class="cq-chip${rank !== -1 ? " cq-chip-picked" : ""}" data-cq-career-chip="${escAttr(c.id)}" title="${escAttr(c.description || "")}">${rank !== -1 ? `<span class="cq-chip-rank">${rank + 1}</span>` : ""}${esc(c.name)}</button>`;
      })
      .join("")}</div>`;
  }

  function miniMatchCardHtml_(result, rank) {
    const cluster = cqData_.clusters.find((c) => c.id === result.clusterId);
    const insight = CLUSTER_QUIZ_INSIGHTS_[result.clusterId];
    if (!cluster || !insight) return "";
    return `<div class="cq-mini-card">
      <div class="cq-mini-emoji">${insight.emoji}</div>
      <div class="cq-mini-body">
        <div class="cq-mini-rank">#${rank} match</div>
        <div class="cq-mini-name">${esc(insight.archetype)} — ${esc(cluster.name)}</div>
        ${careerChipsHtml_(result.clusterId)}
      </div>
    </div>`;
  }

  function renderCareerQuizResult_() {
    const results = computeCareerQuizResults_();
    if (!results.length) { $("cqBody").innerHTML = '<p class="empty">Something went wrong scoring the quiz — tap Retake to try again.</p><button type="button" class="btn ghost" id="cqRetakeBtn" style="width:100%;margin-top:8px;">↻ Retake the Quiz</button>'; return; }
    const top = results[0];
    const runnersUp = results.slice(1, 3);
    const cluster = cqData_.clusters.find((c) => c.id === top.clusterId);
    const insight = CLUSTER_QUIZ_INSIGHTS_[top.clusterId];
    const matchPct = Math.min(99, Math.round((top.score / (top.score + (results[1] ? results[1].score : 0) + 0.001)) * 100));

    $("cqBody").innerHTML = `
      <div class="cq-result-hero">
        <div class="cq-result-emoji">${insight.emoji}</div>
        <div class="cq-result-archetype">${esc(insight.archetype)}</div>
        <div class="cq-result-cluster">${esc(cluster.id)} · ${esc(cluster.name)}</div>
        <div class="cq-result-match">Strongest match — ${matchPct}% lean toward this over your next best fit</div>
      </div>

      <div class="cq-section-title">Why this fits you</div>
      <p class="cq-fit-text">${esc(insight.fit)}</p>

      <div class="cq-section-title">Subjects to pay close attention to</div>
      <div class="cq-subject-chips">${insight.subjects.map((s) => `<span class="cq-subject-chip">${esc(s)}</span>`).join("")}</div>

      <div class="cq-section-title">Careers to explore in this cluster — tap to add to your choices</div>
      ${careerChipsHtml_(top.clusterId)}

      ${runnersUp.length ? `
      <div class="cq-section-title">If you don't get exactly this — your next-best matches</div>
      <p class="hint">Genuinely good alternatives, not consolation prizes — these scored high for you too. Mentors and skills often overlap across clusters.</p>
      ${runnersUp.map((r, i) => miniMatchCardHtml_(r, i + 2)).join("")}
      ` : ""}

      <div class="cq-actions">
        ${cqReturnTo_ === "publicStudentScreen"
          ? `<button type="button" class="btn primary" id="cqUseChoicesBtn" style="width:100%;">Use ${state.careerQuiz.selectedCareerIds.length || ""} selected as my choices →</button>`
          : `<button type="button" class="btn primary" id="cqRegisterNowBtn" style="width:100%;">Register now with these picks →</button>`}
        <button type="button" class="btn ghost" id="cqRetakeBtn" style="width:100%;margin-top:8px;">↻ Retake the Quiz</button>
      </div>
    `;
  }

  // Mid-registration entry point: the picker (#psChoiceSelects) already
  // exists in the DOM (just hidden behind this overlay), so this writes
  // straight into it and drops her back into the form with picks filled —
  // no reload, no round-trip.
  function handleCareerQuizUseChoices_() {
    const ids = state.careerQuiz.selectedCareerIds;
    if (!ids.length) { alert("Tap at least one career above first — then it'll be added to your choices."); return; }
    prefillCareerChoiceSelects_("psChoiceSelects", "ps-choice-rank", ids.join(","));
    hideCareerQuiz_();
  }

  // Standalone (login-screen) entry point: no registration form is open
  // yet, so stash the picks and open registration; loadPublicCareersForStudentForm_
  // applies+clears state.pendingQuizCareerIds once the real picker has
  // finished loading (see that function).
  function handleCareerQuizRegisterNow_() {
    state.pendingQuizCareerIds = state.careerQuiz.selectedCareerIds.slice();
    $("careerQuizScreen").classList.add("hidden");
    showPublicStudentRegister();
  }

  // The two downloadable PDFs ARE the two official WG2 documents this
  // in-app page summarises — "Your Career Guide" (zones/rooms/short career
  // list + the A-Z index) and its "Career Briefs Addendum" (one full page
  // per career: getting there, a day in the life, skills, where it leads).
  // Shipped as static files alongside the app (this same www folder), not
  // generated client-side, so what a parent downloads/prints always matches
  // the real, designed documents. Replace these files if WG2 ever issues an
  // updated edition; nothing else here needs to change.
  function downloadCareerGuidePdf_() {
    window.open("WG2_Boma_Career_Day_2026_Student_Career_Guide.pdf", "_blank");
  }
  function downloadCareerBriefsAddendumPdf_() {
    window.open("WG2_Boma_Career_Day_2026_Career_Briefs_Addendum.pdf", "_blank");
  }

  // Team Brief. The Brief tab already shows this content natively, but
  // "View Full Brief" loads the standalone WG2_Team_Brief.html — its own
  // tabbed/charted interactive version — into briefWebScreen's iframe, so
  // it opens INSIDE the app shell instead of leaving it. "Open in New
  // Tab" (inside that screen) and "Download PDF" stay as real
  // window.open calls, since forwarding a link/file to someone outside
  // the app is a genuinely different action from viewing it in-app.
  function openTeamBriefWeb_() {
    $("briefWebFrame").src = "WG2_Team_Brief.html";
    $("briefWebScreen").classList.remove("hidden");
  }
  function closeTeamBriefWeb_() {
    $("briefWebScreen").classList.add("hidden");
    $("briefWebFrame").src = "about:blank";
  }
  function downloadTeamBriefPdf_() {
    window.open("WG2_Team_Brief.pdf", "_blank");
  }

  // ---------------------------------------------------------------------
  // TABS
  // ---------------------------------------------------------------------
  const ALL_TABS = ["tasks", "team", "register", "checkin", "schedule", "dashboard", "hub", "reports", "brief", "guide", "docs"];
  function setTab(tab) {
    state.activeTab = tab;
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    ALL_TABS.forEach((t) => $("view-" + t).classList.toggle("hidden", t !== tab));
    if (tab === "dashboard") renderDashboard();
    if (tab === "hub") renderHubTab_();
    if (tab === "schedule") renderSchedule();
    if (tab === "brief") renderBrief();
    if (tab === "reports") renderReportsTab_();
    if (tab === "docs") renderDocs();
    if (tab === "guide") renderGuideTab_();
    if (tab !== "checkin") stopScanning();
  }

  // ---- Team Brief tab (signed-in account holders only). The top of the
  // tab (countdown, "what the app does" cards, schedule gantt) is the same
  // for everyone and stays static HTML in index.html. The "Your
  // Orientation" section right below it is the one dynamic part besides
  // the countdown — it's rendered here per person, matched to their own
  // role/access level, so a Mentor never has to read a Zone Coordinator's
  // duties to find their own. ----
  function renderBrief() {
    const eventDate = new Date("2026-08-29T07:00:00");
    const now = new Date();
    const diffMs = eventDate - now;
    const box = $("briefCountdown");
    if (!box) return;
    if (diffMs > 0) {
      const days = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      box.innerHTML = "<b>" + days + " day" + (days === 1 ? "" : "s") + "</b> to go — Saturday, 29 August 2026";
    } else {
      box.innerHTML = "It's Career Day week — <b>29 August 2026</b>";
    }
    renderBriefRoleSection_();
  }

  // ---------------------------------------------------------------------
  // ROLE ORIENTATION — "what to expect on the day" and "what's expected of
  // you," per role, condensed from the Role SOPs document for quick in-app
  // reading (the full SOP with RACI tables etc. is still available as a
  // download from the Docs tab for core team). Keyed by the exact `role`
  // string stored on a Team row (see TEAM_HEADERS/ROOM_MENTOR_ROLES/
  // LEADERSHIP_ROLE_OPTIONS_) so lookup is a direct match, no guessing.
  // ---------------------------------------------------------------------
  const ROLE_ORIENTATION_ = {
    "Lead": {
      icon: "👑",
      summary: "Final decision-maker for WG2 — you own the mentorship strategy and are the last stop on the escalation ladder.",
      whatToExpect: [
        "You're not tied to one zone — expect to move across all five, with roving oversight the whole day.",
        "You're based at the Command Post alongside a WG8 lead and a Secretariat rep, reachable by phone/WhatsApp throughout.",
        "Escalations an Assistant Lead couldn't resolve land with you — especially anything affecting the programme's timing.",
      ],
      whatsExpected: [
        "Sign off the cluster structure, zone assignments, and Zone Coordinator appointments ahead of the day.",
        "Chair the Mentor Briefing Session and run the final check-in call with Cluster Leads and Zone Coordinators.",
        "Make the final call on any decision that affects programme timing, then loop in Secretariat.",
      ],
      escalation: "You're the top of WG2's own ladder — beyond you, it's Secretariat.",
      whereToFind: [
        { task: "Everything needing a decision right now", where: "Dashboard → Needs Attention" },
        { task: "Mentor & cluster coverage at a glance, fill a gap", where: "Hub tab → Overview, Occupancy Grid & Auto-Allocate" },
        { task: "Approve a mentor application or leadership request", where: "Team tab → Mentor Applications / Leadership Candidates" },
        { task: "Run the final allocation", where: "Dashboard → Allocation" },
        { task: "Message a zone, cluster, or the whole team", where: "Team tab → Chat, or Dashboard → Send Update" },
        { task: "Full team roster & access levels", where: "Team tab" },
      ],
    },
    "Assistant Lead": {
      icon: "🧭",
      summary: "Roving oversight of your assigned zones — the layer between Zone Coordinators and the Lead.",
      whatToExpect: [
        "Present at the 9:00am room-ready check, then roving your assigned zones through all three mentorship windows.",
        "You're the live escalation contact Zone Coordinators call first — reachable by phone/WhatsApp at all times.",
      ],
      whatsExpected: [
        "Own the roster, workplan, Cluster Allocation Matrix, Mentor Handbook, and every SOP for your zones.",
        "Own the WG2 App rollout and data quality in your zones — Mentor Database, Session Coverage, task assignment.",
        "Confirm each Zone Coordinator's fit during Phase 0, and support them if a zone is short-handed.",
      ],
      escalation: "A mentor no-show or overcrowding a Zone Coordinator can't resolve alone escalates to you. Anything whole-zone or spanning multiple zones, you pass on to the Lead.",
      whereToFind: [
        { task: "Everything needing a decision in your zones", where: "Dashboard → Needs Attention" },
        { task: "Mentor & cluster coverage for any zone, fill a gap", where: "Hub tab → Occupancy Grid & Auto-Allocate" },
        { task: "Confirm a Zone Coordinator's fit / support a short-handed zone", where: "Team tab → filter by zone" },
        { task: "Registration & team confirmation progress", where: "Dashboard → Registration Progress, Team Confirmation" },
        { task: "Message your zones", where: "Team tab → each Zone's group chat" },
      ],
    },
    "Zone Coordinator": {
      icon: "🗺️",
      summary: "WG2's single point of contact for every cluster in your zone.",
      whatToExpect: [
        "Present and active across your zone's clusters through all three mentorship windows — effectively on duty from before 9:00am through 4:00pm.",
        "You're the first responder for a mentor no-show or an overcrowded room in your zone.",
      ],
      whatsExpected: [
        "Confirm a Cluster Lead and Sub-Lead for every cluster in your zone ahead of the day — the single most important pre-event task for this role.",
        "Know every cluster room's location and every mentor's shift assignment in your zone.",
        "On the day: text a backup mentor from the app's suggested-candidates list (Dashboard → Session Coverage) if someone doesn't show; redirect overflow from an overcrowded cluster; coordinate any room change with WG8's on-site contact.",
      ],
      escalation: "If you can't resolve a no-show or overcrowding yourself, escalate to your Assistant Lead. Anything spanning multiple zones goes straight to the Assistant Lead or Lead.",
      whereToFind: [
        { task: "Your zone's mentor/cluster status at a glance", where: "Hub tab → Occupancy Grid (or Dashboard → Zone Breakdown)" },
        { task: "Confirm a Cluster Lead & Sub-Lead for every cluster in your zone", where: "Team tab → filter by zone" },
        { task: "Find a backup mentor for a no-show", where: "Dashboard → Session Coverage, or Hub → Cluster Command Center" },
        { task: "Mentor status / check-ins on the day", where: "Dashboard → Mentor Status Board (filter your zone)" },
        { task: "Message your zone", where: "Team tab → your Zone's group chat" },
        { task: "Your own action points", where: "Dashboard → Needs Attention" },
      ],
    },
    "Cluster Lead": {
      icon: "🎯",
      summary: "Owns facilitation and timekeeping for one cluster room.",
      whatToExpect: [
        "Arrive by the 9:00am room-ready target for your shift's first window.",
        "The same room hosts all three cohorts in sequence — you'll run this more than once across the day if your shift covers more than one window.",
      ],
      whatsExpected: [
        "Confirm your attendance and shift, review the discussion guide for your cluster, and attend the Mentor Briefing Session beforehand.",
        "Check in with your Zone Coordinator on arrival; confirm mentor headcount and room setup.",
        "Keep every round to time (25 min + 5 min changeover), make sure every student gets to speak or ask a question.",
        "Distribute the mentor feedback form/QR before mentors leave, and report headcount to your Zone Coordinator.",
      ],
      escalation: "A mentor doesn't show, or the room is overcrowded — contact your Zone Coordinator immediately, don't try to solve it silently.",
      whereToFind: [
        { task: "Your cluster's action points, mentors & gaps", where: "My Day tab (top of screen)" },
        { task: "Call or WhatsApp a mentor in your cluster", where: "My Day → your cluster card → outreach buttons" },
        { task: "Your session guide (talking points, activity)", where: "Guide tab, or My Day → Session Guide link" },
        { task: "Your room & session times", where: "Schedule tab → My Room" },
      ],
    },
    "Sub-Lead": {
      icon: "📋",
      summary: "Handles QR check-in, room/AV readiness, and attendance tracking — so the mentor stays free to mentor.",
      whatToExpect: [
        "Before each window: confirm the room-readiness checklist and re-check AV if that window's mentor is Live virtual or Pre-recorded.",
        "At the start of each round: check in incoming students via the app's Check-In → Scan QR tab (or Search if a card's damaged or the camera's unavailable).",
      ],
      whatsExpected: [
        "Install the app, sign in, and test the QR scanner before the day.",
        "Log attendance throughout — this feeds the Dashboard's live view for Command Post visibility.",
        "If a mentor doesn't show: absorb the group informally as a stopgap until your Zone Coordinator arranges a backup.",
      ],
      escalation: "AV failure mid-session — escalate to the Intern AV team. Mentor no-show — absorb the group, notify your Cluster Lead and Zone Coordinator immediately.",
      whereToFind: [
        { task: "Your cluster's action points, mentors & gaps", where: "My Day tab (top of screen)" },
        { task: "Scan a student's QR code / search them in", where: "Check-In tab → Scan QR / Search" },
        { task: "Call or WhatsApp a mentor in your cluster", where: "My Day → your cluster card → outreach buttons" },
        { task: "Your room & session times", where: "Schedule tab → My Room" },
      ],
    },
    "Mentor": {
      icon: "🎤",
      summary: "Delivers the actual mentorship conversation — the core purpose of the day.",
      whatToExpect: [
        "Morning shift covers Form 4's window only (10:45–12:15). Afternoon shift covers both Grade 10 waves back-to-back (13:00–16:00). Either/Both covers the full day.",
        "Each round is 25 minutes with a hard stop, so the next round or rotation isn't delayed.",
      ],
      whatsExpected: [
        "Confirm your attendance and shift, and attend the Mentor Briefing Session beforehand.",
        "Review your cluster's session guide (Guide tab, or one tap from My Day) — talking points, careers, an activity, a \"For Our Girls\" note.",
        "If joining Live virtual or Pre-recorded, confirm tech readiness with your Cluster Sub-Lead in advance, not for the first time on the day.",
        "Complete the mentor feedback form/QR before leaving the venue.",
      ],
      escalation: "Anything blocking your session (AV, overcrowding, a student issue) — flag it to your Cluster Sub-Lead or Cluster Lead immediately rather than working around it solo.",
      whereToFind: [
        { task: "Your session time, room & cohort", where: "Schedule tab → My Room" },
        { task: "Talking points, activity & slide for your cluster", where: "Guide tab, or My Day → 🎤 Your Session Guide" },
        { task: "Check in on the day", where: "Check-In tab" },
        { task: "Something's wrong on the day", where: "Contact your Cluster Sub-Lead or Cluster Lead directly" },
      ],
    },
    "Intern": {
      icon: "🧑‍💼",
      summary: "WG2's operational engine — registration, recruitment follow-up, materials prep, plus AV sweep and on-call support.",
      whatToExpect: [
        "Pre-doors AV sweep of all 23 rooms before the 9:00am room-ready target — screen on, correct input, sound check.",
        "On-call for AV issues all day, alongside staffing the registration/walk-in desk with class teachers.",
      ],
      whatsExpected: [
        "You can bulk-import mentor sign-ups collected outside the app (spreadsheet, WhatsApp, paper) straight into the system: Dashboard → Mentor Applications → Bulk Import Mentors.",
        "Action every coverage gap the app's Dashboard and My Day panel surface (Session Coverage cards, suggested-mentor list) ahead of the day.",
        "Send final logistics to every confirmed mentor, and prepare on-the-day materials — signage, attendance sheets, discussion guides, feedback QR codes.",
        "You have access to the Leads & Interns chat channel for direct coordination.",
      ],
      escalation: "Multiple AV issues at once — triage by cluster demand; escalate to your Zone Coordinator if still unresolved before the next window.",
      whereToFind: [
        { task: "Sessions that need filling right now", where: "My Day tab (top of screen)" },
        { task: "Bulk-import mentor sign-ups collected outside the app", where: "Dashboard → Mentor Applications → Bulk Import Mentors" },
        { task: "Check students/mentors in", where: "Check-In tab" },
        { task: "Find a student's schedule", where: "Schedule tab → Find Student" },
        { task: "Every cluster's mentor status", where: "My Day → Cluster Command Center (bottom of screen)" },
      ],
    },
    "Class Teacher": {
      icon: "🏫",
      summary: "WG2's essential day-of partner for anything that touches students directly.",
      whatToExpect: [
        "On the day, you're an additional marshal alongside WG2 Zone Coordinators — focused on corridor/junction points, not just zone entrances.",
        "You'll staff the walk-in desk jointly with a WG2 intern.",
      ],
      whatsExpected: [
        "Run pre-registration as a supervised in-class session — far more reliable than an unsupervised link.",
        "Once allocation runs, open Schedule → My Class (auto-filtered to your own stream) and project it in class so students see their confirmed placement before anything is printed.",
        "Distribute wristbands and printed QR Itinerary Cards in class with a short orientation: wristband colours, and how to use the Digital Day Guide if a card is lost.",
      ],
      escalation: "Coordinate through your WG8 lead; for anything touching a specific zone's rooms or schedule, the zone's WG2 Zone Coordinator is your on-the-ground contact.",
      whereToFind: [
        { task: "Your class's registration progress", where: "My Day tab (top of screen)" },
        { task: "Print QR codes / download your class roster", where: "Register tab → your class" },
        { task: "Find a specific student", where: "Schedule tab → Find Student / My Class" },
        { task: "Your class's confirmed schedule", where: "Schedule tab → My Class" },
      ],
    },
  };

  function briefRoleOrientationHtml_(entry, roleLabel) {
    const expectItems = entry.whatToExpect.map((t) => `<li>${esc(t)}</li>`).join("");
    const expectedItems = entry.whatsExpected.map((t) => `<li>${esc(t)}</li>`).join("");
    const whereItems = (entry.whereToFind || [])
      .map((w) => `<div class="brief-where-row"><span class="brief-where-task">${esc(w.task)}</span><span class="brief-where-loc">→ ${esc(w.where)}</span></div>`)
      .join("");
    return `
      <div class="brief-role" id="briefRoleCard">
        <span class="brief-role-chip">Your role</span>
        <h5>${entry.icon} ${esc(roleLabel)}</h5>
        <p class="brief-role-summary">${esc(entry.summary)}</p>
        <div class="brief-role-sub">What to expect on the day</div>
        <ul>${expectItems}</ul>
        <div class="brief-role-sub">What's expected of you</div>
        <ul>${expectedItems}</ul>
        ${whereItems ? `<div class="brief-role-sub">Where to find things</div><div class="brief-where-list">${whereItems}</div>` : ""}
        <div class="brief-role-escalation"><b>If something goes wrong:</b> ${esc(entry.escalation)}</div>
      </div>`;
  }

  // One-tap link from wherever a role actually lands (exec Dashboard for
  // Lead/Assistant Lead/Zone Coordinator, My Day for everyone else) to their
  // full orientation — so no one has to already know the Brief tab exists
  // and holds this. Renders nothing if the role has no entry (e.g. a
  // hand-typed custom role via Team Access) rather than showing a dead link.
  function roleGuideBannerHtml_(role) {
    const entry = ROLE_ORIENTATION_[role];
    if (!entry) return "";
    return `
      <button type="button" class="role-guide-banner" data-jump-role-guide>
        <span class="role-guide-banner-icon">${entry.icon}</span>
        <span class="role-guide-banner-body">
          <span class="role-guide-banner-title">Your role: ${esc(role)}</span>
          <span class="role-guide-banner-sub">Full guide, what's expected of you, and where to find things →</span>
        </span>
      </button>`;
  }

  function jumpToRoleGuide_() {
    setTab("brief");
    setTimeout(() => {
      const card = $("briefRoleCard");
      if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
  }

  function renderBriefRoleSection_() {
    const el = $("briefRoleSection");
    if (!el) return;
    const me = state.session ? state.team.find((t) => t.id === state.session.memberId) : null;
    const role = (me && me.role) || (state.session && state.session.role) || "";
    const entry = ROLE_ORIENTATION_[role];
    if (!entry) {
      // Fallback for anyone whose role string doesn't match one of the
      // known keys above (e.g. a custom role typed in by hand via Team
      // Access) — points them to what's still reliably true for everyone.
      el.innerHTML = `
        <div class="brief-role">
          <h5>👋 Welcome to the team</h5>
          <p class="brief-role-summary">We don't have a specific orientation written for "${esc(role || "your role")}" yet — the general notes below still apply to you, and a Lead or Assistant Lead can fill in the rest.</p>
        </div>`;
      return;
    }
    el.innerHTML = briefRoleOrientationHtml_(entry, role);
  }

  // ---------------------------------------------------------------------
  // CLUSTER SESSION GUIDE — visible to every signed-in role (no accessLevel
  // or role gate at all, unlike the Docs tab below), because mentors are
  // this content's primary audience. Content lives in cluster_guide_2026.js
  // (CLUSTERS_2026 / ZONES_2026 / GUIDE_NOT_SCRIPT_NOTE, loaded as a plain
  // global via its own <script> tag) — static reference material, so no
  // Code.gs endpoint or Sheet is involved. guideOpenIds_ just remembers
  // which cards are expanded across re-renders in this session; it isn't
  // persisted anywhere.
  // ---------------------------------------------------------------------
  let guideOpenIds_ = {};

  // Reuses the same free-text-matching helper the Room pane and Capacity &
  // Coverage panel already rely on (teamMemberCluster), so "your cluster"
  // here always agrees with what the rest of the app considers your
  // cluster — no separate parsing logic to drift out of sync.
  function myGuideClusterId_() {
    const me = state.team.find((t) => t.id === (state.session && state.session.memberId));
    if (!me || me.role !== "Mentor") return null;
    const c = teamMemberCluster(me);
    return c ? c.id : null;
  }

  function guideCareerRowHtml_(cr) {
    return `<div class="guide-career-row"><b>${esc(cr.title)}</b>${esc(cr.pointer)}</div>`;
  }
  function guideListItemsHtml_(items) {
    return `<ul class="guide-ul">${items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`;
  }

  function guideCardHtml_(c, isPinned) {
    const zone = ZONES_2026.find((z) => z.id === c.zone) || { color: "999999", name: "" };
    const open = !!guideOpenIds_[c.id];
    return `
      <div class="guide-card${open ? " open" : ""}${isPinned ? " guide-your-cluster" : ""}" data-cluster="${escAttr(c.id)}">
        <div class="guide-card-head" data-toggle-guide="${escAttr(c.id)}">
          <span class="guide-card-dot" style="background:#${zone.color};"></span>
          <span class="guide-card-code" style="color:#${zone.color};">${esc(c.id)}</span>
          <div class="guide-card-title">
            <div class="guide-card-name">${esc(c.name)}${isPinned ? ' <span class="guide-pin-badge">Your cluster</span>' : ""}</div>
            <div class="guide-card-zone">Zone ${esc(c.zone)} &middot; Room ${esc(c.id)} (placeholder)</div>
          </div>
          <span class="guide-card-chevron">&#9662;</span>
        </div>
        <div class="guide-card-body">
          <div class="guide-tagline" style="color:#${zone.color};">${esc(c.tagline)}</div>
          <div class="guide-section-title">Why This Matters</div>
          <p class="guide-p">${esc(c.whyItMatters)}</p>
          <div class="guide-section-title">Careers in This Cluster</div>
          ${c.careers.map(guideCareerRowHtml_).join("")}
          <div class="guide-section-title">Key Talking Points</div>
          ${guideListItemsHtml_(c.talkingPoints)}
          <div class="guide-section-title">For Our Girls: Rising Above</div>
          <div class="guide-girls-box">
            <b>${esc(c.forGirls.title.replace(/^For our girls — /i, ""))}</b>
            <p>${esc(c.forGirls.body)}</p>
          </div>
          <div class="guide-section-title">Suggested Activity</div>
          <p class="guide-p">${esc(c.activity)}</p>
          <div class="guide-section-title">Sample Q&amp;A Prompts</div>
          ${guideListItemsHtml_(c.qa)}
          <div class="guide-section-title">Closing Challenge</div>
          <p class="guide-p" style="font-weight:700;">${esc(c.closing)}</p>
          <div class="guide-section-title">Materials Checklist</div>
          ${guideListItemsHtml_(c.materials)}
        </div>
      </div>`;
  }

  function renderGuideTab_() {
    const listEl = $("guideList");
    if (!listEl || typeof CLUSTERS_2026 === "undefined") return;

    const noteEl = $("guideNotScriptNote");
    if (noteEl) noteEl.innerHTML = `<b>A guide, not a script.</b> ${esc(GUIDE_NOT_SCRIPT_NOTE)}`;

    const myClusterId = myGuideClusterId_();
    const pinned = myClusterId ? CLUSTERS_2026.find((c) => c.id === myClusterId) : null;
    const pinPanel = $("guideMyClusterPanel");
    if (pinPanel) {
      pinPanel.innerHTML = pinned
        ? `<div class="group-label">Your Cluster</div>${guideCardHtml_(pinned, true)}`
        : "";
    }

    const chipsEl = $("guideZoneChips");
    if (chipsEl && !chipsEl.dataset.built) {
      chipsEl.innerHTML = ['<button type="button" class="chip active" data-zone="">All Zones</button>']
        .concat(ZONES_2026.map((z) => `<button type="button" class="chip" data-zone="${escAttr(z.id)}">Zone ${esc(z.id)}</button>`))
        .join("");
      chipsEl.dataset.built = "1";
    }
    const activeZone = state.guideZoneFilter || "";
    if (chipsEl) chipsEl.querySelectorAll(".chip").forEach((b) => b.classList.toggle("active", (b.dataset.zone || "") === activeZone));

    const q = ($("guideSearch") ? $("guideSearch").value : "").trim().toLowerCase();
    let list = CLUSTERS_2026.slice();
    if (activeZone) list = list.filter((c) => c.zone === activeZone);
    if (q) {
      list = list.filter((c) => {
        const hay = (c.id + " " + c.name + " " + c.tagline + " " + c.careers.map((cr) => cr.title).join(" ")).toLowerCase();
        return hay.indexOf(q) !== -1;
      });
    }
    listEl.innerHTML = list.length
      ? list.map((c) => guideCardHtml_(c, false)).join("")
      : '<div class="empty">No clusters match your search.</div>';
  }

  function handleGuideListClick_(e) {
    const head = e.target.closest("[data-toggle-guide]");
    if (!head) return;
    const id = head.dataset.toggleGuide;
    guideOpenIds_[id] = !guideOpenIds_[id];
    renderGuideTab_();
  }
  function handleGuideZoneChipClick_(e) {
    const b = e.target.closest(".chip[data-zone]");
    if (!b) return;
    state.guideZoneFilter = b.dataset.zone || "";
    renderGuideTab_();
  }

  // My Day quick-link (Mentor role block) — jumps straight to the tab and
  // scrolls to/expands the signed-in mentor's own cluster.
  function jumpToMyGuideCluster_() {
    const id = myGuideClusterId_();
    if (!id) return;
    setTab("guide");
    guideOpenIds_[id] = true;
    state.guideZoneFilter = "";
    if ($("guideSearch")) $("guideSearch").value = "";
    renderGuideTab_();
    setTimeout(() => {
      const card = $("guideMyClusterPanel") && $("guideMyClusterPanel").querySelector(".guide-card");
      if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 30);
  }

  // ---- Docs & Orientation tab (canViewDocs() gated — core team only) ----
  // "Today's Focus" mirrors the Coordination Playbook's Section 17 full
  // checklist, grouped into the same phases, and points at whichever phase
  // the calendar says we should be focused on right now (days-to-event).
  // This is a date-driven pointer, NOT a live tracker — the definitive
  // live status is the Tasks tab / the app's own Sheet, same as Section 17
  // itself says. Recomputed every time the Docs tab is opened, so it's
  // always current without needing any push/notification infrastructure.
  const CHECKLIST_PHASES = [
    {
      label: "Foundation",
      sub: "Roster, structure, zones",
      items: [
        "Confirm WG2 Lead and both Assistant Leads",
        "Confirm the 23-cluster / 5-zone structure",
        "Appoint 5 Zone Coordinators",
        "Submit the WG2 budget to WG1 Finance",
        "Assign a Zone Coordinator/liaison to every cluster",
      ],
    },
    {
      label: "Mentor Recruitment & Materials",
      sub: "Recruiting, database, handbook drafts",
      items: [
        "Open the mentor recruitment drive across all 23 clusters",
        "Stand up and maintain the Mentor Database",
        "Get Grade 10 / Form 4 headcounts and room capacities from WG8",
        "Draft the Mentorship Strategy Document and Cluster Discussion Guide",
        "Draft the Mentor Handbook",
      ],
    },
    {
      label: "Build & Brief",
      sub: "Finalising the plan, SOPs, mentor briefing",
      items: [
        "Finalise the Cluster Allocation Matrix (mentors, rooms, time slots, cohorts)",
        "Finalise student-to-cluster assignment with WG8",
        "Finalise the Mentor Handbook and Cluster Leader SOP",
        "Schedule and hold the Mentor Briefing Session",
        "Confirm the Mentor Feedback Tool is live in the app",
      ],
    },
    {
      label: "Confirm & Rehearse",
      sub: "Final logistics, escalation plan, rehearsal",
      items: [
        "Send final logistics to every confirmed mentor",
        "Confirm every cluster's room fits all three cohort windows",
        "Finalise the Escalation Plan and circulate to Zone Coordinators",
        "Prepare on-the-day materials: signage, rosters, discussion guides",
        "Rehearse student movement with WG8",
        "Final check-in call with all Cluster Leads and Zone Coordinators",
      ],
    },
    {
      label: "Event-Day Setup",
      sub: "Morning of — rooms, AV, check-in",
      items: [
        "All 23 rooms and AV ready by 9:00am",
        "Pre-doors AV sweep completed",
        "Zone Coordinators, Cluster Leads, Sub-Leads and Mentors checked in per shift",
      ],
    },
    {
      label: "Post-Event",
      sub: "Wrap-up",
      items: [
        "Compile mentor feedback results",
        "Send mentor thank-you/appreciation messages",
        "Draft the Post-Event Impact Report",
        "Update the Mentor Database and Cluster Reference for future Career Days",
      ],
    },
  ];
  // Thresholds are days-to-event (Sat 29 Aug 2026). Tuned so the phase
  // shown roughly matches the pace the Playbook was actually written at —
  // see Section 17's phase groupings for the full item lists.
  function currentChecklistPhaseIndex_() {
    const eventDate = new Date("2026-08-29T00:00:00");
    const today = new Date();
    const daysToEvent = Math.round((eventDate - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
    if (daysToEvent > 21) return 0; // Foundation
    if (daysToEvent > 14) return 1; // Mentor Recruitment & Materials
    if (daysToEvent > 7) return 2; // Build & Brief
    if (daysToEvent > 0) return 3; // Confirm & Rehearse
    if (daysToEvent === 0) return 4; // Event-Day Setup
    return 5; // Post-Event
  }
  function renderDocs() {
    const panel = $("docsFocusPanel");
    if (!panel) return;
    const idx = currentChecklistPhaseIndex_();
    const phase = CHECKLIST_PHASES[idx];
    const next = CHECKLIST_PHASES[idx + 1];
    let html = '<div class="brief-howto">';
    html += "<b>" + esc(phase.label) + "</b> — " + esc(phase.sub);
    html += '<ul style="margin:8px 0 0 0;padding-left:16px;font-size:11.5px;">';
    phase.items.forEach((it) => { html += "<li style='margin-bottom:4px;'>" + esc(it) + "</li>"; });
    html += "</ul></div>";
    if (next) {
      html += '<p class="hint">Coming up next: <b>' + esc(next.label) + "</b>. Full detail for every phase is in the Playbook, Section 17.</p>";
    }
    html += '<p class="hint">This is a calendar-based pointer, not a live tracker — check the Tasks tab for what\'s actually done.</p>';
    panel.innerHTML = html;
    loadTeamFiles_();
    loadStaffDirectory_();
  }

  // ---- Staff & Team Directory (Docs tab, canViewDocs()-gated) ----
  // Fixed slot order + labels for the Leadership/Zones group. Zone
  // Coordinators are sorted A→E by matching state.staffDirectory's `zone`
  // field ("Zone A".."Zone E") against this list, not hardcoded names, so a
  // roster change shows up automatically next time the tab is opened.
  const DIRECTORY_ROLE_ORDER_ = ["Lead", "Assistant Lead", "Zone Coordinator", "School Liaison"];
  const DIRECTORY_ZONE_ORDER_ = ["Zone A", "Zone B", "Zone C", "Zone D", "Zone E"];

  function loadStaffDirectory_() {
    if (DEMO_MODE || !state.session) return;
    apiGet("staff_directory").then((res) => {
      if (!res || !res.ok) return;
      state.staffDirectory = res.directory || [];
      renderStaffDirectory_();
    });
  }

  // Sorts a copy of state.staffDirectory into { leadership, interns }, and
  // synthesizes a placeholder "School Liaison — TBC" row if the roster has
  // no one in that role yet, so the section never just silently disappears.
  function groupedStaffDirectory_() {
    const rows = state.staffDirectory.slice();
    const hasSchoolLiaison = rows.some((r) => r.role === "School Liaison");
    if (!hasSchoolLiaison) {
      rows.push({ name: "TBC", role: "School Liaison", zone: "", phone: "", status: "", placeholder: true });
    }
    const leadership = rows
      .filter((r) => DIRECTORY_ROLE_ORDER_.indexOf(r.role) !== -1)
      .sort((a, b) => {
        const roleDiff = DIRECTORY_ROLE_ORDER_.indexOf(a.role) - DIRECTORY_ROLE_ORDER_.indexOf(b.role);
        if (roleDiff !== 0) return roleDiff;
        return DIRECTORY_ZONE_ORDER_.indexOf(a.zone) - DIRECTORY_ZONE_ORDER_.indexOf(b.zone);
      });
    const interns = rows.filter((r) => r.role === "Intern").sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return { leadership, interns };
  }

  // In-app-only badge: never appears in the print window's HTML, since that
  // HTML is built fresh from the same rows without calling this function.
  function directoryNoteHtml_(r) {
    const notes = [];
    if (r.placeholder) notes.push("not yet assigned");
    else {
      if (!r.phone) notes.push("missing phone");
      if (String(r.status || "").toLowerCase().indexOf("unconfirmed") !== -1) notes.push("unconfirmed");
    }
    if (!notes.length) return "";
    return `<span class="dir-note no-print">${esc(notes.join(" · "))}</span>`;
  }

  function directoryRowHtml_(r) {
    const roleLabel = r.role === "Zone Coordinator" && r.zone ? `${esc(r.role)} (${esc(r.zone)})` : esc(r.role);
    return `<div class="dir-row">
      <div class="dir-role">${roleLabel}</div>
      <div class="dir-name">${esc(r.name)}${directoryNoteHtml_(r)}</div>
      <div class="dir-phone">${r.phone ? esc(r.phone) : '<span class="dir-blank">—</span>'}</div>
    </div>`;
  }

  function renderStaffDirectory_() {
    const el = $("staffDirectoryContent");
    if (!el) return;
    if (!state.staffDirectory.length) {
      el.innerHTML = '<div class="empty">Directory not available yet.</div>';
      return;
    }
    const { leadership, interns } = groupedStaffDirectory_();
    let html = '<div class="dir-group-label">Leadership, Zones &amp; Command Post</div>';
    html += '<div class="dir-table">' + leadership.map(directoryRowHtml_).join("") + "</div>";
    html += `<div class="dir-row dir-row--static">
      <div class="dir-role">Command Post</div>
      <div class="dir-name">Cizarina, Dr Muthoni, WG8 Lead, Secretariat Rep</div>
      <div class="dir-phone"><span class="dir-blank">—</span></div>
    </div>`;
    html += '<div class="dir-group-label" style="margin-top:14px;">WG2 Interns</div>';
    html += '<div class="dir-table">' + interns.map(directoryRowHtml_).join("") + "</div>";
    el.innerHTML = html;
  }

  // Clean row for the print window — deliberately built without calling
  // directoryNoteHtml_ at all, so an in-app flag like "missing phone" or
  // "unconfirmed" can never leak onto the printed page. A blank phone still
  // prints as a fillable line, same convention as the door-sign templates.
  function directoryRowHtmlPrint_(r) {
    const roleLabel = r.role === "Zone Coordinator" && r.zone ? `${esc(r.role)} (${esc(r.zone)})` : esc(r.role);
    const phone = r.phone ? esc(r.phone) : "________________";
    return `<tr><td class="dtd-role">${roleLabel}</td><td class="dtd-name">${esc(r.name)}</td><td class="dtd-phone">${phone}</td></tr>`;
  }

  function staffDirectoryPrintTableHtml_(rows) {
    return `<table class="dtable"><thead><tr><th>Role</th><th>Name</th><th>Phone</th></tr></thead>
      <tbody>${rows.map(directoryRowHtmlPrint_).join("")}</tbody></table>`;
  }

  // Opens the same window.open()-based print view used elsewhere in the app
  // (see openQrBatchPrintView) — a fully self-contained document with its
  // own inlined styles, so it never depends on the main app's stylesheet.
  function openStaffDirectoryPrintView_() {
    if (!state.staffDirectory.length) {
      alert("Directory not loaded yet — open the Docs tab first.");
      return;
    }
    const { leadership, interns } = groupedStaffDirectory_();
    const win = window.open("", "_blank");
    if (!win) {
      alert("Pop-up blocked — please allow pop-ups for this site and try again.");
      return;
    }
    const bodyHtml = `
      <div class="dp-header">
        <div class="dp-header-top">
          <img class="dp-logo" src="${KHS_LOGO_URL}" alt="">
          <img class="dp-logo" src="${WG2_LOGO_URL}" alt="">
          <span class="dp-eventline">BOMA CAREER DAY 2026</span>
        </div>
        <div class="dp-title">Staff &amp; Team Directory</div>
        <div class="dp-sub">Who to find and where — post at the Command Post, each zone entrance, and the staff noticeboard.</div>
      </div>
      <div class="dp-section-label">Leadership, Zones &amp; Command Post</div>
      ${staffDirectoryPrintTableHtml_(leadership)}
      ${staffDirectoryPrintTableHtml_([{ role: "Command Post", name: "Cizarina, Dr Muthoni, WG8 Lead, Secretariat Rep", phone: "See individual rows", zone: "" }])}
      <div class="dp-section-label">WG2 Interns</div>
      ${staffDirectoryPrintTableHtml_(interns)}
      <div class="ticket-footer-standard">
        <div class="tfs-contact">The Kenya High School Alumnae Society &middot; ${esc(KHS_CONTACT_LINE)}</div>
        <div class="tfs-socials">${SOCIAL_LINKS_.map((s) => `<span class="tfs-social">${socialIconHtml_(s.icon)}<span>${esc(s.handle)}</span></span>`).join("")}</div>
      </div>`;
    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Staff &amp; Team Directory</title>
      <style>@page { size: A4; margin: 14mm; }
        * { box-sizing: border-box; }
        body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; color: #1A1A1A; }
        .printbar { margin: 16px; display: flex; align-items: center; gap: 10px; }
        .printbar button { background: #B82126; color: #fff; border: none; border-radius: 20px; padding: 8px 16px; font-size: 12px; font-weight: 700; cursor: pointer; }
        @media print { .printbar { display: none; } }
        .dp-header { background: linear-gradient(120deg, #7A1319, #4d0c10); color: #fff; padding: 18px 22px; }
        .dp-header-top { display: flex; align-items: center; gap: 8px; }
        .dp-logo { width: 34px; height: 34px; border-radius: 50%; }
        .dp-eventline { font-size: 12px; font-weight: 700; letter-spacing: 0.5px; }
        .dp-title { font-size: 26px; font-weight: 800; margin-top: 6px; }
        .dp-sub { font-size: 12.5px; color: #F3D9D9; margin-top: 2px; }
        .dp-section-label { font-size: 15px; font-weight: 800; color: #7A1319; margin: 18px 22px 8px; }
        .dtable { width: calc(100% - 44px); margin: 0 22px 6px; border-collapse: collapse; }
        .dtable th { text-align: left; background: #FBEAEA; font-size: 12px; padding: 8px 10px; }
        .dtable td { font-size: 12.5px; padding: 7px 10px; border-bottom: 1px solid #EEEEEE; }
        .dtd-role { width: 34%; } .dtd-name { width: 40%; } .dtd-phone { width: 26%; color: #7B7B7B; }
        .ticket-footer-standard { background: #4d0c10; color: #E8C9A0; font-size: 8.5px; text-align: center; padding: 10px 18px; letter-spacing: 0.2px; margin-top: 18px; }
        .tfs-contact { margin-bottom: 4px; }
        .tfs-socials { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px 12px; }
        .tfs-social { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
        .tfs-social svg { width: 10px; height: 10px; flex: 0 0 auto; }
      </style></head><body>
      <div class="printbar"><button onclick="window.print()">Print / Save as PDF</button>
        <span style="font-size:11px;color:#777;">Staff &amp; Team Directory &middot; live roster, no in-app notes included</span>
      </div>
      ${bodyHtml}
      </body></html>`);
    win.document.close();
  }

  // ---- Shared Team Files (Docs tab, canViewDocs()-gated) ----
  function loadTeamFiles_() {
    if (DEMO_MODE || !state.session) return;
    apiGet("team_files").then((res) => {
      if (!res || !res.ok) return;
      state.teamFiles = res.teamFiles || [];
      renderTeamFiles_();
    });
  }

  function renderTeamFiles_() {
    const list = $("teamFilesList");
    if (!list) return;
    if (!state.teamFiles.length) {
      list.innerHTML = '<div class="empty">No shared files yet — be the first to upload one.</div>';
      return;
    }
    list.innerHTML = state.teamFiles
      .slice()
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
      .map(
        (f) => `
      <div class="brief-cap">
        <div class="bc-icon">📄</div>
        <div>
          <h5><a href="${escAttr(f.fileUrl)}" target="_blank" rel="noopener">${esc(f.fileName)}</a></h5>
          <p>${f.description ? esc(f.description) + " — " : ""}${esc(f.uploadedBy)} &middot; ${esc(timeAgo(f.timestamp))}</p>
        </div>
      </div>`
      )
      .join("");
  }

  function submitTeamFileUpload_(e) {
    e.preventDefault();
    const resultEl = $("teamFileUploadResult");
    const fileInput = $("teamFileInput");
    const file = fileInput.files && fileInput.files[0];
    resultEl.textContent = "";
    if (!file) { resultEl.textContent = "Choose a file first."; return; }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      resultEl.textContent = "That file's too big (" + Math.round(file.size / 1024 / 1024) + "MB) — please keep uploads under " + Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024) + "MB.";
      return;
    }
    const btn = $("teamFileUploadBtn");
    btn.disabled = true;
    btn.textContent = "Uploading…";
    readFileAsDataUrl_(file)
      .then((dataUrl) =>
        apiPost({
          action: "upload_team_file",
          attachment: { name: file.name, dataUrl },
          description: $("teamFileDescription").value.trim(),
        })
      )
      .then((res) => {
        btn.disabled = false;
        btn.textContent = "Upload File";
        if (!res) { resultEl.textContent = "Couldn't reach the server. Check your connection and try again."; return; }
        if (res.queued) { resultEl.textContent = "You're offline — this upload is queued and will run once you're back online."; return; }
        if (!res.ok) { resultEl.textContent = res.error || "Upload failed."; return; }
        resultEl.textContent = "Uploaded.";
        fileInput.value = "";
        $("teamFileDescription").value = "";
        loadTeamFiles_();
      })
      .catch(() => {
        btn.disabled = false;
        btn.textContent = "Upload File";
        resultEl.textContent = "Couldn't read that file.";
      });
  }

  // ---------------------------------------------------------------------
  // REGISTER MODULE (students + mentors/zone leads, with QR generation)
  // ---------------------------------------------------------------------
  function setRegType(type) {
    state.regType = type;
    document.querySelectorAll("#regTypeChips [data-regtype]").forEach((b) => b.classList.toggle("active", b.dataset.regtype === type));
    $("studentForm").classList.toggle("hidden", type !== "student");
    $("mentorForm").classList.toggle("hidden", type !== "mentor");
    $("bulkPane").classList.toggle("hidden", type !== "bulk");
    $("regQrResult").classList.add("hidden");
    if (type === "student") buildChoiceSelects();
    if (type === "mentor") {
      buildZoneClusterSelect("mfZone", "mfCluster");
      updateMfModeVisibility();
    }
  }

  // Hybrid participation (mode/sessionLink) only makes sense for the
  // "Mentor" role — a Cluster Lead or Zone Coordinator is always in person.
  // The session-link field is further narrowed to just the two modes that
  // actually need a link ("In-person" mentors don't have one).
  function updateMfModeVisibility() {
    const role = $("mfRole").value;
    const isMentor = role === "Mentor";
    const isClassTeacher = role === "Class Teacher";
    $("mfModeWrap").classList.toggle("hidden", !isMentor);
    const mode = $("mfMode").value;
    const needsLink = isMentor && mode !== "In-person";
    $("mfSessionLinkWrap").classList.toggle("hidden", !needsLink);
    $("mfSessionLinkLabel").textContent = mode === "Pre-recorded" ? "Video link" : "Meeting link";
    if (!isMentor) $("mfMode").value = "In-person";
    // A Class Teacher isn't tied to a zone/cluster (they coordinate a
    // class, not a room) — swap the Zone/Cluster fields for the class
    // picker instead of leaving two irrelevant "not applicable" fields on
    // screen.
    $("mfClassStreamWrap").classList.toggle("hidden", !isClassTeacher);
    $("mfZoneWrap").classList.toggle("hidden", isClassTeacher);
    $("mfClusterWrap").classList.toggle("hidden", isClassTeacher);
    if (!isClassTeacher) $("mfClassStream").value = "";
  }

  // Hides "Class Teacher (WG8)" from the Register -> Mentor/Zone Lead role
  // picker for anyone below ops tier — see canManageOps() and the matching
  // server-side check in Code.gs. Every other role on this form stays open
  // to any signed-in team member, so only this one option is touched.
  function updateMfRoleOptionsVisibility() {
    const ctOption = $("mfRole").querySelector('option[value="Class Teacher"]');
    if (!ctOption) return;
    const allowed = canManageOps();
    ctOption.hidden = !allowed;
    ctOption.disabled = !allowed;
    if (!allowed && $("mfRole").value === "Class Teacher") {
      $("mfRole").value = "Mentor";
      updateMfModeVisibility();
    }
  }

  function updateAmModeVisibility() {
    const role = $("amRole").value;
    const isMentor = role === "Mentor";
    const isClassTeacher = role === "Class Teacher";
    $("amModeWrap").classList.toggle("hidden", !isMentor);
    if (!isMentor) $("amMode").value = "In-person";
    $("amClassStreamWrap").classList.toggle("hidden", !isClassTeacher);
    $("amZoneWrap").classList.toggle("hidden", isClassTeacher);
    $("amClusterWrap").classList.toggle("hidden", isClassTeacher);
    if (!isClassTeacher) $("amClassStream").value = "";
  }

  // Career Day IDs are now assigned by the server (see nextCareerDayId_ in
  // Code.gs) — nobody types one in, and the client can never compute the
  // real one in advance. This generates a clearly-marked, locally-unique
  // PLACEHOLDER id so the UI has something to show/track before the server
  // round trip resolves (or while a write sits in the offline queue). It is
  // always replaced by the real "KHS26-<cohort>-NNNN" id once the server
  // responds — see the reconciliation logic in submitStudentForm etc.
  function provisionalStudentId_(cohort) {
    return "KHS26-" + cohort + "-PENDING-" + Math.random().toString(36).slice(2, 7).toUpperCase();
  }

  function clustersByZone() {
    const byZone = {};
    state.clusters.forEach((c) => {
      (byZone[c.zone] = byZone[c.zone] || []).push(c);
    });
    Object.keys(byZone).forEach((z) => byZone[z].sort((a, b) => (a.id > b.id ? 1 : -1)));
    return byZone;
  }

  function clusterLabel(id) {
    const c = state.clusters.find((x) => x.id === id);
    return c ? c.id + " — " + c.name : id;
  }

  // Looks up the actual clock time for a (cohort, round) pair from the
  // Schedule sheet — e.g. Form 4's Round 1 and Grade 10 A's Round 1 happen
  // at completely different times of day (different Slots), even though
  // they're both labelled "Round 1" on a student's own record. Returns ""
  // if not set yet (e.g. Grade 10 B/Slot 3, seeded blank on purpose — see
  // SCHEDULE_HEADERS in Code.gs).
  function scheduleTime_(cohort, round) {
    const row = state.schedule.find((s) => s.cohort === cohort && String(s.round) === String(round));
    if (!row || !row.startTime) return "";
    return row.startTime + (row.endTime ? "–" + row.endTime : "");
  }

  // Per-round "R1 09:25 · A1 — Medical Practitioners" lines for a student,
  // wherever her round1..round4 are already set — this is what gets baked
  // onto her exportable QR/itinerary card (see labeledQrDataUrl) so the
  // schedule travels with the printed/downloaded/emailed image itself.
  // Deliberately NOT encoded into the QR's own scannable payload (that
  // stays just the id) — a schedule can change after a card is printed,
  // and a stale schedule baked into the one thing that has to keep
  // scanning correctly would be worse than no schedule on the QR at all.
  function studentScheduleLines_(s) {
    if (!s || s.round1 === undefined) return []; // not a student record (e.g. a mentor)
    const rounds = [s.round1, s.round2, s.round3, s.round4];
    const lines = [];
    rounds.forEach((cid, i) => {
      if (!cid) return;
      const time = scheduleTime_(s.cohort, i + 1);
      lines.push("R" + (i + 1) + (time ? " " + time : "") + " · " + clusterLabel(cid));
    });
    return lines;
  }

  // Full-detail lookup for one cluster — zone letter + full zone theme name,
  // the physical room, and the complete list of careers the Career Briefs
  // Addendum lists under it (via state.careers, keyed by clusterId).
  // Deliberately kept separate from the compact clusterLabel() above: this
  // is long-form content meant for the printable itinerary
  // (studentItineraryBlocks_ / openQrBatchPrintView), never for the
  // canvas-based QR card, which has to truncate to a fixed pixel width.
  function clusterFullInfo_(id) {
    const c = state.clusters.find((x) => x.id === id);
    if (!c) return null;
    const careers = state.careers.filter((cr) => cr.clusterId === id).map((cr) => cr.name);
    return { id: c.id, name: c.name, zone: c.zone, zoneName: ZONE_NAMES[c.zone] || "", room: c.room || c.id, careers };
  }

  // Every schedule block for one cohort (mentorship rounds 1-4 plus
  // Lab1/Lab2/Lunch/Exhibition — see SEED_SCHEDULE in Code.gs), sorted into
  // actual clock order rather than round-number order — e.g. Grade 10's
  // Lab Session I runs BEFORE Round 1, so a printed itinerary needs to
  // reflect that, not just list "R1, R2, R3, R4, Lab1, Lab2" in that order.
  function cohortDayBlocks_(cohort) {
    return state.schedule
      .filter((s) => s.cohort === cohort && s.startTime)
      .slice()
      .sort((a, b) => (a.startTime > b.startTime ? 1 : a.startTime < b.startTime ? -1 : 0));
  }

  // 15 Aug 2026 Revision 2 — each cohort now has TWO exhibition windows
  // (Exhibition1 before lunch, Exhibition2 in the afternoon) instead of
  // one, see SEED_SCHEDULE in Code.gs. "Exhibition" (no suffix) is kept as
  // a fallback label so old cached/offline data with the original single
  // block doesn't render as a raw "Exhibition" round key.
  const SCHEDULE_BLOCK_LABELS = {
    Lab1: "Lab Session I",
    Lab2: "Lab Session II",
    Lunch: "Lunch Break",
    Exhibition1: "Exhibition Tour I",
    Exhibition2: "Exhibition Tour II",
    Exhibition: "Exhibition Tour",
  };
  // 15 Aug 2026 Revision 3 — the optional 4th ("extra") mentorship round
  // isn't an ADDITION on top of everything else; it's an alternative to
  // whichever exhibition window sits in the same time slot, per cohort:
  //   - F4: the extra round shares Exhibition Tour I's slot (12:15-12:40) —
  //     a girl either tours then, or takes her 4th mentorship then.
  //     Exhibition Tour II (the full hour between labs) is compulsory for
  //     EVERYONE regardless, since it's no longer contested by round 4.
  //   - G10A/G10B: the extra round shares Exhibition Tour II's slot — take
  //     it and you're exempt from Exhibition Tour II entirely (not just
  //     "less time" for it). Exhibition Tour I (11:45-12:15, before lunch)
  //     stays compulsory for every Grade 10 student either way.
  // So whichever exhibition block this maps to for a given cohort is
  // skipped in a student's OWN itinerary once she has an actual round4
  // cluster assigned (never based on spilloverApproved alone — that's just
  // the pre-approval; the swap only takes effect once round4 is actually
  // allocated a cluster, same as every other round).
  const ROUND4_SWAPS_WITH = { F4: "Exhibition1", G10A: "Exhibition2", G10B: "Exhibition2" };

  // Icon + tag color per schedule block type — shared by the in-app Find
  // Student/My Class views and the printed itinerary card, so a "Lab"
  // block always reads the same way everywhere. "round" covers Round 1-4
  // (standard + optional extra) uniformly.
  const SCHEDULE_BLOCK_META = {
    round: { tag: "MENTORSHIP", color: "red", icon: "compass" },
    Lab1: { tag: "LAB SESSION", color: "green", icon: "flask" },
    Lab2: { tag: "LAB SESSION", color: "green", icon: "flask" },
    Lunch: { tag: "LUNCH BREAK", color: "grey", icon: "utensils" },
    Exhibition1: { tag: "EXHIBITION TOUR", color: "gold", icon: "storefront" },
    Exhibition2: { tag: "EXHIBITION TOUR", color: "gold", icon: "storefront" },
    Exhibition: { tag: "EXHIBITION TOUR", color: "gold", icon: "storefront" },
  };
  // Minimal single-color line-icon paths (24x24 viewBox), inlined so the
  // printed itinerary never depends on an external icon font/CDN. Kept
  // deliberately simple — just enough to distinguish block types at a
  // glance on a printed page.
  const SCHEDULE_ICON_SVG = {
    compass: '<circle cx="12" cy="12" r="9"/><path d="M14.5 9.5 L10.5 10.5 L9.5 14.5 L13.5 13.5 Z" fill="currentColor" stroke="none"/>',
    flask: '<path d="M9 3h6M10 3v5l-4.5 8a2 2 0 0 0 1.8 3h9.4a2 2 0 0 0 1.8-3L14 8V3"/><path d="M7.5 14h9"/>',
    utensils: '<path d="M7 3v7a2 2 0 0 0 2 2v9M7 3v7M9 3v7M7 12h2M17 3c-1.5 0-2.5 1.5-2.5 4s1 4 2.5 4v10"/>',
    storefront: '<path d="M4 9l1-5h14l1 5"/><path d="M4 9a2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0 2 2 0 0 0 4 0"/><path d="M5 9v10h14V9"/><path d="M9.5 19v-5h5v5"/>',
    // Small UI glyphs reused across the printed itinerary (time, room,
    // "MY SCHEDULE" section header, footer note) — same minimal line-icon
    // style as the block-type icons above.
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
    pin: '<path d="M12 21s-6.5-5.6-6.5-11A6.5 6.5 0 0 1 18.5 10c0 5.4-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.1"/>',
  };
  function scheduleIconHtml_(icon) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${SCHEDULE_ICON_SVG[icon] || ""}</svg>`;
  }

  // Same minimal single-color line-icon approach as SCHEDULE_ICON_SVG above
  // (24x24 viewBox, inlined so the printed ticket footer never depends on
  // an external icon font/CDN), used for the social-media row in the
  // standard footer — see SOCIAL_LINKS_.
  const SOCIAL_ICON_SVG = {
    socialX: '<path d="M4 4l16 16M20 4L4 20"/>',
    socialYoutube: '<rect x="2.5" y="6" width="19" height="12" rx="3.5"/><path d="M10 9.5l6 2.5-6 2.5Z" fill="currentColor" stroke="none"/>',
    socialInstagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="1" fill="currentColor" stroke="none"/>',
    socialLinkedin: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="7.8" cy="8.2" r="1.1" fill="currentColor" stroke="none"/><path d="M7.8 11.5v7M12.5 18.5v-4.3c0-1.6 1-2.7 2.5-2.7s2.5 1.1 2.5 2.7v4.3M12.5 11.5v1.4"/>',
    socialFacebook: '<circle cx="12" cy="12" r="9"/><path d="M14 21v-7h2.2l.4-3H14V9c0-.9.3-1.5 1.6-1.5H16.7V4.9c-.3 0-1.2-.1-2.3-.1-2.3 0-3.9 1.4-3.9 4V11H8v3h2.5v7"/>',
  };
  function socialIconHtml_(icon) {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${SOCIAL_ICON_SVG[icon] || ""}</svg>`;
  }
  // "14:05" -> "2:05 PM" — the printed itinerary uses 12-hour clock times
  // (matches how WG2's other event materials read); the Schedule sheet
  // itself stays 24-hour since that's less ambiguous for staff editing it.
  function formatTime12_(t) {
    if (!t) return "";
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim());
    if (!m) return t;
    let h = Number(m[1]);
    const min = m[2];
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12;
    if (h === 0) h = 12;
    return `${h}:${min} ${ampm}`;
  }

  // The full printable itinerary for one student — every schedule block for
  // her cohort, in clock order, as STRUCTURED data (not pre-built HTML) so
  // the print template (openQrBatchPrintView) can lay each one out as a
  // numbered timeline entry with an icon, time, room and type tag — same
  // idea as a conference badge's "My Schedule" list. Each mentorship round
  // is expanded to its full cluster name, Zone name + code, room, and the
  // complete list of careers hosted there (per the user's explicit ask:
  // "full cluster names, zone, and all careers under the chosen
  // clusters... plus the codes... plus the room" on the printout). Round 4
  // only ever appears if she's actually been allocated one —
  // spilloverApproved students only (see runAllocation_ in Code.gs) — never
  // as a blank line for everyone else.
  function studentItineraryBlocks_(s) {
    if (!s || s.round1 === undefined) return []; // not a student record (e.g. a mentor)
    const blocks = cohortDayBlocks_(s.cohort);
    return blocks
      .map((b) => {
        const time = formatTime12_(b.startTime) + (b.endTime ? " – " + formatTime12_(b.endTime) : "");
        if (/^[1-4]$/.test(String(b.round))) {
          const roundNum = Number(b.round);
          const cid = s["round" + roundNum];
          if (!cid) return null; // this round not allocated for her (e.g. optional round 4 not arranged)
          const info = clusterFullInfo_(cid);
          if (!info) return null;
          const meta = SCHEDULE_BLOCK_META.round;
          return {
            time,
            title: info.name,
            desc:
              (roundNum === 4 ? "Extra mentorship session — " : "Mentorship session — ") +
              "Zone " + info.zone + " (" + info.zoneName + ") · Code " + info.id,
            room: "Room " + info.room,
            careers: info.careers,
            tag: roundNum === 4 ? "EXTRA MENTORSHIP" : meta.tag,
            color: meta.color,
            icon: meta.icon,
          };
        }
        // This exhibition block is the one her cohort's round4 would
        // replace, and she actually has a round4 assigned — so she's
        // spending this slot in her extra mentorship session instead, not
        // touring. See ROUND4_SWAPS_WITH above.
        if (b.round === ROUND4_SWAPS_WITH[s.cohort] && s.round4) return null;
        const meta = SCHEDULE_BLOCK_META[b.round] || { tag: String(b.round).toUpperCase(), color: "grey", icon: "storefront" };
        // Grade 10's lunch window runs 2 informal shifts (eat during either
        // half; the other half becomes bonus Exhibition Tour I time) — not
        // modeled as separate schedule rows, just called out here so it
        // still reaches the printed itinerary. Doesn't apply to Form 4,
        // whose Exhibition Tour I / Lunch order is fixed (see SEED_SCHEDULE
        // notes in Code.gs).
        const desc =
          b.round === "Lunch" && (s.cohort === "G10A" || s.cohort === "G10B")
            ? "Eat during either half — the half you don't use becomes bonus Exhibition Tour I time."
            : "";
        return {
          time,
          title: SCHEDULE_BLOCK_LABELS[b.round] || String(b.round),
          desc,
          room: "",
          careers: [],
          tag: meta.tag,
          color: meta.color,
          icon: meta.icon,
        };
      })
      .filter(Boolean);
  }

  // Populates a Zone <select> and a Cluster <select> (grouped by zone) from
  // state.clusters, shared by the public mentor registration form and the
  // admin "Add Team Member" panel — both used to be free-text fields, which
  // let typos into the Team sheet's zone/cluster columns (e.g. "zone a",
  // "Zon A") that the backend's zoneLetterOf_/extractClusterId_ matching
  // couldn't always parse. Built once per pair of ids; safe to call
  // repeatedly (e.g. every time the admin panel re-renders).
  function buildZoneClusterSelect(zoneSelId, clusterSelId) {
    const zoneSel = $(zoneSelId);
    const clusterSel = $(clusterSelId);
    if (!zoneSel || !clusterSel || zoneSel.dataset.built === "1") return;
    const byZone = clustersByZone();
    const zones = Object.keys(byZone).sort();
    zoneSel.innerHTML =
      '<option value="">— none / not applicable —</option>' +
      zones.map((z) => `<option value="Zone ${esc(z)}">Zone ${esc(z)}${ZONE_NAMES[z] ? " — " + esc(ZONE_NAMES[z]) : ""}</option>`).join("");
    clusterSel.innerHTML =
      '<option value="">— none / not applicable —</option>' +
      zones
        .map((z) => {
          const opts = byZone[z]
            .map((c) => `<option value="${escAttr(c.id + " — " + c.name)}">${esc(c.id)} — ${esc(c.name)}</option>`)
            .join("");
          return `<optgroup label="Zone ${esc(z)}">${opts}</optgroup>`;
        })
        .join("");
    zoneSel.dataset.built = "1";
  }

  // Rebuilt every render (unlike buildZoneClusterSelect/buildChoiceSelects,
  // which build once) because the Classes list itself can change while
  // someone has a form open — e.g. an intern adds a missing class while a
  // teacher is mid-registration in another tab/device. Preserves whatever
  // is currently selected if it's still in the list. Shared by the student
  // registration form's Class/stream field AND the Class Teacher class
  // picker (mentor form + admin Add Team Member form) — same managed list,
  // three places it needs to appear.
  function populateClassStreamSelect_(selId, hintId) {
    const sel = $(selId);
    if (!sel) return;
    const current = sel.value;
    const byCohort = { F4: [], G10A: [], G10B: [] };
    state.classes.forEach((c) => { (byCohort[c.cohort] = byCohort[c.cohort] || []).push(c); });
    const placeholder = sel.querySelector("option[value='']");
    const placeholderText = placeholder ? placeholder.textContent : "— pick a class —";
    const groups = Object.keys(COHORT_LABELS)
      .map((coh) => {
        const opts = (byCohort[coh] || [])
          .slice()
          .sort((a, b) => naturalClassCompare_(a.name, b.name))
          .map((c) => `<option value="${escAttr(c.name)}">${esc(c.name)}</option>`)
          .join("");
        return opts ? `<optgroup label="${escAttr(COHORT_LABELS[coh])}">${opts}</optgroup>` : "";
      })
      .join("");
    sel.innerHTML = `<option value="">${esc(placeholderText)}</option>` + groups;
    if (current && state.classes.some((c) => c.name === current)) sel.value = current;
    if (hintId) {
      const hint = $(hintId);
      if (hint) hint.classList.toggle("hidden", state.classes.length > 0);
    }
  }

  function buildClassSelect() {
    populateClassStreamSelect_("sfClass", "sfClassEmptyHint");
    populateClassStreamSelect_("mfClassStream", "mfClassStreamEmptyHint");
    populateClassStreamSelect_("amClassStream", null);
  }

  function buildChoiceSelects() {
    const wrap = $("choiceSelects");
    if (!wrap || wrap.dataset.built === "1") return; // build once; options don't change at runtime
    const byZone = clustersByZone();
    const optgroups = Object.keys(byZone)
      .sort()
      .map((z) => {
        const opts = byZone[z].map((c) => `<option value="${escAttr(c.id)}">${esc(c.id)} — ${esc(c.name)}</option>`).join("");
        return `<optgroup label="Zone ${esc(z)}">${opts}</optgroup>`;
      })
      .join("");
    let html = "";
    for (let i = 1; i <= 6; i++) {
      html += `
      <div class="choice-row">
        <span class="rank">${i}.</span>
        <select data-choice-rank="${i}">
          <option value="">— not selected —</option>
          ${optgroups}
        </select>
      </div>`;
    }
    wrap.innerHTML = html;
    wrap.dataset.built = "1";
  }

  function collectChoices() {
    const selects = document.querySelectorAll("#choiceSelects [data-choice-rank]");
    const picked = [];
    selects.forEach((s) => {
      const v = s.value.trim();
      if (v && picked.indexOf(v) === -1) picked.push(v);
    });
    return picked.join(",");
  }

  function drawQr(canvas, text) {
    const qr = window.qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const size = canvas.width;
    const scale = size / count;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#1A1A1A";
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) ctx.fillRect(Math.round(c * scale), Math.round(r * scale), Math.ceil(scale), Math.ceil(scale));
      }
    }
  }

  // A bare QR code PNG — no name/ID/schedule baked into the image itself
  // (unlike labeledQrDataUrl below). Used by the new ticket-style printable
  // itinerary (openQrBatchPrintView), where the name/ID/schedule are
  // already laid out as real, naturally-wrapping HTML around the code, so
  // baking a second compact copy onto the image itself would just be
  // redundant clutter on the page.
  function plainQrDataUrl_(id, size) {
    size = size || 260;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    drawQr(canvas, id);
    return canvas.toDataURL("image/png");
  }

  function showQrResult(id, name, pending) {
    drawQr($("qrCanvas"), id);
    $("qrResultId").textContent = id;
    $("qrResultName").textContent = name;
    const note = $("qrPendingNote");
    if (note) note.classList.toggle("hidden", !pending);
    const emailStatus = $("qrEmailStatus");
    if (emailStatus) { emailStatus.textContent = ""; emailStatus.classList.add("hidden"); }
    // Only students have a mentorship/lab/lunch/exhibition day to print —
    // mentors get a QR but no itinerary, so hide the button for them.
    const printBtn = $("qrPrintScheduleBtn");
    if (printBtn) printBtn.classList.toggle("hidden", !state.students.some((s) => s.id === id));
    $("regQrResult").classList.remove("hidden");
    $("studentForm").classList.add("hidden");
    $("mentorForm").classList.add("hidden");
  }

  // "Print My Schedule" on the just-registered/looked-up QR result — reuses
  // the same rich batch print view as the staff-side bulk print, just with
  // a single student in it, so a girl (or the teacher helping her) can walk
  // away with her QR + full day itinerary on paper right away, and reprint
  // it later once rounds are actually allocated (round1-3 lines simply
  // won't appear yet if allocation hasn't run).
  function printOwnSchedule() {
    const id = $("qrResultId").textContent || "";
    const name = $("qrResultName").textContent || "";
    const record = state.students.find((s) => s.id === id);
    if (!record) return;
    openQrBatchPrintView([record], "Career Day Schedule", name);
  }

  // Renders a QR code with the person's Name and ID baked into the image
  // itself, below the code — not just shown as separate HTML/DOM text next
  // to it. Used for every QR PNG that can leave the app as a standalone
  // file (single download, batch print, email attachments), so codes never
  // get mixed up once they're detached from the page they were shown on
  // (e.g. a teacher handling a stack of printed codes, or a folder of
  // downloaded PNGs for many mentors at once). The on-screen result canvas
  // is the one exception — it keeps using plain drawQr() since the name/ID
  // are already right underneath it as separate text there.
  // extraLines: optional array of strings (e.g. from studentScheduleLines_)
  // printed below the name/ID — used to bake a student's round schedule
  // (time, cluster, topic) onto her own exportable QR card. Omitted/empty
  // for mentors and for students not yet allocated, in which case this
  // renders exactly as before.
  function labeledQrDataUrl(id, name, size, extraLines) {
    size = size || 240;
    extraLines = extraLines || [];
    const baseFooterH = 56;
    const lineH = 15;
    const footerH = baseFooterH + (extraLines.length ? 8 + extraLines.length * lineH : 0);
    const qrCanvas = document.createElement("canvas");
    qrCanvas.width = size;
    qrCanvas.height = size;
    drawQr(qrCanvas, id);

    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size + footerH;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(qrCanvas, 0, 0);

    ctx.textAlign = "center";
    const maxWidth = size - 16;

    ctx.font = "700 16px -apple-system, 'Segoe UI', Roboto, sans-serif";
    ctx.fillStyle = "#1A1A1A";
    ctx.fillText(truncateToFit_(ctx, name || "", maxWidth), size / 2, size + 24);

    ctx.font = "12px -apple-system, 'Segoe UI', Roboto, sans-serif";
    ctx.fillStyle = "#888888";
    ctx.fillText(truncateToFit_(ctx, id || "", maxWidth), size / 2, size + 42);

    if (extraLines.length) {
      ctx.font = "10.5px -apple-system, 'Segoe UI', Roboto, sans-serif";
      ctx.fillStyle = "#555555";
      let y = size + 42 + 14;
      extraLines.forEach((line) => {
        ctx.fillText(truncateToFit_(ctx, line, maxWidth), size / 2, y);
        y += lineH;
      });
    }

    return canvas.toDataURL("image/png");
  }

  // Shortens text with a trailing ellipsis so it fits maxWidth at the
  // canvas context's CURRENT font — call after setting ctx.font, since the
  // measurement depends on it.
  function truncateToFit_(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + "…").width > maxWidth) t = t.slice(0, -1);
    return t + "…";
  }

  // Emails a person their own QR code right after registration, if they
  // gave an email address. Best-effort only: registration itself has
  // already succeeded by the time this runs, so a failure here just leaves
  // a quiet status message — it never alarms the registrant or blocks
  // anything, since the QR is always still visible/downloadable either way.
  // Only updates the status line if the SAME id is still on screen, so a
  // slow email send can't overwrite the status of whatever the person has
  // since moved on to registering.
  function emailQrIfProvided(email, name, id) {
    if (!email || DEMO_MODE) return;
    const statusEl = $("qrEmailStatus");
    if (statusEl) {
      statusEl.textContent = "Emailing QR code to " + email + "…";
      statusEl.classList.remove("hidden");
    }
    const record = state.students.find((s) => s.id === id);
    apiPost({ action: "email_own_qr", to: email, name, id, dataUrl: labeledQrDataUrl(id, name, 240, studentScheduleLines_(record)) })
      .then((res) => {
        if (!statusEl || $("qrResultId").textContent !== id) return;
        statusEl.textContent =
          res && res.ok ? "Emailed to " + email + "." : "Couldn't email the QR code — you can still download it below.";
      })
      .catch(() => {
        if (statusEl && $("qrResultId").textContent === id) {
          statusEl.textContent = "Couldn't email the QR code — you can still download it below.";
        }
      });
  }

  // Registers a student. The Career Day ID is assigned by the SERVER
  // (nextCareerDayId_ in Code.gs) — nothing here ever lets a person type one
  // in or determines the final id. A placeholder id/QR is shown right away
  // so registration still feels instant, then swapped for the real
  // server-assigned id the moment the response comes back (same pattern
  // already used for mentors, above). If offline, the placeholder stays in
  // place — clearly marked "PENDING" — until the queued write actually syncs
  // and a refresh() pulls the authoritative record down (see
  // applyQueuedOverlay / flushQueue).
  function submitStudentForm(ev) {
    ev.preventDefault();
    const name = $("sfName").value.trim();
    const classStream = $("sfClass").value.trim();
    const cohort = $("sfCohort").value;
    if (!name || !classStream || !cohort) return;
    const choices = collectChoices();
    const teacherEmail = $("sfTeacherEmail").value.trim();
    const email = $("sfEmail").value.trim();
    const now = new Date().toISOString();
    const provisionalId = provisionalStudentId_(cohort);
    const record = { id: provisionalId, name, admissionNo: "", classStream, cohort, choices, round1: "", round2: "", round3: "", round4: "", status: "Pending", notes: "", createdAt: now, updatedAt: now, teacherEmail, teacherName: "", email };
    state.students.push(record);
    showQrResult(provisionalId, name, true);
    ev.target.reset();
    renderAll();
    if (!DEMO_MODE) {
      apiPost({ action: "register_student", clientId: provisionalId, name, classStream, cohort, choices, teacherEmail, email })
        .then((res) => {
          if (res && res.ok && res.id) {
            record.id = res.id;
            if ($("qrResultId").textContent === provisionalId) showQrResult(res.id, name, false);
            renderAll();
            emailQrIfProvided(email, name, res.id);
          }
          if (res && res.duplicateWarning) alert("⚠ " + res.duplicateWarning);
        })
        .catch((e) => console.error(e));
    }
  }

  function submitMentorForm(ev) {
    ev.preventDefault();
    const name = $("mfName").value.trim();
    if (!name) return;
    const phone = $("mfPhone").value.trim();
    const email = $("mfEmail").value.trim();
    const role = $("mfRole").value;
    const isClassTeacher = role === "Class Teacher";
    // Client-side convenience only — the server enforces this for real (see
    // the inline check on add_team_member/register_mentor in Code.gs). This
    // just avoids the confusing "optimistic QR appears, then silently isn't
    // really registered" experience for someone who isn't allowed to.
    if (isClassTeacher && !canManageOps()) {
      alert("Only a Lead, Assistant Lead, Zone Coordinator, or Intern can register a Class Teacher. Ask one of them to add you, or use Dashboard → Team Access.");
      return;
    }
    const zone = isClassTeacher ? "" : $("mfZone").value.trim();
    const cluster = isClassTeacher ? "" : $("mfCluster").value.trim();
    const mode = role === "Mentor" ? $("mfMode").value : "In-person";
    const sessionLink = role === "Mentor" && mode !== "In-person" ? $("mfSessionLink").value.trim() : "";
    const classStream = isClassTeacher ? $("mfClassStream").value.trim() : "";
    if (isClassTeacher && !classStream) { alert("Please pick your class/stream."); return; }
    // Provisional client-side id for instant QR — reconciled with the
    // server's authoritative id (if different) once the request resolves.
    const provisionalId = "T" + String(state.team.length + 1).padStart(3, "0");
    const now = new Date().toISOString();
    const record = { id: provisionalId, name, phone, email, role, zone, cluster, status: "Unconfirmed", notes: "", updatedAt: now, mode, sessionLink, classStream };
    state.team.push(record);
    showQrResult(provisionalId, name);
    ev.target.reset();
    renderAll();
    if (!DEMO_MODE) {
      apiPost({ action: "register_mentor", name, phone, email, role, zone, cluster, mode, sessionLink, classStream })
        .then((res) => {
          if (!res.ok && !res.queued) {
            // Roll back the optimistic add — the server refused this (e.g.
            // access denied), so it never actually happened.
            const idx = state.team.indexOf(record);
            if (idx !== -1) state.team.splice(idx, 1);
            $("regQrResult").classList.add("hidden");
            renderAll();
            alert(res.error || "Couldn't register — please try again.");
            return;
          }
          if (res.ok && res.id && res.id !== provisionalId) {
            record.id = res.id;
            if ($("qrResultId").textContent === provisionalId) showQrResult(res.id, name);
            renderAll();
          }
          if (res && res.duplicateWarning) alert("⚠ " + res.duplicateWarning);
          if (res && res.ok) emailQrIfProvided(email, name, res.id || provisionalId);
        })
        .catch((e) => console.error(e));
    }
  }

  function downloadQr() {
    const id = $("qrResultId").textContent || "qr";
    const name = $("qrResultName").textContent || "";
    const record = state.students.find((s) => s.id === id);
    const link = document.createElement("a");
    link.download = id + ".png";
    link.href = labeledQrDataUrl(id, name, 240, studentScheduleLines_(record));
    link.click();
  }

  // ---------------------------------------------------------------------
  // QR BATCH — print/download a whole class/cluster/zone/team at once, and
  // the same PNGs (base64) get reused to embed inline in a class's email.
  // ---------------------------------------------------------------------
  // Turns a Team member's raw "shifts" field (copied verbatim from their
  // Mentor Application's checkbox answer — see approveMentorApplication_ in
  // Code.gs; values are "Morning shift" / "Afternoon shift" / "Either /
  // both shifts", comma-joined if more than one box was ticked) into the
  // short line the printed mentor ticket shows under "WHEN YOU'RE NEEDED".
  // Keyword-matched rather than exact-string-matched so it still works if
  // someone hand-edits the Team sheet's shifts cell with slightly different
  // wording.
  function mentorShiftLabel_(raw) {
    const s = String(raw || "").toLowerCase();
    const morning = s.indexOf("morning") !== -1;
    const afternoon = s.indexOf("afternoon") !== -1;
    const either = s.indexOf("either") !== -1 || s.indexOf("both") !== -1;
    if (either || (morning && afternoon)) return "Either / both sessions";
    if (morning) return "Morning session";
    if (afternoon) return "Afternoon session";
    return "Session to be confirmed";
  }

  // people: [{id, name, ...}]. isStudent is detected the same way the rest
  // of the schedule code does (round1 !== undefined) — everyone gets the
  // same full-page ticket design; students get their day-of itinerary
  // timeline under it, mentors/team get a short "when you're needed" line
  // (shift + room) instead, since they have no multi-round schedule of
  // their own to print.
  function collectQrImages(people) {
    return people.map((p) => {
      const isStudent = p.round1 !== undefined;
      const clusterRow = isStudent ? null : teamMemberCluster(p);
      return {
        id: p.id,
        name: p.name,
        cohort: isStudent ? p.cohort : "",
        dataUrl: labeledQrDataUrl(p.id, p.name, 240, isStudent ? [] : studentScheduleLines_(p)),
        plainDataUrl: plainQrDataUrl_(p.id, 280),
        isStudent,
        roleTag: isStudent ? (COHORT_LABELS[p.cohort] || p.cohort || "Student") : (p.role || "Team Member"),
        subInfo: isStudent ? p.classStream || "" : (clusterRow ? clusterRow.name : p.cluster || p.zone || ""),
        room: isStudent ? "" : (clusterRow ? clusterRow.room || clusterRow.id : ""),
        shiftLabel: isStudent ? "" : mentorShiftLabel_(p.shifts),
        blocks: isStudent ? studentItineraryBlocks_(p) : [],
      };
    });
  }

  const EXHIBITION_HOURS_NOTE = "Exhibition Hall stays open until 5:30 PM for anyone who wants to keep browsing.";

  // Real event theme/slogan, confirmed from the SteerCo Action Log (not a
  // placeholder Claude made up) — replaces the earlier invented tagline.
  const EVENT_THEME = "Pathways, Possibilities and Purpose";
  const EVENT_SLOGAN = "Navigating Your Future";

  // Absolute URLs for the two logos, resolved against wherever this app is
  // actually hosted (window.location.href) rather than a hardcoded domain
  // — the printed ticket opens in a brand-new about:blank window
  // (window.open("", "_blank")), so a plain relative "khs_logo_circle.png"
  // would try to resolve against that blank page instead of the app's own
  // origin and fail to load. Both files ship alongside index.html/app.js —
  // see the Boma Career Day file delivery for wg2_logo_circle.png
  // (khs_logo_circle.png already exists, used on the login screen).
  const KHS_LOGO_URL = new URL("khs_logo_circle.png", window.location.href).href;
  const WG2_LOGO_URL = new URL("wg2_logo_circle.png", window.location.href).href;

  // Cohort band colors for the role-tag pill in the ticket header — a
  // quick color cue (red / yellow / bright pink) so a stack of printed
  // tickets can be sorted by cohort at a glance without reading text.
  // "text" is chosen per background for contrast (dark text on the light
  // yellow, white on the two saturated colors).
  const COHORT_BAND = {
    F4: { bg: "#B82126", text: "#FFFFFF" },
    G10A: { bg: "#FFC107", text: "#4A2E00" },
    G10B: { bg: "#FF2D95", text: "#FFFFFF" },
  };
  const DEFAULT_BAND = { bg: "#B8862B", text: "#FFFFFF" }; // non-student (mentor/team) role tags

  // Real KHS Alumnae Society contact details, confirmed by WG2 — printed
  // on every ticket's standard footer, below the student-specific note.
  const KHS_CONTACT_LINE = "Tel/WhatsApp: +254 112 092093  ·  boma.alumnae@gmail.com";

  // Social handles for the same footer — same order every time (X, YouTube,
  // Instagram, LinkedIn, Facebook), each with its own minimal line-icon (see
  // SOCIAL_ICON_SVG below) so they're distinguishable at a glance even
  // printed small/greyscale, not just by the handle text.
  const SOCIAL_LINKS_ = [
    { icon: "socialX", handle: "@KHS_Alumnae" },
    { icon: "socialYoutube", handle: "@KHS_Alumnae" },
    { icon: "socialInstagram", handle: "khs_alumnae" },
    { icon: "socialLinkedin", handle: "khs_alumnae" },
    { icon: "socialFacebook", handle: "The Kenya High School Alumnae Society" },
  ];

  // One numbered row in a student's printed "MY SCHEDULE" timeline — icon +
  // title + (optional) description/career list on the left, time/room/type
  // tag on the right. Mirrors a conference badge's session list, adapted to
  // WG2's own palette (see ticket CSS below) rather than copying any
  // outside event's branding.
  function ticketTimelineRowHtml_(b, i) {
    return `
        <div class="tl-row">
          <div class="tl-num">${i + 1}</div>
          <div class="tl-icon tl-icon--${esc(b.color)}">${scheduleIconHtml_(b.icon)}</div>
          <div class="tl-body">
            <div class="tl-title">${esc(b.title)}</div>
            ${b.desc ? `<div class="tl-desc">${esc(b.desc)}</div>` : ""}
            ${b.careers && b.careers.length ? `<div class="tl-careers">Careers: ${esc(b.careers.join(", "))}</div>` : ""}
          </div>
          <div class="tl-meta">
            <div class="tl-time">${scheduleIconHtml_("clock")}<span>${esc(b.time)}</span></div>
            ${b.room ? `<div class="tl-room">${scheduleIconHtml_("pin")}<span>${esc(b.room)}</span></div>` : ""}
            <div class="tl-tag tl-tag--${esc(b.color)}">${esc(b.tag)}</div>
          </div>
        </div>`;
  }

  // Full-page ticket for one student: header badge, name/ID/QR block, then
  // the numbered day-of timeline, then a footer note — sized for A4 by
  // default (A4/A5 toggle buttons in the print window switch a couple of
  // @page rules, see openQrBatchPrintView). pageBreakBefore is set on every
  // ticket after the first so each student lands on her own page.
  function ticketHtml_(img, pageBreakBefore) {
    const band = (img.cohort && COHORT_BAND[img.cohort]) || DEFAULT_BAND;
    return `
      <div class="ticket"${pageBreakBefore ? ' style="page-break-before:always;"' : ""}>
        <div class="ticket-header">
          <div class="ticket-header-left">
            <img class="ticket-logo-img" src="${KHS_LOGO_URL}" alt="">
            <img class="ticket-logo-img" src="${WG2_LOGO_URL}" alt="">
            <div class="ticket-header-text">
              <div class="ticket-org">Kenya High School Alumnae Society</div>
              <div class="ticket-event">BOMA CAREER DAY 2026</div>
              <div class="ticket-theme">${esc(EVENT_THEME)}</div>
              <div class="ticket-tagline">${esc(EVENT_SLOGAN)}</div>
            </div>
          </div>
          <div class="ticket-roletag" style="background:${band.bg};color:${band.text};">${esc(img.roleTag)}</div>
        </div>
        <div class="ticket-body">
          <div class="ticket-idcol">
            <div class="ticket-name">${esc(img.name)}</div>
            ${img.subInfo ? `<div class="ticket-sub">${esc(img.subInfo)}</div>` : ""}
            <div class="ticket-id">ID: ${esc(img.id)}</div>
          </div>
          <div class="ticket-qrcol">
            <img class="ticket-qr" src="${img.plainDataUrl}">
            <div class="ticket-scanlabel">SCAN AT CHECK-IN</div>
          </div>
        </div>
        ${
          img.isStudent
            ? img.blocks.length
              ? `<div class="ticket-schedule">
          <div class="ticket-schedule-head">
            ${scheduleIconHtml_("calendar")}
            <div>
              <div class="ticket-schedule-title">MY SCHEDULE</div>
              <div class="ticket-schedule-sub">Where you're booked to go, and when</div>
            </div>
          </div>
          <div class="ticket-timeline">${img.blocks.map((b, i) => ticketTimelineRowHtml_(b, i)).join("")}</div>
        </div>`
              : ""
            : `<div class="ticket-schedule">
          <div class="ticket-schedule-head">
            ${scheduleIconHtml_("calendar")}
            <div>
              <div class="ticket-schedule-title">WHEN YOU'RE NEEDED</div>
              <div class="ticket-schedule-sub">Which session(s), and where to go</div>
            </div>
          </div>
          <div class="ticket-when">
            <div class="tw-row">${scheduleIconHtml_("clock")}<span>${esc(img.shiftLabel)}</span></div>
            ${img.room ? `<div class="tw-row">${scheduleIconHtml_("pin")}<span>Room ${esc(img.room)}</span></div>` : ""}
          </div>
        </div>`
        }
        <div class="ticket-footer">
          <div class="ticket-footer-note">${scheduleIconHtml_("info")}<span>Arrive 10 minutes early for each session and show this QR code at check-in. ${esc(EXHIBITION_HOURS_NOTE)}</span></div>
          <div class="ticket-footer-tag">Karibu Boma!</div>
        </div>
        <div class="ticket-footer-standard">
          <div class="tfs-contact">The Kenya High School Alumnae Society &middot; ${esc(KHS_CONTACT_LINE)}</div>
          <div class="tfs-socials">${SOCIAL_LINKS_.map((s) => `<span class="tfs-social">${socialIconHtml_(s.icon)}<span>${esc(s.handle)}</span></span>`).join("")}</div>
        </div>
      </div>`;
  }

  const FULL_TICKET_CSS_ = `
        /* ---- ticket (student itinerary / mentor "when you're needed" card) ---- */
        .ticket { max-width: 720px; margin: 0 auto 16px; border: 1px solid #E3D9C9; border-radius: 14px; overflow: hidden; page-break-inside: avoid; }
        .ticket-header { background: linear-gradient(120deg, #7A1319, #4d0c10); color: #fff; padding: 16px 18px; display: flex; justify-content: space-between; align-items: flex-start; }
        .ticket-header-left { display: flex; gap: 10px; align-items: center; }
        .ticket-logo-img { width: 40px; height: 40px; border-radius: 50%; background: #FFF7E6; flex: 0 0 auto; object-fit: contain; padding: 2px; }
        .ticket-org { font-size: 9px; letter-spacing: 0.5px; text-transform: uppercase; opacity: 0.85; }
        .ticket-event { font-size: 15px; font-weight: 800; letter-spacing: 0.3px; margin-top: 1px; }
        .ticket-theme { font-size: 10.5px; font-weight: 700; color: #F0D9A6; margin-top: 2px; }
        .ticket-tagline { font-size: 9px; font-style: italic; color: #E8C9A0; margin-top: 1px; opacity: 0.9; }
        .ticket-roletag { font-size: 10.5px; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase; padding: 6px 12px; border-radius: 20px; white-space: nowrap; }
        .ticket-body { padding: 16px 18px; display: flex; justify-content: space-between; align-items: center; gap: 14px; border-bottom: 1px solid #eee; }
        .ticket-name { font-size: 19px; font-weight: 800; color: #1A1A1A; text-transform: uppercase; }
        .ticket-sub { font-size: 12px; font-weight: 700; color: #7A1319; margin-top: 2px; }
        .ticket-id { font-size: 11px; color: #888; margin-top: 4px; }
        .ticket-qrcol { text-align: center; flex: 0 0 auto; }
        .ticket-qr { width: 120px; height: 120px; border: 1px solid #ddd; border-radius: 6px; padding: 6px; background: #fff; }
        .ticket-scanlabel { background: #7A1319; color: #fff; font-size: 9px; font-weight: 700; letter-spacing: 0.4px; border-radius: 12px; padding: 4px 10px; margin-top: 6px; }
        .ticket-schedule { padding: 14px 18px 6px; }
        .ticket-schedule-head { display: flex; gap: 8px; align-items: center; padding-bottom: 8px; border-bottom: 2px solid #B8862B; margin-bottom: 10px; }
        .ticket-schedule-head svg { width: 18px; height: 18px; color: #7A1319; }
        .ticket-schedule-title { font-size: 13px; font-weight: 800; color: #7A1319; letter-spacing: 0.3px; }
        .ticket-schedule-sub { font-size: 10px; color: #888; }
        .tl-row { display: flex; align-items: flex-start; gap: 10px; padding: 8px 0; border-bottom: 1px dashed #eee; }
        .tl-row:last-child { border-bottom: none; }
        .tl-num { width: 18px; height: 18px; border-radius: 50%; background: #B8862B; color: #fff; font-size: 9.5px; font-weight: 800; display: flex; align-items: center; justify-content: center; flex: 0 0 auto; margin-top: 2px; }
        .tl-icon { width: 26px; height: 26px; border-radius: 7px; display: flex; align-items: center; justify-content: center; flex: 0 0 auto; color: #fff; }
        .tl-icon svg { width: 14px; height: 14px; }
        .tl-icon--red { background: #7A1319; }
        .tl-icon--green { background: #2E5C4A; }
        .tl-icon--gold { background: #B8862B; }
        .tl-icon--grey { background: #9a9a9a; }
        .tl-body { flex: 1; min-width: 0; }
        .tl-title { font-size: 12px; font-weight: 800; }
        .tl-desc { font-size: 9.5px; color: #777; margin-top: 1px; }
        .tl-careers { font-size: 8.5px; color: #666; margin-top: 2px; line-height: 1.4; }
        .tl-meta { flex: 0 0 150px; text-align: right; }
        .tl-time { font-size: 10px; font-weight: 700; color: #1A1A1A; display: flex; gap: 4px; justify-content: flex-end; align-items: center; }
        .tl-time svg { color: #7A1319; }
        .tl-room { font-size: 9.5px; color: #777; margin-top: 1px; display: flex; gap: 4px; justify-content: flex-end; align-items: center; }
        .tl-tag { display: inline-block; font-size: 8px; font-weight: 800; letter-spacing: 0.3px; border-radius: 10px; padding: 2px 8px; margin-top: 4px; border: 1px solid; }
        .tl-tag--red { color: #7A1319; border-color: #7A1319; background: #FBEAEA; }
        .tl-tag--green { color: #2E5C4A; border-color: #2E5C4A; background: #E7F1EC; }
        .tl-tag--gold { color: #8a6110; border-color: #B8862B; background: #FFF7E6; }
        .tl-tag--grey { color: #666; border-color: #bbb; background: #f2f2f2; }
        .ticket-when { display: flex; flex-direction: column; gap: 8px; padding: 2px 0 10px; }
        .tw-row { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 800; color: #1A1A1A; }
        .tw-row svg { width: 15px; height: 15px; color: #7A1319; }
        .ticket-footer { background: #7A1319; color: #fff; padding: 10px 18px; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
        .ticket-footer-note { font-size: 9.5px; opacity: 0.92; display: flex; gap: 6px; align-items: flex-start; max-width: 520px; }
        .ticket-footer-tag { font-style: italic; color: #F0D9A6; font-weight: 700; font-size: 13px; white-space: nowrap; }
        .ticket-footer-standard { background: #4d0c10; color: #E8C9A0; font-size: 8.5px; text-align: center; padding: 8px 18px; letter-spacing: 0.2px; }
        .tfs-contact { margin-bottom: 4px; }
        .tfs-socials { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px 12px; }
        .tfs-social { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
        .tfs-social svg { width: 10px; height: 10px; flex: 0 0 auto; }

        /* ---- A5 compact scale ---- */
        body.a5 .ticket { max-width: 100%; }
        body.a5 .ticket-header { padding: 10px 12px; }
        body.a5 .ticket-logo-img { width: 28px; height: 28px; }
        body.a5 .ticket-event { font-size: 12px; }
        body.a5 .ticket-theme { font-size: 8.5px; }
        body.a5 .ticket-org, body.a5 .ticket-tagline { font-size: 7px; }
        body.a5 .ticket-roletag { font-size: 8.5px; padding: 4px 9px; }
        body.a5 .ticket-body { padding: 10px 12px; }
        body.a5 .ticket-name { font-size: 14px; }
        body.a5 .ticket-sub { font-size: 10px; }
        body.a5 .ticket-id { font-size: 9px; }
        body.a5 .ticket-qr { width: 84px; height: 84px; }
        body.a5 .ticket-schedule { padding: 10px 12px 4px; }
        body.a5 .tl-title { font-size: 10px; }
        body.a5 .tl-desc, body.a5 .tl-time, body.a5 .tl-room { font-size: 8px; }
        body.a5 .tl-careers { font-size: 7px; }
        body.a5 .tl-tag { font-size: 6.5px; }
        body.a5 .tw-row { font-size: 9.5px; }
        body.a5 .ticket-footer { padding: 8px 12px; }
        body.a5 .ticket-footer-note { font-size: 7.5px; }
        body.a5 .ticket-footer-tag { font-size: 10px; }
        body.a5 .ticket-footer-standard { font-size: 6.5px; padding: 6px 10px; }
        body.a5 .tfs-socials { gap: 3px 8px; }
        body.a5 .tfs-social svg { width: 8px; height: 8px; }
  `;

  // ---- Compact, text-only batch layout ------------------------------
  // 26 Aug 2026 request from WG2: the full one-per-page ticket above is
  // right for a single reprint, but printing a whole class that way costs
  // one full sheet per student. This lays the SAME real per-block data
  // (time/topic/room/type — the exact objects studentItineraryBlocks_
  // already builds, see collectQrImages) out as one plain-text line per
  // block instead of an icon+description block, ~8 people to an A4 page,
  // no icons. Used automatically whenever more than one person is being
  // printed at once; a single reprint still gets the full ticket — see
  // the branch in openQrBatchPrintView below.
  const COMPACT_TICKET_CSS_ = `
        .ccgrid { width: 100%; border-collapse: separate; border-spacing: 2.5mm; table-layout: fixed; }
        .ccgrid tr { page-break-inside: avoid; }
        .cctd { width: 50%; vertical-align: top; padding: 0; }
        .ccard { border: 1px dashed #c9b9b3; border-radius: 8px; padding: 11px 12px; page-break-inside: avoid; overflow: hidden; }
        .ccard--empty { border: none; }
        .cchead { display: flex; align-items: center; gap: 5px; margin-bottom: 7px; }
        .cclogo { width: 20px; height: 20px; border-radius: 50%; object-fit: contain; background: #FFF7E6; padding: 1px; flex: 0 0 auto; }
        .ccorg { font-size: 9px; font-weight: 800; color: #7A1319; flex: 1; }
        .cctag { font-size: 8px; font-weight: 800; padding: 2px 6px; border-radius: 10px; letter-spacing: 0.2px; white-space: nowrap; text-transform: uppercase; }
        .ccid-row { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 7px; padding-bottom: 7px; border-bottom: 1px solid #eee; }
        .ccname { font-size: 13px; font-weight: 800; text-transform: uppercase; }
        .ccsub { font-size: 8.5px; color: #777; margin-top: 1px; }
        .ccqr { width: 46px; height: 46px; border: 1px solid #ddd; border-radius: 4px; padding: 2px; background: #fff; flex: 0 0 auto; }
        .csched { display: flex; flex-direction: column; gap: 2.5px; }
        .crow { display: flex; align-items: baseline; flex-wrap: nowrap; gap: 4px; font-size: 8px; line-height: 1.3; border-bottom: 1px dotted #eee; padding-bottom: 2.5px; max-width: 100%; }
        .crow:last-child { border-bottom: none; }
        .crn { color: #B8862B; font-weight: 800; flex: 0 0 auto; }
        .crtime { font-weight: 700; flex: 0 0 auto; white-space: nowrap; margin-right: 2px; }
        .crtitle { flex: 1 1 0; min-width: 0; color: #333; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 4px; }
        .croom { color: #888; }
        .crtag { flex: 0 0 auto; font-weight: 800; font-size: 7px; white-space: nowrap; min-width: 58px; text-align: right; }
        .ccbatchfoot { margin-top: 5px; text-align: center; font-size: 9px; color: #888; border-top: 1px solid #eee; padding-top: 5px; }
  `;

  const TAG_COLOR_HEX_ = { red: "#7A1319", green: "#2E5C4A", gold: "#8a6110", grey: "#666666" };

  // Hard character-budget truncation rather than relying on CSS
  // text-overflow:ellipsis inside a flex row — cluster names range from
  // "Legal Practitioners" to "The Arts — Visual, Performing & Literary",
  // and at 8 people to an A4 page there just isn't room for the longest
  // ones plus a room code plus a type tag on one line. Truncating in JS
  // guarantees a consistent, readable result across every print engine a
  // teacher's laptop might use, instead of trusting flexbox shrink math.
  function truncateForRow_(s, max) {
    s = String(s || "");
    return s.length > max ? s.slice(0, Math.max(1, max - 1)).trim() + "…" : s;
  }

  function compactRowHtml_(n, b) {
    const room = b.room || "";
    const roomSuffix = room ? " · " + room : "";
    const title = truncateForRow_(b.title, Math.max(10, 34 - roomSuffix.length));
    const roomBit = room ? ` &middot; <span class="croom">${esc(room)}</span>` : "";
    return `<div class="crow">
      <span class="crn">${n}.</span>
      <span class="crtime">${esc(b.time)}</span>
      <span class="crtitle">${esc(title)}${roomBit}</span>
      <span class="crtag" style="color:${TAG_COLOR_HEX_[b.color] || "#666"};">${esc(b.tag)}</span>
    </div>`;
  }

  function compactCardHtml_(img) {
    const band = (img.cohort && COHORT_BAND[img.cohort]) || DEFAULT_BAND;
    let schedHtml;
    if (img.isStudent && img.blocks.length) {
      schedHtml = img.blocks.map((b, i) => compactRowHtml_(i + 1, b)).join("");
    } else if (!img.isStudent) {
      const parts = [];
      if (img.shiftLabel) parts.push(`<div class="crow"><span class="crtitle">${esc(img.shiftLabel)}</span></div>`);
      if (img.room) parts.push(`<div class="crow"><span class="crtitle">Room ${esc(img.room)}</span></div>`);
      schedHtml = parts.join("") || `<div class="crow"><span class="crtitle" style="color:#999;">No shift/room set yet</span></div>`;
    } else {
      schedHtml = `<div class="crow"><span class="crtitle" style="color:#999;">Schedule not yet allocated</span></div>`;
    }
    return `<div class="ccard">
      <div class="cchead">
        <img class="cclogo" src="${KHS_LOGO_URL}" alt="">
        <img class="cclogo" src="${WG2_LOGO_URL}" alt="">
        <div class="ccorg">Boma Career Day 2026</div>
        <div class="cctag" style="background:${band.bg};color:${band.text};">${esc(img.roleTag)}</div>
      </div>
      <div class="ccid-row">
        <div class="ccid-left">
          <div class="ccname">${esc(img.name)}</div>
          <div class="ccsub">${img.subInfo ? esc(img.subInfo) + " &middot; " : ""}ID ${esc(img.id)}</div>
        </div>
        <img class="ccqr" src="${img.plainDataUrl}">
      </div>
      <div class="csched">${schedHtml}</div>
    </div>`;
  }

  // Pairs cards two-to-a-row inside a <table> rather than CSS Grid — a
  // plain table paginates reliably across multiple printed A4 pages (CSS
  // Grid's print-fragmentation support is inconsistent across print
  // engines), so a 28-student class comes out as a clean ~4-page stack
  // instead of clipping mid-page. ~8 cards (4 rows) fit an A4 page at
  // this size.
  function compactBatchTableHtml_(images) {
    const cards = images.map(compactCardHtml_);
    const rows = [];
    for (let i = 0; i < cards.length; i += 2) {
      const pair = cards.slice(i, i + 2);
      if (pair.length === 1) pair.push('<div class="ccard ccard--empty"></div>');
      rows.push(`<tr><td class="cctd">${pair[0]}</td><td class="cctd">${pair[1]}</td></tr>`);
    }
    return `<table class="ccgrid"><tbody>${rows.join("")}</tbody></table>
      <div class="ccbatchfoot">Cut along dashed lines &middot; one slip per person &middot; The Kenya High School Alumnae Society &middot; ${esc(KHS_CONTACT_LINE)}</div>`;
  }

  function openQrBatchPrintView(people, title, subtitle) {
    if (!people.length) {
      alert("No one to print QR codes for.");
      return;
    }
    const images = collectQrImages(people);
    const win = window.open("", "_blank");
    if (!win) {
      alert("Pop-up blocked — please allow pop-ups for this site and try again.");
      return;
    }
    // One person -> the full branded ticket (see ticketHtml_), same as
    // before — a class teacher reprinting one girl's card still gets the
    // full itinerary with careers listed. More than one -> the compact
    // text-only batch layout (see compactBatchTableHtml_), ~8 people per
    // A4 page instead of one page each.
    const compact = images.length > 1;
    const bodyHtml = compact
      ? compactBatchTableHtml_(images)
      : images.map((img, i) => ticketHtml_(img, i > 0)).join("");
    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
      <style id="pageA4style">@page { size: A4; margin: ${compact ? "8mm" : "12mm"}; }</style>
      <style id="pageA5style" disabled>@page { size: A5; margin: 9mm; }</style>
      <style>
        * { box-sizing: border-box; }
        body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 16px; color: #1A1A1A; }
        svg { width: 1em; height: 1em; vertical-align: -0.15em; }

        /* ---- print bar (hidden when actually printing) ---- */
        .printbar { margin-bottom: 14px; display: flex; align-items: center; gap: 10px; }
        .printbar button { background: #B82126; color: #fff; border: none; border-radius: 20px; padding: 8px 16px; font-size: 12px; font-weight: 700; cursor: pointer; }
        .sizebtns { display: inline-flex; border: 1px solid #7A1319; border-radius: 20px; overflow: hidden; }
        .sizebtn { background: #fff; color: #7A1319; border: none; padding: 8px 14px; font-size: 12px; font-weight: 700; cursor: pointer; }
        .sizebtn.active { background: #7A1319; color: #fff; }
        @media print { .printbar { display: none; } }

        ${compact ? COMPACT_TICKET_CSS_ : FULL_TICKET_CSS_}
      </style></head><body>
      <div class="printbar">
        <button onclick="window.print()">Print / Save as PDF</button>
        ${
          compact
            ? ""
            : `<span class="sizebtns">
          <button type="button" id="btnA4" class="sizebtn active" onclick="setPageSize('A4')">A4</button>
          <button type="button" id="btnA5" class="sizebtn" onclick="setPageSize('A5')">A5</button>
        </span>`
        }
        <span style="font-size:11px;color:#777;">${images.length} QR code(s) &middot; ${esc(subtitle || "")}</span>
      </div>
      ${bodyHtml}
      <script>
        function setPageSize(sz) {
          document.getElementById('pageA4style').disabled = sz !== 'A4';
          document.getElementById('pageA5style').disabled = sz !== 'A5';
          document.body.classList.toggle('a5', sz === 'A5');
          document.getElementById('btnA4').classList.toggle('active', sz === 'A4');
          document.getElementById('btnA5').classList.toggle('active', sz === 'A5');
        }
      </script>
      </body></html>`);
    win.document.close();
  }

  // Pasted rows no longer carry an admission number — Career Day IDs are
  // always server-assigned (nextCareerDayId_ in Code.gs), never supplied by
  // whoever is pasting the list.
  function parseBulkText(text) {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(",").map((p) => p.trim());
        const [name, classStream, cohort, ...choiceParts] = parts;
        return { name, classStream, cohort: (cohort || "").toUpperCase(), choices: choiceParts.filter(Boolean).join(",") };
      })
      .filter((r) => r.name && r.classStream && r.cohort);
  }

  function submitBulkImport() {
    const rows = parseBulkText($("bulkText").value);
    if (!rows.length) {
      $("bulkResult").textContent = "No valid rows found. Check the format: name, class/stream, cohort, choices…";
      return;
    }
    const teacherEmail = $("bulkTeacherEmail").value.trim();
    const teacherName = $("bulkTeacherName").value.trim();
    let created = 0;
    const errors = [];
    const createdRecords = [];
    const postRows = [];
    rows.forEach((r) => {
      const validCohort = ["F4", "G10A", "G10B"].indexOf(r.cohort) !== -1;
      if (!validCohort) {
        errors.push(r.name + ": cohort must be F4, G10A, or G10B (got \"" + r.cohort + "\")");
        return;
      }
      // Placeholder id shown locally right away; each row is reconciled with
      // its real server-assigned id once bulk_register_students responds
      // (see the apiPost handler below) or, if offline, once the queued
      // write finally syncs and refresh() pulls the authoritative list.
      const provisionalId = provisionalStudentId_(r.cohort);
      const now = new Date().toISOString();
      const rec = {
        id: provisionalId, name: r.name, admissionNo: "", classStream: r.classStream, cohort: r.cohort, choices: r.choices,
        round1: "", round2: "", round3: "", round4: "", status: "Pending", notes: "", createdAt: now, updatedAt: now,
        teacherEmail, teacherName,
      };
      state.students.push(rec);
      createdRecords.push(rec);
      postRows.push(Object.assign({}, r, { clientId: provisionalId, teacherEmail, teacherName }));
      created++;
    });
    renderAll();
    $("bulkResult").innerHTML = `<b>${created} / ${rows.length}</b> registered.` + (errors.length ? "<br>Skipped:<br>" + errors.map(esc).join("<br>") : "");
    if (created) {
      state.lastBulkBatch = { students: createdRecords, teacherEmail, teacherName };
      $("bulkQrActions").classList.remove("hidden");
    }
    if (!DEMO_MODE && created) {
      apiPost({ action: "bulk_register_students", rows: postRows })
        .then((res) => {
          if (res && res.ok && Array.isArray(res.results)) {
            res.results.forEach((r) => {
              if (!r.clientId || !r.id) return;
              const rec = createdRecords.find((x) => x.id === r.clientId);
              if (rec) rec.id = r.id;
            });
            renderAll();
          }
        })
        .catch((e) => console.error(e));
    }
  }

  function printLastBulkBatch() {
    const batch = state.lastBulkBatch;
    if (!batch || !batch.students.length) return;
    openQrBatchPrintView(batch.students, "QR Codes — " + (batch.students[0].classStream || "Bulk Import"), batch.students.length + " newly registered student(s)");
  }

  function emailLastBulkBatch() {
    const batch = state.lastBulkBatch;
    if (!batch || !batch.students.length) return;
    if (!batch.teacherEmail) {
      alert("No class contact email was entered for this batch. Add one in the 'Class contact email' field above and re-import, or use Schedule → My Class to email this class later.");
      return;
    }
    sendClassEmail(batch.students[0].classStream, batch.teacherEmail, batch.students, "class-qr-batch");
  }

  function registerAnother() {
    $("regQrResult").classList.add("hidden");
    $("studentForm").classList.toggle("hidden", state.regType !== "student");
    $("mentorForm").classList.toggle("hidden", state.regType !== "mentor");
  }

  // ---------------------------------------------------------------------
  // CHECK-IN MODULE (QR scan, manual search, walk-in)
  // ---------------------------------------------------------------------
  function setCheckinMode(mode) {
    state.checkinMode = mode;
    document.querySelectorAll("#checkinModeChips [data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    $("scanPane").classList.toggle("hidden", mode !== "scan");
    $("searchPane").classList.toggle("hidden", mode !== "search");
    $("walkinPane").classList.toggle("hidden", mode !== "walkin");
    if (mode !== "scan") stopScanning();
  }

  function allCheckinPeople() {
    const students = state.students.map((s) => ({ type: "Student", id: s.id, name: s.name, meta: s.classStream + " · " + s.cohort }));
    const team = state.team.map((t) => ({ type: "Team", id: t.id, name: t.name, meta: t.role + (t.zone ? " · " + t.zone : "") }));
    return students.concat(team);
  }

  function findPersonById(id) {
    const s = state.students.find((x) => x.id === id);
    if (s) return { type: "Student", id: s.id, name: s.name };
    const t = state.team.find((x) => x.id === id);
    if (t) return { type: "Team", id: t.id, name: t.name };
    return null;
  }

  async function startScanning() {
    if (state.scanning) return;
    const video = $("scanVideo");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      state.scanStream = stream;
      video.srcObject = stream;
      await video.play();
      state.scanning = true;
      $("scanStartBtn").textContent = "Stop Camera";
      $("scanHint").textContent = "Scanning… point at a QR code.";
      scanLoop();
    } catch (err) {
      console.error(err);
      $("scanHint").textContent = "Couldn't access the camera (permission denied, or no camera on this device). Try Search or Walk-in instead.";
    }
  }

  // Called both when a scan matches (see scanLoop below — the camera exits
  // automatically the instant a code is captured, before the details modal
  // opens) and when someone manually taps Stop Camera. Explicitly pausing
  // and clearing the video element (not just stopping the stream tracks)
  // means the feed visibly disappears right away on every browser, instead
  // of possibly freezing on the last frame underneath the modal.
  function stopScanning() {
    if (state.scanLoopId) cancelAnimationFrame(state.scanLoopId);
    state.scanLoopId = null;
    if (state.scanStream) {
      state.scanStream.getTracks().forEach((t) => t.stop());
      state.scanStream = null;
    }
    const video = $("scanVideo");
    if (video) {
      video.pause();
      video.srcObject = null;
    }
    state.scanning = false;
    const btn = $("scanStartBtn");
    if (btn) btn.textContent = "Start Camera";
    const hint = $("scanHint");
    if (hint) hint.textContent = "Point the camera at a student or mentor's QR code.";
  }

  function scanLoop() {
    const video = $("scanVideo");
    if (!state.scanning || !video || video.readyState !== video.HAVE_ENOUGH_DATA) {
      state.scanLoopId = requestAnimationFrame(scanLoop);
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = window.jsQR(imageData.data, imageData.width, imageData.height);
    if (code && code.data) {
      const person = findPersonById(code.data.trim());
      if (person) {
        stopScanning();
        openConfirmModal(person);
        return;
      } else {
        $("scanHint").textContent = 'QR code "' + code.data + '" doesn\'t match anyone registered yet. Still scanning…';
      }
    }
    state.scanLoopId = requestAnimationFrame(scanLoop);
  }

  function renderCheckinSearch() {
    const q = $("checkinSearch").value.trim().toLowerCase();
    const box = $("checkinSearchResults");
    if (!q) {
      box.innerHTML = "";
      return;
    }
    const results = allCheckinPeople()
      .filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
      .slice(0, 25);
    if (!results.length) {
      box.innerHTML = '<div class="empty">No match.</div>';
      return;
    }
    box.innerHTML = results
      .map(
        (p) => `
      <div class="result-item">
        <div>
          <div class="rname">${esc(p.name)}</div>
          <div class="rmeta">${esc(p.type)} &middot; ${esc(p.id)} &middot; ${esc(p.meta)}</div>
        </div>
        <button data-checkin-id="${escAttr(p.id)}" data-checkin-type="${escAttr(p.type)}">Check In</button>
      </div>
    `
      )
      .join("");
  }

  function openConfirmModal(person) {
    state.pendingCheckin = person;
    $("confirmName").textContent = person.name;
    $("confirmId").textContent = person.id ? person.type + " · " + person.id : person.type + " · Career Day ID assigned on check-in";
    $("confirmRound").value = person.type === "Team" ? "—" : "1";
    $("confirmRoom").value = "";
    $("confirmModal").classList.remove("hidden");
  }
  function closeConfirmModal() {
    $("confirmModal").classList.add("hidden");
    state.pendingCheckin = null;
  }
  function saveCheckin() {
    const person = state.pendingCheckin;
    if (!person) return;
    const round = $("confirmRound").value;
    const room = $("confirmRoom").value.trim();

    // Walk-in that hasn't been registered yet: register + check in in ONE
    // server round trip (walkin_register_checkin in Code.gs), so there's
    // only ever a single, server-assigned Career Day ID — never a
    // client-guessed one that has to be reconciled across two writes.
    if (person.isNewWalkin) {
      const now = new Date().toISOString();
      const provisionalId = provisionalStudentId_(person.cohort);
      state.students.push({
        id: provisionalId, name: person.name, admissionNo: "", classStream: person.classStream, cohort: person.cohort,
        round1: "", round2: "", round3: "", round4: "", status: "Walk-in", notes: "Same-day walk-in registration",
        createdAt: now, updatedAt: now,
      });
      const rec = {
        timestamp: now, type: "Student", personId: provisionalId, personName: person.name,
        round, room, method: "Walk-in", checkedInBy: state.who || "Someone",
      };
      state.attendance.unshift(rec);
      renderAll();
      closeConfirmModal();
      if (!DEMO_MODE) {
        apiPost({ action: "walkin_register_checkin", clientId: provisionalId, name: person.name, classStream: person.classStream, cohort: person.cohort, round, room })
          .then((res) => {
            if (res && res.ok && res.id && res.id !== provisionalId) {
              const s = state.students.find((x) => x.id === provisionalId);
              if (s) s.id = res.id;
              const a = state.attendance.find((x) => x.personId === provisionalId && x.timestamp === now);
              if (a) a.personId = res.id;
              renderAll();
            }
            if (res && res.duplicateWarning) alert("⚠ " + res.duplicateWarning);
          })
          .catch((e) => console.error(e));
      }
      return;
    }

    const rec = {
      timestamp: new Date().toISOString(),
      type: person.type,
      personId: person.id,
      personName: person.name,
      round,
      room,
      method: state.checkinMode === "scan" ? "QR" : state.checkinMode === "walkin" ? "Walk-in" : "Manual",
      checkedInBy: state.who || "Someone",
    };
    state.attendance.unshift(rec);
    renderAll();
    closeConfirmModal();
    if (!DEMO_MODE) apiPost(Object.assign({ action: "check_in" }, rec)).catch((e) => console.error(e));
  }

  function renderRecentCheckins() {
    const list = $("recentCheckinsList");
    if (!list) return;
    const recent = state.attendance.slice().sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)).slice(0, 8);
    if (!recent.length) {
      list.innerHTML = '<div class="empty">No check-ins yet today.</div>';
      return;
    }
    list.innerHTML = recent
      .map(
        (r) => `
      <div class="checkin-row">
        <div>
          <div class="cname">${esc(r.personName)}</div>
          <div class="cmeta">${esc(r.type)} &middot; Round ${esc(r.round)} &middot; ${esc(r.room || "—")} &middot; ${esc(r.method)}</div>
        </div>
        <div class="cmeta">${esc(timeAgo(r.timestamp))}</div>
      </div>
    `
      )
      .join("");
  }

  // Collects the walk-in's details, then opens the same round/room confirm
  // modal used for scans/search — actual registration + check-in happens
  // together in saveCheckin() once round/room are known (see the
  // isNewWalkin branch there), so there's a single server round trip and a
  // single server-assigned Career Day ID.
  function submitWalkinForm(ev) {
    ev.preventDefault();
    const name = $("wfName").value.trim();
    const classStream = $("wfClass").value.trim();
    const cohort = $("wfCohort").value;
    if (!name || !classStream || !cohort) return;
    ev.target.reset();
    openConfirmModal({ type: "Student", id: null, name, classStream, cohort, isNewWalkin: true });
  }

  // ---------------------------------------------------------------------
  // DASHBOARD MODULE
  // ---------------------------------------------------------------------
  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  function renderDashboard() {
    if (!$("dashRegProgress")) return; // not yet in DOM on very first paint
    // Leads/Assistant Leads/Zone Coordinators get the full executive
    // dashboard; everyone else (Interns, Class Teachers, Mentors/cluster
    // tier) gets the personal-scoped My Day panel instead — see WG2's
    // request that non-leadership roles see "what they personally need to
    // do," not the org-wide numbers.
    const execView = canManageZone();
    if ($("execDashboardWrap")) $("execDashboardWrap").classList.toggle("hidden", !execView);
    if ($("myDayPanel")) $("myDayPanel").classList.toggle("hidden", execView);
    if (!execView) {
      renderMyDayPanel_();
      return;
    }
    if ($("dashRoleBanner")) {
      const me = state.team.find((t) => t.id === (state.session && state.session.memberId));
      const role = (me && me.role) || (state.session && state.session.role) || "";
      $("dashRoleBanner").innerHTML = roleGuideBannerHtml_(role);
    }
    renderAttentionPanel_();
    renderDashCharts_();
    renderDashAllocStatus();
    renderDashRegProgress();
    renderDashLiveSummary();
    renderDashTeamSummary();
    renderDashTaskPhases();
    renderDashZoneTable();
    renderDashProjection();
    renderDashCapacity();
    renderSessionCoverage_();
    renderClusterCommandCenter_("execClusterCommand");
    renderLeadershipCandidates_();
    populateSendSegmentUI();
  }

  function renderDashRegProgress() {
    const rows = Object.keys(COHORT_TARGETS).map((cohort) => {
      const count = state.students.filter((s) => s.cohort === cohort).length;
      const target = COHORT_TARGETS[cohort];
      const pct = Math.min(100, (count / target) * 100);
      const label = COHORT_LABELS[cohort] || cohort;
      return { label, count, target, pct };
    });
    const totalCount = state.students.length;
    const totalTarget = Object.values(COHORT_TARGETS).reduce((a, b) => a + b, 0);
    rows.push({ label: "TOTAL", count: totalCount, target: totalTarget, pct: Math.min(100, (totalCount / totalTarget) * 100) });

    $("dashRegProgress").innerHTML = rows
      .map(
        (r) => `
      <div class="dash-bar-row">
        <div class="toprow"><span>${esc(r.label)}</span><b>${r.count} / ${r.target} (${r.pct.toFixed(0)}%)</b></div>
        <div class="dash-bar-track"><div class="dash-bar-fill" style="width:${r.pct}%"></div></div>
      </div>
    `
      )
      .join("");
  }

  function renderDashLiveSummary() {
    const today = todayStr();
    const todays = state.attendance.filter((a) => (a.timestamp || "").slice(0, 10) === today);
    const students = todays.filter((a) => a.type === "Student");
    const team = todays.filter((a) => a.type === "Team");
    const rounds = new Set(todays.map((a) => a.round).filter((r) => r && r !== "—"));
    $("dashLiveSummary").innerHTML = `
      <div class="box"><div class="n">${todays.length}</div><div class="l">Check-ins</div></div>
      <div class="box"><div class="n">${students.length}</div><div class="l">Students</div></div>
      <div class="box"><div class="n">${team.length}</div><div class="l">Team</div></div>
      <div class="box"><div class="n">${rounds.size}</div><div class="l">Rounds Active</div></div>
    `;
  }

  function renderDashTeamSummary() {
    const total = state.team.length;
    const confirmed = state.team.filter((t) => t.status === "Confirmed").length;
    const mentors = state.team.filter((t) => t.role === "Mentor").length;
    const zoneCoords = state.team.filter((t) => t.role === "Zone Coordinator").length;
    $("dashTeamSummary").innerHTML = `
      <div class="box"><div class="n">${confirmed}</div><div class="l">Confirmed</div></div>
      <div class="box"><div class="n">${total - confirmed}</div><div class="l">Unconfirmed</div></div>
      <div class="box"><div class="n">${mentors}</div><div class="l">Mentors</div></div>
      <div class="box"><div class="n">${zoneCoords}</div><div class="l">Zone Coords</div></div>
    `;
  }

  // ---------------------------------------------------------------------
  // MENTOR STATUS BOARD — "who's where doing what", for Leads/Assistant
  // Leads/Zone Coordinators to spot gaps that need an executive call
  // (a room with no mentor checked in once the day is running, a virtual
  // mentor with no link on file, etc.) rather than finding out too late.
  // Built entirely from existing data: Team (role, zone/cluster, mode,
  // sessionLink) + Attendance (the same check-in log Sub-Leads already use
  // for students — a mentor's most recent "Team" check-in IS their
  // arrival/going-live signal, no new tracking mechanism needed).
  // ---------------------------------------------------------------------
  function mentorLatestCheckin_(id) {
    const rows = state.attendance.filter((a) => a.type === "Team" && a.personId === id);
    if (!rows.length) return null;
    return rows.slice().sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))[0];
  }

  function mentorOpsStatus_(t) {
    const mode = t.mode || "In-person";
    const last = mentorLatestCheckin_(t.id);
    const time = last ? new Date(last.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    if (mode === "In-person") {
      return last
        ? { flag: "ok", label: "Checked in " + time + (last.room ? " · " + last.room : "") }
        : { flag: "nomentor", label: "Not checked in yet" };
    }
    if (mode === "Live virtual") {
      if (last) return { flag: "ok", label: "Live since " + time };
      return t.sessionLink ? { flag: "under", label: "Link on file — not live yet" } : { flag: "nomentor", label: "No link yet, not live" };
    }
    // Pre-recorded
    return t.sessionLink ? { flag: "ok", label: "Video ready" } : { flag: "nomentor", label: "No video link yet" };
  }

  function filteredMentorOps() {
    const z = state.mentorOpsZone;
    return state.team.filter((t) => {
      if (t.role !== "Mentor") return false;
      if (z === "All") return true;
      return zoneLetterOfClient(t.zone) === z;
    });
  }

  function renderMentorOps() {
    if (!$("mentorOpsTable")) return;
    document.querySelectorAll("#mentorOpsChips [data-mzone]").forEach((b) => b.classList.toggle("active", b.dataset.mzone === state.mentorOpsZone));
    const mentors = filteredMentorOps();
    const withStatus = mentors.map((t) => Object.assign({}, t, { _status: mentorOpsStatus_(t) }));
    const inPerson = withStatus.filter((t) => (t.mode || "In-person") === "In-person").length;
    const virtual = withStatus.filter((t) => t.mode === "Live virtual").length;
    const preRec = withStatus.filter((t) => t.mode === "Pre-recorded").length;
    const needsAttention = withStatus.filter((t) => t._status.flag === "nomentor").length;
    $("mentorOpsSummary").innerHTML = `
      <div class="box"><div class="n">${inPerson}</div><div class="l">In-person</div></div>
      <div class="box"><div class="n">${virtual}</div><div class="l">Live virtual</div></div>
      <div class="box"><div class="n">${preRec}</div><div class="l">Pre-recorded</div></div>
      <div class="box"><div class="n">${needsAttention}</div><div class="l">Needs attention</div></div>
    `;
    if (!withStatus.length) {
      $("mentorOpsTable").innerHTML = '<div class="empty">No mentors in this zone yet.</div>';
      return;
    }
    const rows = withStatus
      .slice()
      .sort((a, b) => (a._status.flag === "nomentor" ? -1 : 1) - (b._status.flag === "nomentor" ? -1 : 1) || a.name.localeCompare(b.name))
      .map((t) => {
        const where = t.cluster || t.zone || "—";
        const link = t.sessionLink ? `<br><a href="${escAttr(t.sessionLink)}" target="_blank" rel="noopener" style="font-size:10.5px;">Open link</a>` : "";
        return `<tr>
          <td>${esc(t.name)}</td>
          <td>${esc(where)}</td>
          <td>${esc(t.mode || "In-person")}</td>
          <td><span class="flagpill flag-${t._status.flag}">${esc(t._status.label)}</span>${link}</td>
        </tr>`;
      })
      .join("");
    $("mentorOpsTable").innerHTML = `
      <table class="dash-table">
        <thead><tr><th>Mentor</th><th>Cluster / Zone</th><th>Format</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function renderDashTaskPhases() {
    const phases = uniqueSorted(state.tasks.map((t) => t.phase));
    const html = phases
      .map((phase) => {
        const items = state.tasks.filter((t) => t.phase === phase);
        const done = items.filter((t) => t.state === "Done").length;
        const pct = items.length ? (done / items.length) * 100 : 0;
        return `
        <div class="dash-bar-row">
          <div class="toprow"><span>${esc(phase)}</span><b>${done} / ${items.length}</b></div>
          <div class="dash-bar-track"><div class="dash-bar-fill" style="width:${pct}%"></div></div>
        </div>
      `;
      })
      .join("");
    $("dashTaskPhases").innerHTML = html || '<div class="empty">No tasks yet.</div>';
  }

  function renderDashZoneTable() {
    const zones = ["Zone A", "Zone B", "Zone C", "Zone D", "Zone E"];
    const rows = zones
      .map((z) => {
        const inZone = state.team.filter((t) => (t.zone || "").indexOf(z.replace("Zone ", "")) !== -1 || t.zone === z);
        const confirmed = inZone.filter((t) => t.status === "Confirmed").length;
        const coord = inZone.find((t) => t.role === "Zone Coordinator");
        return `<tr><td>${esc(z)}</td><td>${esc(coord ? coord.name : "—")}</td><td>${inZone.length}</td><td>${confirmed}</td></tr>`;
      })
      .join("");
    $("dashZoneTable").innerHTML = `
      <table class="dash-table">
        <thead><tr><th>Zone</th><th>Coordinator</th><th>Team</th><th>Confirmed</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function renderDashProjection() {
    const now = new Date();
    const total = state.students.length;
    const target = Object.values(COHORT_TARGETS).reduce((a, b) => a + b, 0);
    const el = $("dashProjection");
    if (now < REG_OPEN) {
      el.innerHTML = `Pre-registration hasn't opened yet (opens ${REG_OPEN.toDateString()}). <b>${total}</b> registered so far via early/walk-in entries.`;
      return;
    }
    const daysElapsed = Math.max(1, (now - REG_OPEN) / 86400000);
    const daysRemaining = Math.max(0, (REG_CLOSE - now) / 86400000);
    const dailyRate = total / daysElapsed;
    const projected = Math.min(target, Math.round(total + dailyRate * daysRemaining));
    const projectedPct = ((projected / target) * 100).toFixed(0);
    if (now > REG_CLOSE) {
      el.innerHTML = `Registration window has closed. <b>${total} / ${target}</b> (${((total / target) * 100).toFixed(0)}%) registered by the 20 Aug deadline.`;
    } else {
      el.innerHTML = `At the current pace (~<b>${dailyRate.toFixed(0)}/day</b>), registration is projected to reach <b>${projected} / ${target} (${projectedPct}%)</b> by the 20 Aug close — ${daysRemaining.toFixed(0)} day(s) remaining. This is a simple straight-line estimate, not a guarantee.`;
    }
  }

  // ---------------------------------------------------------------------
  // SCHEDULE MODULE (Find Student / My Class / My Room)
  // ---------------------------------------------------------------------
  function setScheduleMode(mode) {
    state.scheduleMode = mode;
    document.querySelectorAll("#scheduleModeChips [data-smode]").forEach((b) => b.classList.toggle("active", b.dataset.smode === mode));
    $("findPane").classList.toggle("hidden", mode !== "find");
    $("classPane").classList.toggle("hidden", mode !== "class");
    $("roomPane").classList.toggle("hidden", mode !== "room");
    renderSchedule();
  }

  // One card per Round 1-3 (standard, always shown), Round 4 (only if this
  // student actually has an approved/assigned spillover — see
  // spilloverApproved/setStudentSpillover_ in Code.gs, never shown as a
  // blank "Pending" line for everyone else), plus Lab1/Lab2/Lunch/Exhibition
  // — the whole day, in the actual clock order it happens (via
  // cohortDayBlocks_), so a Find Student lookup answers "where is she right
  // now / next" without anyone needing the printed itinerary in hand.
  function roundCardHtml_(s, i) {
    const cid = s["round" + i];
    const filled = !!cid;
    const label = filled ? clusterLabel(cid) : i === 4 ? "Extra round — not yet arranged" : "Not yet allocated";
    const c = filled ? state.clusters.find((x) => x.id === cid) : null;
    const room = c ? "Room " + (c.room || c.id) : filled ? "Room " + cid : "—";
    const time = scheduleTime_(s.cohort, i);
    return `
        <div class="roundcard">
          <div>
            <div class="rlabel">Round ${i}${i === 4 ? " (extra)" : ""}${time ? " · " + esc(time) : ""}</div>
            <div class="rname">${esc(label)}</div>
            <div class="rroom">${esc(room)}</div>
          </div>
          <div class="rstatus ${filled ? "filled" : ""}">${filled ? "Set" : "Pending"}</div>
        </div>`;
  }

  function studentRoundCards(s) {
    const blocks = cohortDayBlocks_(s.cohort);
    if (!blocks.length) {
      // Schedule sheet not loaded/set for this cohort yet — fall back to a
      // plain round1-3(+4) view rather than rendering nothing.
      return [1, 2, 3, 4]
        .filter((r) => r <= 3 || s.spilloverApproved === "Yes" || s["round" + r])
        .map((r) => roundCardHtml_(s, r))
        .join("");
    }
    return blocks
      .map((b) => {
        if (/^[1-4]$/.test(String(b.round))) {
          const r = Number(b.round);
          if (r === 4 && s.spilloverApproved !== "Yes" && !s.round4) return ""; // optional extra round not arranged for her
          return roundCardHtml_(s, r);
        }
        // Same swap as studentItineraryBlocks_ — a girl with an actually-
        // assigned round4 spends this exhibition slot in her extra
        // mentorship session instead (see ROUND4_SWAPS_WITH above).
        if (b.round === ROUND4_SWAPS_WITH[s.cohort] && s.round4) return "";
        const label = SCHEDULE_BLOCK_LABELS[b.round] || String(b.round);
        const time = b.startTime + (b.endTime ? "–" + b.endTime : "");
        return `
        <div class="roundcard roundcard--block">
          <div>
            <div class="rlabel">${esc(label)}${time ? " · " + esc(time) : ""}</div>
          </div>
        </div>`;
      })
      .filter(Boolean)
      .join("");
  }

  // Grants/revokes spilloverApproved for one student — the only way to mark
  // an extra (4th) round as privately arranged (see canApproveSpillover /
  // set_student_spillover in Code.gs). Approving does NOT assign a round4
  // cluster itself — that still happens the next time Run Allocation is
  // used (Dashboard), same as every other round, so capacity stays correct.
  function toggleStudentSpillover_(id, name, currentlyApproved) {
    const approve = !currentlyApproved;
    const msg = approve
      ? `Approve an extra (4th) mentorship round for ${name}? Only confirm this once the mentor/cluster for it has actually been arranged — her round 4 cluster gets filled in the next time allocation runs.`
      : `Remove the approved extra round for ${name}?`;
    if (!confirm(msg)) return;
    if (DEMO_MODE) {
      const s = state.students.find((x) => x.id === id);
      if (s) s.spilloverApproved = approve ? "Yes" : "";
      renderAll();
      return;
    }
    apiPost({ action: "set_student_spillover", id, approved: approve })
      .then((res) => {
        if (!res.ok) { alert(res.error || "Couldn't update."); return; }
        const s = state.students.find((x) => x.id === id);
        if (s) s.spilloverApproved = approve ? "Yes" : "";
        renderAll();
      })
      .catch((e) => alert("Couldn't update: " + e.message));
  }

  function renderFindResults() {
    const q = $("findSearch").value.trim().toLowerCase();
    const box = $("findResults");
    if (!q) {
      box.innerHTML = "";
      return;
    }
    // Career Day ID only — never admission number. That's the school's own
    // private student record data, not ours to surface or match against
    // anywhere in this app, even in a search box.
    const matches = state.students.filter(
      (s) => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)
    ).slice(0, 15);
    if (!matches.length) {
      box.innerHTML = '<div class="empty">No student found. Check the spelling, or they may not be registered yet.</div>';
      return;
    }
    box.innerHTML = matches
      .map(
        (s) => `
      <div class="card">
        <div class="toprow">
          <div>
            <div class="phase-tag">${esc(s.cohort)} &middot; ${esc(s.classStream)}</div>
            <div class="tasktext">${esc(s.name)}</div>
          </div>
          <span class="pill ${s.status === "Allocated" ? "Done" : "Pending"}">${esc(s.status || "Pending")}</span>
        </div>
        <div class="meta"><span><b>ID:</b> ${esc(s.id)}</span></div>
        ${studentRoundCards(s)}
        <div class="actions" style="margin-top:6px;">
          <button class="btn ghost" data-qr-id="${escAttr(s.id)}" data-qr-name="${escAttr(s.name)}" data-qr-email="${escAttr(s.email || "")}">View / Resend QR</button>
          ${canApproveSpillover() ? `<button class="btn ghost" data-spillover-id="${escAttr(s.id)}" data-spillover-name="${escAttr(s.name)}" data-spillover-current="${s.spilloverApproved === "Yes" ? "1" : "0"}">${s.spilloverApproved === "Yes" ? "✓ Extra Round Approved (remove)" : "Approve Extra Round"}</button>` : ""}
        </div>
      </div>
    `
      )
      .join("");
  }

  function populateClassSelect() {
    const sel = $("classSelect");
    // Not uniqueSorted() here — its default string sort is the same
    // K1/K10/K11.../K2 ordering bug as everywhere else classStream names
    // get listed (see naturalClassCompare_).
    const classes = Array.from(new Set(state.students.map((s) => s.classStream).filter(Boolean))).sort(naturalClassCompare_);
    const current = sel.value;
    sel.innerHTML = classes.map((c) => `<option value="${escAttr(c)}">${esc(c)}</option>`).join("");
    if (classes.indexOf(current) !== -1) sel.value = current;
  }

  // One-line "R1 B1 10:30 · R2 C2 11:15 · R3 — · R4 —" summary for a
  // student, so a Class Teacher scanning their roster can see at a glance
  // where each of their students is meant to be without opening each
  // student's full round cards (that detail is still available via Find
  // Student). Blank/"—" for a round that isn't allocated or has no time
  // set yet on the Schedule sheet.
  function studentScheduleLine_(s) {
    // Round 4 only shown once it's actually arranged for her (approved
    // spillover or already assigned) — otherwise it's not part of her day
    // and a bare "R4 —" would just read as a missing allocation.
    const roundNums = [1, 2, 3].concat(s.spilloverApproved === "Yes" || s.round4 ? [4] : []);
    return roundNums
      .map((i) => {
        const cid = s["round" + i];
        if (!cid) return `R${i} —`;
        const time = scheduleTime_(s.cohort, i);
        return `R${i} ${esc(cid)}${time ? " " + esc(time) : ""}`;
      })
      .join(" &middot; ");
  }

  function renderClassPane() {
    populateClassSelect();
    const sel = $("classSelect");
    // Auto-select a signed-in Class Teacher's own class the first time My
    // Class is opened, mirroring how My Room auto-detects a mentor's own
    // cluster — but only once, so it doesn't keep overriding the dropdown
    // after they've deliberately browsed to a different class/stream.
    if (!state.classPaneAutoApplied) {
      state.classPaneAutoApplied = true;
      const meRow = state.session ? state.team.find((t) => t.name.toLowerCase() === state.session.name.toLowerCase()) : null;
      const myClass = meRow && meRow.role === "Class Teacher" ? String(meRow.classStream || "").trim() : "";
      if (myClass && Array.from(sel.options).some((o) => o.value === myClass)) {
        sel.value = myClass;
      }
    }
    const cls = sel.value;
    const roster = state.students.filter((s) => s.classStream === cls);
    // "Fully allocated" means her 3 STANDARD rounds — round4 is an optional
    // extra only some students arrange (see spilloverApproved in Code.gs),
    // so requiring it here would make nearly everyone show as incomplete.
    const allocated = roster.filter((s) => s.round1 && s.round2 && s.round3).length;
    const noChoices = roster.filter((s) => !s.choices).length;
    $("classSummary").innerHTML = `
      <div class="box"><div class="n">${roster.length}</div><div class="l">Registered</div></div>
      <div class="box"><div class="n">${allocated}</div><div class="l">Fully Allocated</div></div>
      <div class="box"><div class="n">${noChoices}</div><div class="l">No Choices Yet</div></div>
    `;
    $("classList").innerHTML = roster.length
      ? roster
          .map(
            (s) => `
      <div class="result-item">
        <div>
          <div class="rname">${esc(s.name)}</div>
          <div class="rmeta">${esc(s.id)} &middot; ${s.choices ? s.choices.split(",").length + " choices" : "no choices submitted"}</div>
          <div class="rmeta">${studentScheduleLine_(s)}</div>
        </div>
        <span class="statuspill ${s.status === "Allocated" ? "Confirmed" : "Unconfirmed"}">${esc(s.status || "Pending")}</span>
      </div>
    `
          )
          .join("")
      : '<div class="empty">No students registered under this class yet.</div>';
  }

  // Matches a Team member's free-text `cluster` field (e.g. "A1 Medical Practitioners")
  // to a real Clusters row, by ID substring or exact name. Shared by My Room and the
  // Capacity & Coverage panel so mentor-per-cluster counts stay consistent everywhere.
  function teamMemberCluster(t) {
    if (!t || !t.cluster) return null;
    const text = String(t.cluster).trim();
    // Anchored on purpose: matching the id ANYWHERE in the free-text field
    // (the old behavior) risks a false match if someone's notes mention a
    // different cluster in passing (e.g. "Backup for A1 if needed" on a B1
    // mentor's row would have wrongly counted as an A1 mentor). Requiring
    // the id at the very start — as it's always entered ("A1 Medical
    // Practitioners") — avoids that.
    return (
      state.clusters.find((c) => text === c.id || text === c.name || text.indexOf(c.id + " ") === 0) || null
    );
  }

  // Same anchored-match resolution as teamMemberCluster(), but against the
  // `secondaryCluster` field — a mentor's backup/2nd-choice cluster, carried
  // over from their application. By itself this is just a listing (doesn't
  // count toward capacity/coverage); it only starts counting once a Lead
  // confirms it via reassign_mentor_cluster (mode: "dual"), which sets
  // secondaryClusterConfirmed = "Yes". See TEAM_HEADERS doc comment in
  // Code.gs for the full data-model rationale.
  function teamMemberSecondaryCluster(t) {
    if (!t || !t.secondaryCluster) return null;
    const text = String(t.secondaryCluster).trim();
    return (
      state.clusters.find((c) => text === c.id || text === c.name || text.indexOf(c.id + " ") === 0) || null
    );
  }

  function renderRoomPane() {
    const me = state.who ? state.team.find((t) => t.name.toLowerCase() === state.who.toLowerCase()) : null;
    const myCluster = teamMemberCluster(me);
    if (!state.who) {
      $("roomWho").innerHTML = 'Tap <b>"Sign in"</b> at the top with your name to see your own room automatically — or browse by picking a cluster below.';
    } else if (!myCluster) {
      $("roomWho").innerHTML = `Signed in as <b>${esc(state.who)}</b> — no cluster is on file for you yet in the Team tab. Ask a Zone Coordinator to add your cluster, or browse by cluster below.`;
    } else {
      $("roomWho").innerHTML = `<b>${esc(state.who)}</b> &middot; ${esc(myCluster.name)} &middot; Room ${esc(myCluster.room || myCluster.id)}<br><span style="font-weight:400;font-size:12.5px;">This is also your personal schedule — each round below shows the time and cohort you'll be mentoring.</span>`;
    }
    const cluster = myCluster || state.clusters[0];
    if (!cluster) {
      $("roomRounds").innerHTML = '<div class="empty">No clusters loaded yet.</div>';
      return;
    }
    let html = `<div class="chiprow" id="roomClusterChips">` +
      state.clusters.map((c) => `<button class="chip ${c.id === cluster.id ? "active" : ""}" data-roomcluster="${escAttr(c.id)}">${esc(c.id)}</button>`).join("") +
      `</div>`;
    // A physical room hosts a DIFFERENT cohort in each of the day's 3
    // slots (Form 4, then Grade 10 A, then Grade 10 B) — so "Round 1" in
    // this room means a different clock time depending on which cohort is
    // actually in it. Group by cohort within each round rather than
    // assuming one straightforward round -> time mapping.
    for (let r = 1; r <= 4; r++) {
      const key = "round" + r;
      const inRound = state.students.filter((s) => s[key] === cluster.id);
      const byCohort = {};
      inRound.forEach((s) => { (byCohort[s.cohort] = byCohort[s.cohort] || []).push(s); });
      const cohorts = uniqueSorted(Object.keys(byCohort));
      if (!cohorts.length) {
        html += `<div class="group-label">Round ${r}</div><div class="empty">No one assigned here yet for this round.</div>`;
        continue;
      }
      cohorts.forEach((coh) => {
        const time = scheduleTime_(coh, r);
        html += `<div class="group-label">Round ${r}${time ? " · " + esc(time) : ""} · ${esc(COHORT_LABELS[coh] || coh)} · ${byCohort[coh].length} student(s)</div>`;
        html += byCohort[coh].map((s) => `<div class="checkin-row"><div><div class="cname">${esc(s.name)}</div><div class="cmeta">${esc(s.id)} &middot; ${esc(s.classStream)}</div></div></div>`).join("");
      });
    }
    if (state.settings && (state.settings.roomMapUrl || state.settings.roomCoordinatorName)) {
      html += `<div class="group-label">Room Map &amp; Coordination</div><div class="callout-box">` +
        (state.settings.roomMapUrl ? `<a href="${escAttr(state.settings.roomMapUrl)}" target="_blank" rel="noopener">View the room map</a><br>` : "") +
        (state.settings.roomCoordinatorName ? `Room coordinator: <b>${esc(state.settings.roomCoordinatorName)}</b>${state.settings.roomCoordinatorContact ? " · " + esc(state.settings.roomCoordinatorContact) : ""}` : "") +
        `</div>`;
    }
    $("roomRounds").innerHTML = html;
  }

  function renderSchedule() {
    if (!$("findResults")) return;
    if (state.scheduleMode === "find") renderFindResults();
    if (state.scheduleMode === "class") renderClassPane();
    if (state.scheduleMode === "room") renderRoomPane();
  }

  // ---------------------------------------------------------------------
  // ALLOCATION (Dashboard action)
  // ---------------------------------------------------------------------
  // Client-side mirror of Code.gs's runAllocation_, used only in Demo Mode
  // where there's no backend to call. Same algorithm: per-cohort capacity
  // pools (cohorts share rooms at different times, so they don't compete
  // for the same seats), greedy cascading choice per round, no repeats.
  // Round 4 is deliberately excluded from the main cascading loop — it's an
  // optional extra only for students with spilloverApproved === "Yes" (see
  // setStudentSpillover_/runAllocation_ in Code.gs), filled in a separate
  // pass afterward so it never silently consumes a standard-round seat or
  // gets treated as required for "fully allocated".
  function runAllocationLocal(force) {
    const capacity = {};
    function ensure(co) {
      if (capacity[co]) return;
      capacity[co] = { 1: {}, 2: {}, 3: {}, 4: {} };
      state.clusters.forEach((c) => { for (let r = 1; r <= 4; r++) capacity[co][r][c.id] = c.capacity; });
    }
    state.students.forEach((s) => ensure(s.cohort));
    state.students.forEach((s) => {
      for (let r = 1; r <= 4; r++) {
        const cid = s["round" + r];
        if (cid && capacity[s.cohort][r][cid] !== undefined) capacity[s.cohort][r][cid]--;
      }
    });

    let candidates = state.students.filter((s) => s.choices && (force || !(s.round1 && s.round2 && s.round3)));
    if (force) candidates.forEach((s) => { s.round1 = s.round2 = s.round3 = s.round4 = ""; });
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    let roundsAssigned = 0;
    for (let round = 1; round <= 3; round++) {
      const key = "round" + round;
      candidates.forEach((s) => {
        if (s[key]) return;
        const used = [s.round1, s.round2, s.round3, s.round4].filter(Boolean);
        const choices = String(s.choices).split(",").map((x) => x.trim()).filter(Boolean);
        for (const cid of choices) {
          if (used.indexOf(cid) !== -1) continue;
          if (capacity[s.cohort][round][cid] > 0) {
            s[key] = cid;
            capacity[s.cohort][round][cid]--;
            roundsAssigned++;
            break;
          }
        }
      });
    }
    // Separate round-4 pass — scans ALL students (not just this batch's
    // candidates), same as the server, since a spillover approval can land
    // on a student who was already fully allocated earlier.
    let round4Assigned = 0;
    state.students
      .filter((s) => s.spilloverApproved === "Yes" && !s.round4 && s.choices)
      .forEach((s) => {
        const used = [s.round1, s.round2, s.round3].filter(Boolean);
        const choices = String(s.choices).split(",").map((x) => x.trim()).filter(Boolean);
        for (const cid of choices) {
          if (used.indexOf(cid) !== -1) continue;
          if (capacity[s.cohort][4][cid] > 0) {
            s.round4 = cid;
            capacity[s.cohort][4][cid]--;
            round4Assigned++;
            break;
          }
        }
      });
    let incomplete = 0;
    candidates.forEach((s) => {
      const full = s.round1 && s.round2 && s.round3;
      if (!full) incomplete++;
      else if (s.status === "Pending" || s.status === "Walk-in") s.status = "Allocated";
    });
    return { roundsAssigned, round4Assigned, studentsProcessed: candidates.length, studentsIncomplete: incomplete };
  }

  function runAllocationClick() {
    const btn = $("runAllocationBtn");
    btn.disabled = true;
    btn.textContent = "Running…";
    const done = (result) => {
      btn.disabled = false;
      btn.textContent = "Run Allocation";
      renderAll();
      alert(`Allocation done.\n${result.roundsAssigned} standard round-assignments made across ${result.studentsProcessed} students${result.round4Assigned ? ` (plus ${result.round4Assigned} approved spillover round-4 assignment(s))` : ""}.\n${result.studentsIncomplete} student(s) couldn't get all 3 standard rounds (ran out of matching choices with open capacity — add more choices or increase cluster capacity).`);
    };
    if (DEMO_MODE) {
      done(runAllocationLocal(false));
    } else {
      apiPost({ action: "run_allocation", force: false })
        .then((res) => {
          if (!res.ok) throw new Error(res.error);
          return refresh(false).then(() => done(res));
        })
        .catch((e) => {
          btn.disabled = false;
          btn.textContent = "Run Allocation";
          alert("Allocation failed: " + e.message);
        });
    }
  }

  function renderDashAllocStatus() {
    const withChoices = state.students.filter((s) => s.choices);
    const full = withChoices.filter((s) => s.round1 && s.round2 && s.round3);
    const spilloverApproved = state.students.filter((s) => s.spilloverApproved === "Yes");
    const spilloverAssigned = spilloverApproved.filter((s) => s.round4);
    const el = $("dashAllocStatus");
    if (!withChoices.length) {
      el.innerHTML = "No students have submitted cluster choices yet — nothing to allocate.";
    } else {
      el.innerHTML =
        `<b>${full.length} / ${withChoices.length}</b> students with choices are fully allocated across their 3 standard rounds. Running allocation again only fills in what's still missing (existing assignments are kept).` +
        (spilloverApproved.length
          ? `<br><b>${spilloverAssigned.length} / ${spilloverApproved.length}</b> approved extra (round 4) requests have a cluster assigned.`
          : "");
    }
  }

  // ---------------------------------------------------------------------
  // CAPACITY & COVERAGE — per-cluster demand vs. seats, and mentor coverage,
  // so leaders can spot rooms to resize/reassign and clusters that need
  // more (or could spare a) mentor before the day.
  // ---------------------------------------------------------------------
  const ROOM_MENTOR_ROLES = ["Mentor", "Cluster Lead", "Sub-Lead"];

  // NOTE ON NAMING: "interested"/"allocated" here are STUDENT figures (how
  // many students ranked/were placed in this cluster) — a Reports-page
  // reader once mistook these for mentor figures, since some clusters
  // showed a mentor on the Team tab but 0 "interested"/"allocated". Mentor
  // figures are their own fields below (mentorsAssigned/mentorsBackup/
  // mentorsInterested) so the two populations are never conflated again.
  function clusterStats() {
    return state.clusters.map((c) => {
      // Demand: unique students who ranked this cluster anywhere in their
      // choices. A student can only ever attend a cluster once (rounds never
      // repeat a cluster for the same student), so this is a true headcount
      // of interest, not a per-round figure.
      const interested = state.students.filter((s) => s.choices && String(s.choices).split(",").map((x) => x.trim()).indexOf(c.id) !== -1);
      // Allocated so far: students actually placed in this cluster in any round.
      const allocated = state.students.filter((s) => [s.round1, s.round2, s.round3, s.round4].indexOf(c.id) !== -1);
      // Seats across the whole day: this room is reused by each of the 3
      // cohorts (Form 4 / G10A / G10B) across their own 4 rounds, at
      // non-overlapping times (Playbook Section 18.1) — so total day capacity
      // is capacity x 4 rounds x 3 cohort-blocks.
      const cohortsInPlay = uniqueSorted(state.students.map((s) => s.cohort)).length || 3;
      const dayCapacity = c.capacity * 4 * Math.max(1, cohortsInPlay);
      const ratio = dayCapacity ? interested.length / dayCapacity : 0;

      // MENTOR figures — three distinct populations, never merged into one
      // number, so "there's a mentor on file but the report shows nothing"
      // can't happen again:
      //   mentorsAssigned — primary cluster is this one. Counts toward capacity.
      //   mentorsBackup    — SECONDARY (2nd-choice) cluster is this one, i.e.
      //                      "under consideration" here. Shown for visibility
      //                      but does NOT count toward capacity unless confirmed.
      //   mentorsBackupConfirmed — subset of the above a Lead has actually
      //                      confirmed as a dual/backup mentor here (see
      //                      reassignMentorCluster_ mode:"dual" in Code.gs) —
      //                      these DO count toward capacity/coverage.
      //   mentorsInterested — assigned + ALL backups (confirmed or not) —
      //                      "anyone who has indicated this cluster in any way."
      const activeTeam = state.team.filter((t) => t.status !== "Deleted" && ROOM_MENTOR_ROLES.indexOf(t.role) !== -1);
      const mentorsAssigned = activeTeam.filter((t) => teamMemberCluster(t) && teamMemberCluster(t).id === c.id);
      const mentorsBackupAll = activeTeam.filter((t) => {
        const sec = teamMemberSecondaryCluster(t);
        return sec && sec.id === c.id && !(teamMemberCluster(t) && teamMemberCluster(t).id === c.id);
      });
      const mentorsBackupConfirmed = mentorsBackupAll.filter((t) => t.secondaryClusterConfirmed === "Yes");
      const mentorsAssignedCount = mentorsAssigned.length + mentorsBackupConfirmed.length;

      let flag = "ok";
      if (interested.length > 0 && mentorsAssignedCount === 0 && mentorsBackupAll.length > 0) flag = "backuponly";
      else if (interested.length > 0 && mentorsAssignedCount === 0) flag = "nomentor";
      else if (ratio > 1.15) flag = "over";
      else if (ratio < 0.4 && interested.length === 0) flag = "unused";
      else if (ratio < 0.4) flag = "under";
      return {
        cluster: c, interested: interested.length, allocated: allocated.length, dayCapacity, ratio,
        mentors: mentorsAssignedCount, // kept for backward compat with any other caller
        mentorsAssigned: mentorsAssigned.length,
        mentorsBackup: mentorsBackupAll.length,
        mentorsBackupConfirmed: mentorsBackupConfirmed.length,
        mentorsInterested: mentorsAssigned.length + mentorsBackupAll.length,
        mentorRows: mentorsAssigned, backupRows: mentorsBackupAll,
        flag,
      };
    });
  }

  // ---------------------------------------------------------------------
  // SESSION / SHIFT COVERAGE — cross-references each mentor-tier team
  // member's `shifts` availability with their cluster assignment against
  // the real event structure. The day runs 3 sequential (never
  // simultaneous) mentorship windows — Form 4 late-morning, Grade 10 A and
  // Grade 10 B both in the afternoon (see SEED_SCHEDULE Revision 3 in
  // Code.gs) — so "Morning" shift covers F4's window and "Afternoon"
  // covers both Grade 10 waves. A cluster can have mentors overall but
  // still have a real, specific hole in one shift — clusterStats()'s
  // coarser "no mentor at all" flag won't catch that; this does. Uses the
  // same keyword-matching convention as mentorShiftLabel_ above, so it
  // still works if someone hand-edits the shifts cell with different wording.
  // ---------------------------------------------------------------------
  function shiftsCoverMorning_(raw) {
    const s = String(raw || "").toLowerCase();
    return s.indexOf("morning") !== -1 || s.indexOf("either") !== -1 || s.indexOf("both") !== -1;
  }
  function shiftsCoverAfternoon_(raw) {
    const s = String(raw || "").toLowerCase();
    return s.indexOf("afternoon") !== -1 || s.indexOf("either") !== -1 || s.indexOf("both") !== -1;
  }

  // Confirmed dual/backup mentors (secondaryClusterConfirmed === "Yes")
  // fold into their SECONDARY cluster's shift coverage too — but only for a
  // shift where their PRIMARY cluster doesn't solely depend on them for
  // that same shift (i.e. some other mentor also covers it there), so a
  // dual commitment never quietly creates a new hole at their home
  // cluster. See the TEAM_HEADERS doc comment in Code.gs for the full rule.
  function mentorIsSpareForShift_(t, shiftCheckFn, activeMentors) {
    const home = teamMemberCluster(t);
    if (!home) return true;
    return activeMentors.some((o) => o.id !== t.id && teamMemberCluster(o) && teamMemberCluster(o).id === home.id && shiftCheckFn(o.shifts));
  }

  function computeShiftCoverage_() {
    const activeMentors = state.team.filter((t) => ROOM_MENTOR_ROLES.indexOf(t.role) !== -1 && t.status !== "Deleted");
    const confirmedDuals = activeMentors.filter((t) => t.secondaryClusterConfirmed === "Yes" && teamMemberSecondaryCluster(t));

    return state.clusters.map((c) => {
      const primaryMentors = activeMentors.filter((t) => teamMemberCluster(t) && teamMemberCluster(t).id === c.id);
      const backupsHere = confirmedDuals.filter((t) => teamMemberSecondaryCluster(t).id === c.id);
      const backupMorning = backupsHere.filter((t) => shiftsCoverMorning_(t.shifts) && mentorIsSpareForShift_(t, shiftsCoverMorning_, activeMentors));
      const backupAfternoon = backupsHere.filter((t) => shiftsCoverAfternoon_(t.shifts) && mentorIsSpareForShift_(t, shiftsCoverAfternoon_, activeMentors));
      const morning = primaryMentors.filter((t) => shiftsCoverMorning_(t.shifts)).concat(backupMorning);
      const afternoon = primaryMentors.filter((t) => shiftsCoverAfternoon_(t.shifts)).concat(backupAfternoon);
      const totalMentors = uniqueSorted(primaryMentors.map((t) => t.id).concat(backupsHere.map((t) => t.id))).length;
      const interested = state.students.filter((s) => s.choices && String(s.choices).split(",").map((x) => x.trim()).indexOf(c.id) !== -1).length;
      return {
        cluster: c,
        totalMentors,
        primaryCount: primaryMentors.length,
        backupCount: backupsHere.length,
        morningCount: morning.length,
        afternoonCount: afternoon.length,
        interested,
        // Gap = has SOME mentor coverage overall but a real hole in one
        // specific shift — a cluster with zero mentors at all is already
        // covered by the coarser "no mentor" flag elsewhere.
        morningGap: totalMentors > 0 && morning.length === 0,
        afternoonGap: totalMentors > 0 && afternoon.length === 0,
      };
    });
  }

  function setCapacityFilter(f) {
    state.capacityFilter = f;
    document.querySelectorAll("#dashCapacityChips [data-cfilter]").forEach((b) => b.classList.toggle("active", b.dataset.cfilter === f));
    renderDashCapacity();
  }

  const FLAG_LABEL = {
    over: "Oversubscribed",
    under: "Spare capacity",
    unused: "No student interest yet",
    nomentor: "No mentor assigned",
    backuponly: "Backup mentor only",
    ok: "Balanced",
  };

  function renderDashCapacity() {
    if (!$("dashCapacityTable")) return;
    const stats = clusterStats();
    const over = stats.filter((s) => s.flag === "over").length;
    const under = stats.filter((s) => s.flag === "under" || s.flag === "unused").length;
    const noMentor = stats.filter((s) => s.flag === "nomentor").length;
    $("dashCapacitySummary").innerHTML = `
      <div class="box"><div class="n">${over}</div><div class="l">Oversubscribed</div></div>
      <div class="box"><div class="n">${under}</div><div class="l">Spare capacity</div></div>
      <div class="box"><div class="n">${noMentor}</div><div class="l">No mentor yet</div></div>
    `;
    const filter = state.capacityFilter || "all";
    const rows = stats
      .filter((s) => filter === "all" || s.flag === filter || (filter === "under" && s.flag === "unused"))
      .sort((a, b) => b.ratio - a.ratio)
      .map(
        (s) => `
      <tr>
        <td>${esc(s.cluster.id)} &middot; ${esc(s.cluster.name)}</td>
        <td>Zone ${esc(s.cluster.zone)}</td>
        <td>${s.interested}</td>
        <td>${s.dayCapacity}</td>
        <td>${s.allocated}</td>
        <td>${s.mentors}</td>
        <td><span class="flagpill flag-${s.flag}">${esc(FLAG_LABEL[s.flag])}</span></td>
      </tr>`
      )
      .join("");
    $("dashCapacityTable").innerHTML = `
      <table class="dash-table">
        <thead><tr><th>Cluster</th><th>Zone</th><th>Interested</th><th>Day capacity</th><th>Allocated</th><th>Mentors</th><th>Status</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" class="empty">No clusters match this filter.</td></tr>'}</tbody>
      </table>
      <p class="hint">"Interested" counts students who ranked this cluster in their choices, whether or not allocation has run. "Day capacity" = room capacity &times; 4 rounds &times; ${uniqueSorted(state.students.map((s) => s.cohort)).length || 3} cohort block(s), since each cohort reuses the same room at a different time. Edit a cluster's capacity directly in the Clusters sheet if a room can genuinely hold more or fewer.</p>
    `;
  }

  // ---------------------------------------------------------------------
  // MENTOR-FIT MATCHING — plain keyword scoring, no external AI service.
  // Client-side mirror of Code.gs's CLUSTER_KEYWORDS_/suggestClusterFit_
  // (duplicated here, not fetched, so gap-filling suggestions render
  // instantly from state already in memory — see that file for the
  // canonical source if these ever need updating). Only ever SUGGESTS who
  // to ask; nothing here books or messages anyone automatically — an
  // intern still has to reach out and get a real yes.
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

  function clusterKeywordScore_(text, clusterId) {
    const kws = CLUSTER_KEYWORDS_[clusterId] || [];
    const t = " " + String(text || "").toLowerCase() + " ";
    let score = 0;
    kws.forEach((kw) => { if (t.indexOf(kw) !== -1) score++; });
    return score;
  }

  // Up to 5 {name, phone, email, score, reason} candidates for a specific
  // cluster+shift gap, ranked so an explicit "I'd help here too" signal
  // outranks a same-shift Team mentor who merely keyword-matches on
  // profession (whose willingness for a SECOND cluster isn't actually
  // known — flagged honestly in the reason text). Three sources:
  //  1. Mentor Database — primary/secondary cluster match, or profession
  //     fit. Covers both historical mentors and this year's approved ones
  //     (secondaryCluster now survives approval — see the Code.gs fix in
  //     upsertMentorDatabaseFromApplication_).
  //  2. Confirmed Team mentors currently assigned elsewhere, same-shift,
  //     profession-fit only (weaker signal, says so).
  //  3. Pending Mentor Applications (admin view only — unvetted applicant
  //     referee/contact info stays admin-only, same boundary the app
  //     already draws for that data) — the strongest signal, since they've
  //     explicitly named a cluster and haven't been placed anywhere yet.
  function suggestMentorsForGap_(clusterId, shiftLabel) {
    const shiftCheck = shiftLabel === "Morning" ? shiftsCoverMorning_ : shiftsCoverAfternoon_;
    const alreadyHereNames = state.team
      .filter((t) => t.status !== "Deleted" && teamMemberCluster(t) && teamMemberCluster(t).id === clusterId)
      .map((t) => (t.name || "").trim().toLowerCase());
    const candidates = [];

    (state.mentorDatabase || []).forEach((m) => {
      if (["Declined", "Unreachable"].indexOf(m.outreachStatus) !== -1) return;
      if (m.name && alreadyHereNames.indexOf(m.name.trim().toLowerCase()) !== -1) return;
      let score = 0, reason = "";
      if (m.primaryClusterId === clusterId) { score = 10; reason = "Named this as their primary cluster"; }
      else if (String(m.secondaryClusterIds || "").split(",").indexOf(clusterId) !== -1) { score = 7; reason = "Said they'd also help here"; }
      else {
        const kw = clusterKeywordScore_([m.profession, m.designation].join(" "), clusterId);
        if (kw > 0) { score = kw; reason = "Profession fit: " + (m.profession || m.designation); }
      }
      // sourceType: "database" — a past mentor with no live Team/Application
      // record to act on directly, so the only actions available for these
      // are outreach + "create recruitment task" (see suggestionRowHtml_).
      if (score > 0) candidates.push({ name: m.name, phone: m.phone, email: m.email, score, reason, sourceType: "database" });
    });

    state.team.forEach((t) => {
      if (t.status === "Deleted" || ROOM_MENTOR_ROLES.indexOf(t.role) === -1) return;
      const myCluster = teamMemberCluster(t);
      if (myCluster && myCluster.id === clusterId) return;
      if (!shiftCheck(t.shifts)) return;
      const kw = clusterKeywordScore_(t.notes, clusterId);
      if (kw > 0) {
        candidates.push({
          name: t.name, phone: t.phone, email: t.email, preferredContact: t.preferredContact, score: kw,
          reason: "Already mentoring " + (myCluster ? myCluster.id : "elsewhere") + " — profession may fit here too (ask, don't assume)",
          // sourceType "team" candidates already have a live Team row, so an
          // admin can pull them in directly via reassign_mentor_cluster
          // (as a dual/backup, or a full move) — see suggestionRowHtml_.
          sourceType: "team", sourceId: t.id,
        });
      }
    });

    if (isAdmin()) {
      (state.mentorApplications || []).forEach((a) => {
        if (a.status !== "Pending") return;
        if (!shiftCheck(a.shifts)) return;
        const primary = String(a.primaryCluster || "").trim().toUpperCase();
        const secondary = String(a.secondaryCluster || "").trim().toUpperCase();
        let score = 0, reason = "";
        if (primary === clusterId) { score = 12; reason = "Applied naming this as first choice — not yet approved"; }
        else if (secondary === clusterId) { score = 9; reason = "Applied, named this as a willing second choice"; }
        // sourceType "application" candidates can be approved straight into
        // THIS cluster (bypassing the auto-fallback in
        // approveMentorApplication_) via an explicit body.cluster override.
        if (score > 0) candidates.push({ name: a.name, phone: a.phone, email: a.email, preferredContact: a.preferredContact, score, reason, sourceType: "application", sourceId: a.id });
      });
    }

    const seen = {};
    return candidates
      .filter((c) => {
        const key = (c.name || "").trim().toLowerCase();
        if (!key || seen[key]) return false;
        seen[key] = true;
        return true;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }

  // ---------------------------------------------------------------------
  // OUTREACH ACTIONS — one-tap Call/WhatsApp/Email links for a mentor or
  // candidate, so an intern doesn't have to copy a phone number into
  // another app. Kenyan numbers are entered in mixed formats ("07...",
  // "+254 7...", "254 7..."), so wa.me needs a normalized international
  // digits-only form; tel:/mailto: don't need normalization at all.
  // preferredContact matches the exact three options on the public mentor
  // form (pmPreferredContact: "WhatsApp" / "Phone Call" / "Email") and gets
  // visually promoted with the "oreach-preferred" class so the intern's eye
  // goes straight to the channel that mentor actually said to use.
  // ---------------------------------------------------------------------
  function normalizePhoneForWhatsApp_(phone) {
    let digits = String(phone || "").replace(/[^\d]/g, "");
    if (!digits) return "";
    if (digits.charAt(0) === "0") digits = "254" + digits.slice(1);
    return digits;
  }

  function outreachButtonsHtml_(person) {
    if (!person) return "";
    const phone = String(person.phone || "").trim();
    const email = String(person.email || "").trim();
    const pref = String(person.preferredContact || "").toLowerCase();
    const waPhone = normalizePhoneForWhatsApp_(phone);
    const buttons = [];
    if (phone) {
      buttons.push({ key: "call", href: "tel:" + phone, label: "📞 Call", preferred: pref.indexOf("call") !== -1 });
    }
    if (waPhone) {
      buttons.push({ key: "whatsapp", href: "https://wa.me/" + waPhone, label: "💬 WhatsApp", preferred: pref.indexOf("whatsapp") !== -1 });
    }
    if (email) {
      buttons.push({ key: "email", href: "mailto:" + email, label: "✉️ Email", preferred: pref.indexOf("email") !== -1 });
    }
    if (!buttons.length) return "";
    return `<div class="outreach-row">${buttons
      .map((b) => `<a class="outreach-btn${b.preferred ? " oreach-preferred" : ""}" href="${escAttr(b.href)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">${b.label}${b.preferred ? '<span class="oreach-pref-tag">preferred</span>' : ""}</a>`)
      .join("")}</div>`;
  }

  // clusterId is the cluster this suggestion is being surfaced FOR (not
  // necessarily the candidate's current cluster) — needed so the Assign
  // button knows where to place them. Assign actions are admin-only
  // (mirrors ADMIN_ONLY on reassign_mentor_cluster/approve_mentor_application
  // server-side) and only shown for candidates with a live record to act on
  // — "database" candidates (past mentors, no current Team/Application row)
  // only ever get outreach + the existing recruitment-task button.
  function suggestionRowHtml_(s, clusterId) {
    let assignHtml = "";
    if (isAdmin() && clusterId && s.sourceType === "team" && s.sourceId) {
      assignHtml = `<div class="suggest-assign-row">
        <button type="button" class="btn ghost" style="padding:5px 9px;font-size:11px;" data-ccc-action="dual" data-ccc-team-id="${escAttr(s.sourceId)}" data-ccc-cluster="${escAttr(clusterId)}">+ Pull in as backup</button>
        <button type="button" class="btn ghost" style="padding:5px 9px;font-size:11px;" data-ccc-action="move" data-ccc-team-id="${escAttr(s.sourceId)}" data-ccc-cluster="${escAttr(clusterId)}">Move here fully</button>
      </div>`;
    } else if (isAdmin() && clusterId && s.sourceType === "application" && s.sourceId) {
      assignHtml = `<div class="suggest-assign-row">
        <button type="button" class="btn ghost" style="padding:5px 9px;font-size:11px;" data-ccc-action="approve" data-ccc-app-id="${escAttr(s.sourceId)}" data-ccc-cluster="${escAttr(clusterId)}">+ Approve into this cluster</button>
      </div>`;
    }
    return `<div class="suggest-row"><b>${esc(s.name)}</b>${s.phone ? " · " + esc(s.phone) : ""}<div class="suggest-reason">${esc(s.reason)}</div>${outreachButtonsHtml_(s)}${assignHtml}</div>`;
  }

  function gapShiftBlockHtml_(cluster, shiftLabel, count) {
    const suggestions = suggestMentorsForGap_(cluster.id, shiftLabel);
    const suggestHtml = suggestions.length
      ? suggestions.map((s) => suggestionRowHtml_(s, cluster.id)).join("")
      : '<div class="suggest-none">No obvious fit on file yet — try a general call for this cluster.</div>';
    return `
      <div class="coverage-gap-shift">
        <div class="coverage-gap-shift-head"><span class="flagpill flag-nomentor">${esc(shiftLabel)} gap</span><span class="hint" style="margin:0 0 0 6px;display:inline;">${count} covering this shift</span></div>
        <div class="suggest-list">${suggestHtml}</div>
        <button class="btn ghost" style="padding:6px 10px;font-size:11px;margin-top:6px;" data-recruit-cluster="${escAttr(cluster.id)}" data-recruit-name="${escAttr(cluster.name)}" data-recruit-shift="${escAttr(shiftLabel)}">+ Create recruitment task</button>
      </div>`;
  }

  function coverageGapCardHtml_(c) {
    const parts = [];
    if (c.morningGap) parts.push(gapShiftBlockHtml_(c.cluster, "Morning", c.morningCount));
    if (c.afternoonGap) parts.push(gapShiftBlockHtml_(c.cluster, "Afternoon", c.afternoonCount));
    return `<div class="coverage-gap-card">
      <div class="coverage-gap-title">${esc(c.cluster.id)} &middot; ${esc(c.cluster.name)}</div>
      ${parts.join("")}
    </div>`;
  }

  // Pre-fills and opens the existing Add Task modal — reused by both the
  // Dashboard's Session Coverage cards (Leads/Zone) and the Intern My Day
  // panel, so "spot a gap" and "create the task to fix it" are one tap
  // apart wherever the gap is surfaced. Suggested names go straight into
  // the task notes so whoever picks up the task doesn't have to re-look
  // anything up.
  function openRecruitTaskModal_(clusterId, clusterName, shiftLabel) {
    openAddTaskModal();
    $("newTaskText").value = "Recruit a " + shiftLabel + "-shift mentor for " + clusterId + " " + clusterName;
    $("newTaskPhase").value = "Mentor Recruitment";
    const suggestions = suggestMentorsForGap_(clusterId, shiftLabel);
    if (suggestions.length) {
      $("newTaskNotes").value = "Suggested to ask: " + suggestions.map((s) => s.name + (s.phone ? " (" + s.phone + ")" : "") + " — " + s.reason).join("; ");
    }
  }

  // ---------------------------------------------------------------------
  // CLUSTER COMMAND CENTER — one card per cluster (all 23, not just the
  // ones with a shift gap) showing live mentor headcount, a shift-
  // availability breakdown, a proposed AM/PM rotation, and — for
  // understaffed clusters — floated suggested mentors to recruit. Shared
  // by the exec Dashboard (Leads/Assistant Leads/Zone Coordinators) and
  // the Intern My Day panel so both audiences read identical data, just
  // in their own tab. A fuller companion to Session Coverage above (which
  // only lists clusters with an actual shift-specific hole) — built per
  // WG2's request for "a live cluster update card... all required data
  // for the success of the cluster."
  // ---------------------------------------------------------------------
  // Mentors-per-cluster-per-shift cap, editable via Ops Settings
  // (stgMentorCapacity — see renderOpsSettings/saveOpsSettings) and read
  // server-side too (mentorCapacityPerShift_ in Code.gs, used by
  // approveMentorApplication_'s auto-fallback). Defaults to 8 if unset.
  function mentorCapacityPerShiftClient_() {
    const n = parseInt((state.settings && state.settings.mentorCapacityPerShift) || "8", 10);
    return isNaN(n) || n <= 0 ? 8 : n;
  }

  function computeClusterCommandData_() {
    const cap = mentorCapacityPerShiftClient_();
    const activeMentorsAll = state.team.filter((t) => t.status !== "Deleted" && ROOM_MENTOR_ROLES.indexOf(t.role) !== -1);
    return state.clusters.map((c) => {
      const mentors = state.team
        .filter((t) => t.status !== "Deleted" && ROOM_MENTOR_ROLES.indexOf(t.role) !== -1 && teamMemberCluster(t) && teamMemberCluster(t).id === c.id)
        .map((t) => ({
          id: t.id, name: t.name, phone: t.phone, email: t.email, preferredContact: t.preferredContact,
          shifts: t.shifts, mode: t.mode, role: t.role, notes: t.notes,
        }));
      // Backup/2nd-choice mentors pointed at this cluster — shown so a
      // mentor with a secondary interest here is never invisible on the
      // card, whether or not a Lead has confirmed them yet.
      const backupMentors = activeMentorsAll
        .filter((t) => {
          const sec = teamMemberSecondaryCluster(t);
          return sec && sec.id === c.id && !(teamMemberCluster(t) && teamMemberCluster(t).id === c.id);
        })
        .map((t) => ({
          id: t.id, name: t.name, phone: t.phone, email: t.email, preferredContact: t.preferredContact,
          shifts: t.shifts, primaryCluster: t.cluster, confirmed: t.secondaryClusterConfirmed === "Yes",
        }));
      const morningOnly = mentors.filter((m) => shiftsCoverMorning_(m.shifts) && !shiftsCoverAfternoon_(m.shifts));
      const afternoonOnly = mentors.filter((m) => shiftsCoverAfternoon_(m.shifts) && !shiftsCoverMorning_(m.shifts));
      const eitherBoth = mentors.filter((m) => shiftsCoverMorning_(m.shifts) && shiftsCoverAfternoon_(m.shifts));
      // Either/both mentors are genuinely available for both windows, so
      // they appear in BOTH pools below — this reflects real availability,
      // not a forced pick. The AM/PM split further down only decides who
      // gets PROPOSED where for the PM sub-windows.
      const morningPool = morningOnly.concat(eitherBoth);
      const afternoonPool = afternoonOnly.concat(eitherBoth);

      // Confirmed dual/backup mentors add to capacity too (same "spare"
      // rule as computeShiftCoverage_) — this is what makes a pulled-in
      // backup mentor actually move the fullness bars, not just appear as
      // a name in a list.
      const confirmedBackupRaw = activeMentorsAll.filter((t) => t.secondaryClusterConfirmed === "Yes" && teamMemberSecondaryCluster(t) && teamMemberSecondaryCluster(t).id === c.id);
      const confirmedBackupMorning = confirmedBackupRaw.filter((t) => shiftsCoverMorning_(t.shifts) && mentorIsSpareForShift_(t, shiftsCoverMorning_, activeMentorsAll));
      const confirmedBackupAfternoon = confirmedBackupRaw.filter((t) => shiftsCoverAfternoon_(t.shifts) && mentorIsSpareForShift_(t, shiftsCoverAfternoon_, activeMentorsAll));
      const morningCountWithBackup = morningPool.length + confirmedBackupMorning.length;
      const afternoonCountWithBackup = afternoonPool.length + confirmedBackupAfternoon.length;

      // Proposed rotation. Form 4 is a single AM window, so the whole
      // morning pool covers it together. Grade 10 A and Grade 10 B are two
      // back-to-back PM windows in the SAME physical room, so the
      // afternoon pool is round-robin split between them so no one is
      // proposed for both PM sub-windows unless there's genuinely only one
      // PM mentor available.
      const g10a = [], g10b = [];
      if (afternoonPool.length === 1) {
        g10a.push(afternoonPool[0]);
        g10b.push(afternoonPool[0]);
      } else {
        afternoonPool.forEach((m, i) => { (i % 2 === 0 ? g10a : g10b).push(m); });
      }

      const totalMentors = mentors.length;
      const morningGap = totalMentors > 0 && morningPool.length === 0;
      const afternoonGap = totalMentors > 0 && afternoonPool.length === 0;
      const needsSuggestions = totalMentors === 0 || morningGap || afternoonGap;

      let suggestions = [];
      if (needsSuggestions) {
        const wantShifts = totalMentors === 0 ? ["Morning", "Afternoon"] : [morningGap ? "Morning" : null, afternoonGap ? "Afternoon" : null].filter(Boolean);
        const seen = {};
        wantShifts.forEach((sh) => {
          suggestMentorsForGap_(c.id, sh).forEach((s) => {
            const key = (s.name || "").trim().toLowerCase();
            if (key && !seen[key]) { seen[key] = true; suggestions.push(s); }
          });
        });
        suggestions = suggestions.sort((a, b) => b.score - a.score).slice(0, 5);
      }

      const interested = state.students.filter((s) => s.choices && String(s.choices).split(",").map((x) => x.trim()).indexOf(c.id) !== -1).length;

      return {
        cluster: c, mentors, totalMentors, backupMentors,
        morningOnly, afternoonOnly, eitherBoth, morningPool, afternoonPool,
        rotation: { form4: morningPool, g10a, g10b },
        morningGap, afternoonGap, needsSuggestions, suggestions, interested,
        capPerShift: cap,
        morningCountWithBackup, afternoonCountWithBackup,
        morningFull: morningCountWithBackup >= cap, afternoonFull: afternoonCountWithBackup >= cap,
        tierLabel: coverageTierLabel_(totalMentors), tierEmoji: coverageTierEmoji_(totalMentors),
      };
    });
  }

  function clusterMentorRowHtml_(m) {
    return `<div class="ccc-mentor-row">
      <div class="ccc-mentor-name">${esc(m.name)}${m.role && m.role !== "Mentor" ? ` <span class="ccc-mentor-role">${esc(m.role)}</span>` : ""}</div>
      <div class="ccc-mentor-meta">${esc(m.shifts || "Shift not set")}${m.mode ? " · " + esc(m.mode) : ""}</div>
      ${outreachButtonsHtml_(m)}
    </div>`;
  }

  function rotationColHtml_(label, list) {
    return `<div class="ccc-rot-col">
      <div class="ccc-rot-label">${esc(label)}</div>
      ${list.length ? list.map((m) => `<div class="ccc-rot-name">${esc(m.name)}</div>`).join("") : '<div class="ccc-rot-empty">No one proposed yet</div>'}
    </div>`;
  }

  // Always-visible fullness bar for one shift — "side by side, identifiable
  // with time slots, so it's easy to tell where it's full" per WG2's
  // request. Counts confirmed backup mentors too (see morningCountWithBackup/
  // afternoonCountWithBackup in computeClusterCommandData_), against the
  // Ops Settings mentor-capacity-per-shift figure.
  function capacityBarHtml_(label, count, cap) {
    const pct = cap ? Math.min(100, (count / cap) * 100) : 0;
    const cls = count >= cap ? "ccc-capbar-full" : pct >= 75 ? "ccc-capbar-high" : "ccc-capbar-ok";
    return `<div class="ccc-capbar-row">
      <div class="ccc-capbar-label">${esc(label)}</div>
      <div class="ccc-capbar-track"><div class="ccc-capbar-fill ${cls}" style="width:${pct.toFixed(0)}%;"></div></div>
      <div class="ccc-capbar-value">${count}/${cap}</div>
    </div>`;
  }

  // Backup/2nd-choice mentor row — shown whether or not a Lead has
  // confirmed them, with Confirm/Move actions (admin-only) so "pull a
  // backup mentor into this cluster" is a one-click action right here.
  function backupMentorRowHtml_(m, clusterId) {
    let actions = "";
    if (isAdmin()) {
      actions = m.confirmed
        ? `<div class="suggest-assign-row"><button type="button" class="btn ghost" style="padding:5px 9px;font-size:11px;" data-ccc-action="move" data-ccc-team-id="${escAttr(m.id)}" data-ccc-cluster="${escAttr(clusterId)}">Move here fully</button></div>`
        : `<div class="suggest-assign-row">
            <button type="button" class="btn ghost" style="padding:5px 9px;font-size:11px;" data-ccc-action="dual" data-ccc-team-id="${escAttr(m.id)}" data-ccc-cluster="${escAttr(clusterId)}">Confirm as backup here</button>
            <button type="button" class="btn ghost" style="padding:5px 9px;font-size:11px;" data-ccc-action="move" data-ccc-team-id="${escAttr(m.id)}" data-ccc-cluster="${escAttr(clusterId)}">Move here fully</button>
          </div>`;
    }
    return `<div class="ccc-mentor-row ccc-backup-row">
      <div class="ccc-mentor-name">${esc(m.name)} ${m.confirmed ? '<span class="flagpill flag-ok" style="font-size:9px;padding:2px 6px;">Confirmed backup</span>' : '<span class="flagpill flag-under" style="font-size:9px;padding:2px 6px;">2nd choice — unconfirmed</span>'}</div>
      <div class="ccc-mentor-meta">Primary cluster: ${esc(m.primaryCluster || "—")} · ${esc(m.shifts || "Shift not set")}</div>
      ${outreachButtonsHtml_(m)}
      ${actions}
    </div>`;
  }

  function clusterCommandCardHtml_(data) {
    const c = data.cluster;
    const expanded = !!state.clusterCommandExpanded[c.id];
    const summaryBits = [];
    if (data.morningOnly.length) summaryBits.push(data.morningOnly.length + " morning-only");
    if (data.afternoonOnly.length) summaryBits.push(data.afternoonOnly.length + " afternoon-only");
    if (data.eitherBoth.length) summaryBits.push(data.eitherBoth.length + " either/both");
    const summaryLine = summaryBits.length ? summaryBits.join(" · ") : "No shift preferences on file yet";

    let detailHtml = "";
    if (expanded) {
      const rosterHtml = data.mentors.length
        ? data.mentors.map(clusterMentorRowHtml_).join("")
        : '<div class="empty">No mentors assigned to this cluster yet.</div>';
      const backupHtml = data.backupMentors.length
        ? `<div class="ccc-backup-block">
            <div class="ccc-block-title" style="margin-top:10px;">Backup / 2nd-choice mentors (${data.backupMentors.length})</div>
            ${data.backupMentors.map((m) => backupMentorRowHtml_(m, c.id)).join("")}
          </div>`
        : "";
      const suggestHtml = data.needsSuggestions
        ? `<div class="ccc-suggest">
            <div class="ccc-block-title">Suggested mentors to recruit</div>
            ${data.suggestions.length ? data.suggestions.map((s) => suggestionRowHtml_(s, c.id)).join("") : '<div class="suggest-none">No obvious fit on file yet — try a general call for this cluster.</div>'}
            <button class="btn ghost" style="padding:6px 10px;font-size:11px;margin-top:6px;" data-recruit-cluster="${escAttr(c.id)}" data-recruit-name="${escAttr(c.name)}" data-recruit-shift="${escAttr(data.morningGap || data.totalMentors === 0 ? "Morning" : "Afternoon")}">+ Create recruitment task</button>
          </div>`
        : "";
      detailHtml = `
        <div class="ccc-detail">
          <div class="ccc-block-title">Full roster (${data.totalMentors})</div>
          ${rosterHtml}
          ${backupHtml}
          <div class="ccc-block-title" style="margin-top:10px;">Proposed rotation</div>
          <div class="ccc-rotation">
            ${rotationColHtml_("Form 4 (AM)", data.rotation.form4)}
            ${rotationColHtml_("Grade 10 A (PM)", data.rotation.g10a)}
            ${rotationColHtml_("Grade 10 B (PM)", data.rotation.g10b)}
          </div>
          ${suggestHtml}
        </div>`;
    }

    return `<div class="ccc-card${expanded ? " ccc-expanded" : ""}" data-ccc-toggle="${escAttr(c.id)}">
      <div class="ccc-card-head">
        <div class="ccc-card-titlewrap">
          <span class="ccc-zone-chip">${esc(c.zone || "?")}</span>
          <span class="ccc-card-title">${esc(c.id)} &middot; ${esc(c.name)}</span>
        </div>
        <span class="ccc-tier">${data.tierEmoji} ${esc(data.tierLabel)}</span>
      </div>
      <div class="ccc-capbars">
        ${capacityBarHtml_("Morning", data.morningCountWithBackup, data.capPerShift)}
        ${capacityBarHtml_("Afternoon", data.afternoonCountWithBackup, data.capPerShift)}
      </div>
      <div class="ccc-card-summary">
        <b>${data.totalMentors}</b> mentor${data.totalMentors === 1 ? "" : "s"} · ${esc(summaryLine)}
        ${data.backupMentors.length ? `<span class="flagpill flag-backuponly">+${data.backupMentors.length} backup</span>` : ""}
        ${data.morningGap ? '<span class="flagpill flag-nomentor">Morning gap</span>' : ""}
        ${data.afternoonGap ? '<span class="flagpill flag-nomentor">Afternoon gap</span>' : ""}
        ${data.morningFull ? '<span class="flagpill flag-ok">Morning full</span>' : ""}
        ${data.afternoonFull ? '<span class="flagpill flag-ok">Afternoon full</span>' : ""}
      </div>
      <div class="ccc-card-caret">${expanded ? "▲ Hide details" : "▼ Show mentors, rotation &amp; recruiting"}</div>
      ${detailHtml}
    </div>`;
  }

  function renderClusterCommandCenter_(containerId) {
    const el = $(containerId);
    if (!el) return;
    const data = computeClusterCommandData_();
    const zeroCount = data.filter((d) => d.totalMentors === 0).length;
    const gapCount = data.filter((d) => d.morningGap || d.afternoonGap).length;
    const strongCount = data.filter((d) => d.totalMentors >= 3).length;
    el.innerHTML = `
      <div class="ccc-summary">
        <div class="box"><div class="n">${zeroCount}</div><div class="l">No mentors yet</div></div>
        <div class="box"><div class="n">${gapCount}</div><div class="l">Shift gaps</div></div>
        <div class="box"><div class="n">${strongCount}</div><div class="l">Well covered (3+)</div></div>
      </div>
      <div class="ccc-grid">${data.map(clusterCommandCardHtml_).join("")}</div>
    `;
  }

  // Single-cluster version of the above — same card, same data, just one
  // cluster — used by the Cluster Lead/Sub-Lead My Day block so they get
  // their own cluster's roster/gaps/suggestions without the other 22 cards.
  function renderMyClusterCommand_(containerId, clusterId) {
    const el = $(containerId);
    if (!el) return;
    el.dataset.cccClusterId = clusterId; // read back on re-render after a toggle/action — see rerenderClusterCommand_
    const data = computeClusterCommandData_().find((d) => d.cluster.id === clusterId);
    el.innerHTML = data ? `<div class="ccc-grid">${clusterCommandCardHtml_(data)}</div>` : "";
  }

  // Single re-render entry point used after every toggle/action on a Cluster
  // Command Center card, whichever container it's in. The all-clusters grid
  // (Dashboard/Intern) and the single-cluster card (Cluster Lead My Day)
  // share the same click handlers, so this routes to the right renderer
  // instead of the single-cluster container being overwritten with all 23
  // cards on the next click.
  function rerenderClusterCommand_(containerId) {
    const el = $(containerId);
    const clusterId = el && el.dataset.cccClusterId;
    if (clusterId) renderMyClusterCommand_(containerId, clusterId);
    else renderClusterCommandCenter_(containerId);
  }

  // -----------------------------------------------------------------------
  // MENTORS & CLUSTERS HUB — Leads/Assistant Leads/Zone Coordinators only
  // (see hubTabBtn gating in renderAccessGatedUI). One consolidated place
  // for the "who's where" picture instead of piecing it together across
  // Dashboard/Team/Reports — a quick overview, an at-a-glance occupancy
  // grid, an Auto-Allocate suggest-then-confirm tool, and the full Cluster
  // Command Center detail. Every number here comes from clusterStats() and
  // computeClusterCommandData_(), which already back the Dashboard/My Day —
  // this is a new lens on existing, trusted data, not a new data model.
  // -----------------------------------------------------------------------
  function computeHubOverviewStats_() {
    const stats = clusterStats();
    const ccc = computeClusterCommandData_();
    const flagCounts = { ok: 0, backuponly: 0, nomentor: 0, over: 0, unused: 0, under: 0 };
    stats.forEach((s) => { flagCounts[s.flag] = (flagCounts[s.flag] || 0) + 1; });
    const totalMentors = ccc.reduce((sum, d) => sum + d.totalMentors, 0);
    const totalInterested = stats.reduce((sum, s) => sum + s.interested, 0);
    const zeroMentorCount = ccc.filter((d) => d.totalMentors === 0).length;
    const gapCount = ccc.filter((d) => d.morningGap || d.afternoonGap).length;
    const strongCount = ccc.filter((d) => d.totalMentors >= 3).length;
    const zoneIds = uniqueSorted(state.clusters.map((c) => c.zone)).sort();
    const zoneBreakdown = zoneIds.map((z) => {
      const zoneCcc = ccc.filter((d) => d.cluster.zone === z);
      return {
        zone: z,
        clusterCount: zoneCcc.length,
        zeroCount: zoneCcc.filter((d) => d.totalMentors === 0).length,
        gapCount: zoneCcc.filter((d) => d.morningGap || d.afternoonGap).length,
      };
    });
    return { flagCounts, totalMentors, totalInterested, zeroMentorCount, gapCount, strongCount, zoneBreakdown, clusterCount: stats.length };
  }

  function renderHubOverview_(containerId) {
    const el = $(containerId);
    if (!el) return;
    const s = computeHubOverviewStats_();
    const zoneRows = s.zoneBreakdown
      .map((z) => `<tr><td>Zone ${esc(z.zone)}</td><td>${z.clusterCount}</td><td>${z.zeroCount ? `<span class="flagpill flag-nomentor">${z.zeroCount} no mentor</span>` : "—"}</td><td>${z.gapCount ? `<span class="flagpill flag-under">${z.gapCount} shift gap${z.gapCount === 1 ? "" : "s"}</span>` : "—"}</td></tr>`)
      .join("");
    el.innerHTML = `
      <div class="summary">
        <div class="box"><div class="n">${s.clusterCount}</div><div class="l">Clusters</div></div>
        <div class="box"><div class="n">${s.totalMentors}</div><div class="l">Mentors placed</div></div>
        <div class="box"><div class="n">${s.totalInterested}</div><div class="l">Students interested</div></div>
      </div>
      <div class="summary">
        <div class="box"><div class="n">${s.zeroMentorCount}</div><div class="l">No mentor yet</div></div>
        <div class="box"><div class="n">${s.gapCount}</div><div class="l">Shift gaps</div></div>
        <div class="box"><div class="n">${s.strongCount}</div><div class="l">Well covered (3+)</div></div>
      </div>
      <table class="hub-zone-table">
        <thead><tr><th>Zone</th><th>Clusters</th><th>No mentor</th><th>Shift gaps</th></tr></thead>
        <tbody>${zoneRows}</tbody>
      </table>
    `;
  }

  // Compact heatmap — every cluster's Morning/Afternoon coverage in one
  // scannable grid. Read-only by design (no move/confirm buttons live
  // here); tapping a row jumps to and expands that cluster's full card in
  // the Cluster Command Center below, where the existing action buttons
  // already live (admin-gated exactly as they are today — see
  // clusterCommandCardHtml_/backupMentorRowHtml_/suggestionRowHtml_).
  function renderOccupancyGrid_(containerId) {
    const el = $(containerId);
    if (!el) return;
    const ccc = computeClusterCommandData_();
    const rows = ccc
      .map((d) => {
        const amCls = d.morningGap ? "occ-gap" : d.morningFull ? "occ-full" : "occ-ok";
        const pmCls = d.afternoonGap ? "occ-gap" : d.afternoonFull ? "occ-full" : "occ-ok";
        return `<tr data-occ-jump="${escAttr(d.cluster.id)}">
          <td class="occ-cluster"><span class="ccc-zone-chip">${esc(d.cluster.zone || "?")}</span> ${esc(d.cluster.id)} · ${esc(d.cluster.name)}</td>
          <td class="occ-cell ${amCls}">${d.morningCountWithBackup}/${d.capPerShift}</td>
          <td class="occ-cell ${pmCls}">${d.afternoonCountWithBackup}/${d.capPerShift}</td>
          <td class="occ-total">${d.totalMentors}</td>
        </tr>`;
      })
      .join("");
    el.innerHTML = `
      <table class="occupancy-grid">
        <thead><tr><th>Cluster</th><th>Morning</th><th>Afternoon</th><th>Mentors</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function handleOccupancyGridClick_(e) {
    const row = e.target.closest("[data-occ-jump]");
    if (!row) return;
    const clusterId = row.dataset.occJump;
    state.clusterCommandExpanded[clusterId] = true;
    renderClusterCommandCenter_("hubClusterCommand");
    const card = Array.from(document.querySelectorAll("[data-ccc-toggle]")).find((el) => el.dataset.cccToggle === clusterId);
    if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // ---- Auto-Allocate: "suggest, then confirm" (never books/emails on its
  // own) — proposes the single top-ranked candidate for every open
  // Morning/Afternoon gap, using the exact same suggestMentorsForGap_
  // ranking each cluster card already surfaces individually. Only "team"
  // (existing mentor, pulled in as a confirmed backup — the non-destructive
  // default, NOT a full move) and "application" (pending application,
  // approved straight into the gap cluster) candidates are proposable here,
  // since "database" candidates (past mentors with no live record) have
  // nothing to action directly — see suggestMentorsForGap_'s sourceType.
  function computeAutoAllocateProposals_() {
    const ccc = computeClusterCommandData_();
    const proposals = [];
    ccc.forEach((d) => {
      const shifts = [];
      if (d.totalMentors === 0 || d.morningGap) shifts.push("Morning");
      if (d.totalMentors === 0 || d.afternoonGap) shifts.push("Afternoon");
      shifts.forEach((shift) => {
        const candidate = suggestMentorsForGap_(d.cluster.id, shift).find((c) => c.sourceType === "team" || c.sourceType === "application");
        if (candidate) {
          proposals.push({
            clusterId: d.cluster.id, clusterName: d.cluster.name, shift, candidate,
            action: candidate.sourceType === "application" ? "approve" : "dual",
          });
        }
      });
    });
    return proposals;
  }

  function renderAutoAllocatePanel_(containerId) {
    const el = $(containerId);
    if (!el) return;
    el.innerHTML = `
      <p class="hint">Proposes one candidate per open shift gap, ranked the same way as each cluster's own "Suggested mentors to recruit" list. Nothing is booked or emailed until you review and confirm below.</p>
      <button type="button" class="btn ghost" id="hubProposeBtn">Propose allocations for every gap</button>
      <div id="hubProposalsList"></div>
    `;
    $("hubProposeBtn").addEventListener("click", () => renderAutoAllocateProposals_("hubProposalsList"));
  }

  function renderAutoAllocateProposals_(listId) {
    const el = $(listId);
    if (!el) return;
    const proposals = computeAutoAllocateProposals_();
    if (!proposals.length) {
      el.innerHTML = '<div class="empty" style="margin-top:8px;">No open gaps with an actionable candidate right now.</div>';
      return;
    }
    el.dataset.aaProposals = JSON.stringify(proposals);
    el.innerHTML = `
      <div class="aa-list">
        ${proposals
          .map(
            (p, i) => `
          <label class="aa-row">
            <input type="checkbox" checked data-aa-index="${i}">
            <span class="aa-text"><b>${esc(p.candidate.name)}</b> → ${esc(p.clusterId)} · ${esc(p.clusterName)} (${esc(p.shift)}${p.action === "approve" ? " — approve pending application" : " — confirm as backup mentor"})</span>
            ${p.candidate.reason ? `<span class="aa-reason">${esc(p.candidate.reason)}</span>` : ""}
          </label>`
          )
          .join("")}
      </div>
      ${isAdmin() ? '<button type="button" class="btn primary" id="hubConfirmSelectedBtn" style="margin-top:8px;">Confirm selected</button>' : '<p class="hint">Only a Lead/Assistant Lead can confirm these — a Zone Coordinator can review and flag them in the meantime.</p>'}
    `;
    if (isAdmin()) $("hubConfirmSelectedBtn").addEventListener("click", () => handleAutoAllocateConfirm_(listId));
  }

  function handleAutoAllocateConfirm_(listId) {
    const el = $(listId);
    if (!el) return;
    let proposals = [];
    try { proposals = JSON.parse(el.dataset.aaProposals || "[]"); } catch (e) { proposals = []; }
    const checked = Array.from(el.querySelectorAll("[data-aa-index]"))
      .filter((cb) => cb.checked)
      .map((cb) => proposals[Number(cb.dataset.aaIndex)])
      .filter(Boolean);
    if (!checked.length) return;
    if (!confirm(`Confirm ${checked.length} allocation${checked.length === 1 ? "" : "s"}? Each mentor/applicant will be emailed to let them know.`)) return;
    const btn = $("hubConfirmSelectedBtn");
    if (btn) btn.disabled = true;
    const requests = checked.map((p) =>
      p.action === "approve"
        ? apiPost({ action: "approve_mentor_application", id: p.candidate.sourceId, cluster: p.clusterId })
        : apiPost({ action: "reassign_mentor_cluster", id: p.candidate.sourceId, clusterId: p.clusterId, mode: "dual" })
    );
    Promise.all(requests).then((results) => {
      const failed = results.filter((r) => !r.ok && !r.queued).length;
      alert(failed ? `${failed} of ${results.length} couldn't be completed — check Mentor Applications / Team for details.` : `${results.length} allocation${results.length === 1 ? "" : "s"} confirmed.`);
      refresh(false).then(() => renderHubTab_());
    });
  }

  function renderHubTab_() {
    if (!$("hubOverview")) return;
    renderHubOverview_("hubOverview");
    renderOccupancyGrid_("hubOccupancyGrid");
    renderAutoAllocatePanel_("hubAutoAllocate");
    renderClusterCommandCenter_("hubClusterCommand");
  }

  // Dispatches the admin-only mentor-placement actions surfaced on Cluster
  // Command Center cards: "dual"/"move" hit reassign_mentor_cluster_ (pull a
  // backup mentor in, or move someone here fully — either from the backup
  // list or from a "suggested mentor" who's already on the Team roster
  // elsewhere); "approve" approves a pending mentor application directly
  // into this cluster (bypassing the auto 2nd-choice fallback) via the
  // existing approve_mentor_application action's body.cluster override.
  function handleClusterCommandAction_(e, containerId) {
    const btn = e.target.closest("[data-ccc-action]");
    if (!btn) return false;
    e.stopPropagation();
    const action = btn.dataset.cccAction;
    const clusterId = btn.dataset.cccCluster;
    if (action === "dual" || action === "move") {
      const teamId = btn.dataset.cccTeamId;
      const msg = action === "dual"
        ? `Confirm this mentor as a backup/dual mentor for ${clusterId}? They'll keep their current primary cluster too, and be emailed to let them know.`
        : `Move this mentor fully to ${clusterId}? This replaces their current cluster, and they'll be emailed to let them know.`;
      if (!confirm(msg)) return true;
      btn.disabled = true;
      apiPost({ action: "reassign_mentor_cluster", id: teamId, clusterId, mode: action }).then((res) => {
        if (!res.ok && !res.queued) { alert(res.error || "Couldn't complete this action."); btn.disabled = false; return; }
        refresh(false).then(() => rerenderClusterCommand_(containerId));
      });
    } else if (action === "approve") {
      const appId = btn.dataset.cccAppId;
      if (!confirm(`Approve this pending application directly into ${clusterId}? They'll be emailed their PIN and cluster assignment.`)) return true;
      btn.disabled = true;
      apiPost({ action: "approve_mentor_application", id: appId, cluster: clusterId }).then((res) => {
        if (!res.ok && !res.queued) { alert(res.error || "Couldn't approve this application."); btn.disabled = false; return; }
        refresh(false).then(() => rerenderClusterCommand_(containerId));
      });
    }
    return true;
  }

  function handleClusterCommandClick_(e, containerId) {
    const recruitBtn = e.target.closest("[data-recruit-cluster]");
    if (recruitBtn) {
      // internClusterCommand sits inside #myDayPanel, which already has its
      // own delegated listener for the same [data-recruit-cluster] buttons
      // (the Session Coverage "gap" cards) — stop the bubble here so an
      // Intern's click doesn't fire both handlers and prefill the modal twice.
      e.stopPropagation();
      openRecruitTaskModal_(recruitBtn.dataset.recruitCluster, recruitBtn.dataset.recruitName, recruitBtn.dataset.recruitShift);
      return;
    }
    if (handleClusterCommandAction_(e, containerId)) return;
    const card = e.target.closest("[data-ccc-toggle]");
    if (!card) return;
    state.clusterCommandExpanded[card.dataset.cccToggle] = !state.clusterCommandExpanded[card.dataset.cccToggle];
    rerenderClusterCommand_(containerId);
  }

  function renderSessionCoverage_() {
    if (!$("sessionCoverageTable")) return;
    const coverage = computeShiftCoverage_();
    const gapsOnly = coverage.filter((c) => c.morningGap || c.afternoonGap);
    const morningGapCount = coverage.filter((c) => c.morningGap).length;
    const afternoonGapCount = coverage.filter((c) => c.afternoonGap).length;
    $("sessionCoverageSummary").innerHTML = `
      <div class="box"><div class="n">${morningGapCount}</div><div class="l">Morning gaps</div></div>
      <div class="box"><div class="n">${afternoonGapCount}</div><div class="l">Afternoon gaps</div></div>
      <div class="box"><div class="n">${coverage.length - gapsOnly.length}</div><div class="l">Fully covered</div></div>
    `;
    if (!gapsOnly.length) {
      $("sessionCoverageTable").innerHTML = '<div class="empty">No shift-specific gaps — every cluster with a mentor has at least one for each shift it needs.</div>';
      return;
    }
    $("sessionCoverageTable").innerHTML =
      gapsOnly.map(coverageGapCardHtml_).join("") +
      '<p class="hint">Only shows clusters that have some mentor coverage but a hole in one shift. A cluster with zero mentors at all shows up under Capacity &amp; Coverage above instead. Suggested names are keyword/profession matches or people who named this cluster on an application or in the Mentor Database — always ask, never assume.</p>';
  }

  function handleSessionCoverageClick_(e) {
    const btn = e.target.closest("[data-recruit-cluster]");
    if (!btn) return;
    openRecruitTaskModal_(btn.dataset.recruitCluster, btn.dataset.recruitName, btn.dataset.recruitShift);
  }

  // ---------------------------------------------------------------------
  // NEEDS ATTENTION — a single, prioritized "what needs a decision or a
  // nudge right now" feed for Leads/Assistant Leads/Zone Coordinators,
  // built entirely from data already loaded client-side (no new sheet, no
  // new API call). Each flag knows how to jump the person straight to the
  // relevant place (go()) so this is a worklist, not just a warning label.
  // ---------------------------------------------------------------------
  function todayMidnight_() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // Tasks store due dates as strings like "06-Aug-26" or "07-Aug-26 onward"
  // (see TASKS_HEADERS / the Tasks sheet) — not reliably parseable via
  // `new Date(str)` across engines, so this parses the DD-MMM-YY prefix by
  // hand and ignores anything after it. Non-date values ("This week") or
  // blanks return null and are simply excluded from date-based flags.
  const MONTH_ABBR_ = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  function parseDueDate_(due) {
    const m = String(due || "").trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})/);
    if (!m) return null;
    const month = MONTH_ABBR_[m[2][0].toUpperCase() + m[2].slice(1, 3).toLowerCase()];
    if (month === undefined) return null;
    const day = parseInt(m[1], 10);
    const year = 2000 + parseInt(m[3], 10);
    const d = new Date(year, month, day);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function scrollToDash_(id) {
    setTimeout(() => {
      const el = $(id);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
  }

  function computeAttentionFlags_() {
    const flags = [];
    const today = todayMidnight_();
    const now = new Date();

    const overdueTasks = state.tasks.filter((t) => t.state !== "Done" && (function () { const d = parseDueDate_(t.due); return d && d < today; })());
    if (overdueTasks.length) {
      flags.push({
        severity: "high",
        text: overdueTasks.length + " task" + (overdueTasks.length === 1 ? "" : "s") + " overdue",
        detail: overdueTasks.slice(0, 3).map((t) => t.task).join(" · ") + (overdueTasks.length > 3 ? "…" : ""),
        go: () => setTab("tasks"),
      });
    }

    const dueTodayTasks = state.tasks.filter((t) => t.state !== "Done" && (function () { const d = parseDueDate_(t.due); return d && d.getTime() === today.getTime(); })());
    if (dueTodayTasks.length) {
      flags.push({
        severity: "medium",
        text: dueTodayTasks.length + " task" + (dueTodayTasks.length === 1 ? "" : "s") + " due today",
        detail: dueTodayTasks.slice(0, 3).map((t) => t.task).join(" · ") + (dueTodayTasks.length > 3 ? "…" : ""),
        go: () => setTab("tasks"),
      });
    }

    const unconfirmed = state.team.filter((t) => t.status !== "Confirmed" && t.status !== "Deleted");
    if (unconfirmed.length) {
      flags.push({
        severity: unconfirmed.length >= 6 ? "high" : "medium",
        text: unconfirmed.length + " team member" + (unconfirmed.length === 1 ? "" : "s") + " unconfirmed",
        detail: unconfirmed.slice(0, 4).map((t) => t.name).join(", ") + (unconfirmed.length > 4 ? "…" : ""),
        go: () => setTab("team"),
      });
    }

    const zonesNoCoord = ["A", "B", "C", "D", "E"].filter((z) => !state.team.some((t) => t.role === "Zone Coordinator" && t.status !== "Deleted" && zoneLetterOfClient(t.zone) === z));
    if (zonesNoCoord.length) {
      flags.push({
        severity: "high",
        text: "Zone" + (zonesNoCoord.length === 1 ? "" : "s") + " " + zonesNoCoord.join(", ") + " " + (zonesNoCoord.length === 1 ? "has" : "have") + " no Zone Coordinator",
        detail: "Assign one via Team Access.",
        go: () => setTab("dashboard"),
      });
    }

    const stats = clusterStats();
    const noMentor = stats.filter((s) => s.flag === "nomentor" && s.interested > 0);
    if (noMentor.length) {
      flags.push({
        severity: "high",
        text: noMentor.length + " cluster" + (noMentor.length === 1 ? "" : "s") + " with student interest but no mentor",
        detail: noMentor.slice(0, 4).map((s) => s.cluster.id).join(", ") + (noMentor.length > 4 ? "…" : ""),
        go: () => { setTab("dashboard"); setCapacityFilter("nomentor"); scrollToDash_("dashCapacityTable"); },
      });
    }
    const over = stats.filter((s) => s.flag === "over");
    if (over.length) {
      flags.push({
        severity: "medium",
        text: over.length + " cluster" + (over.length === 1 ? "" : "s") + " oversubscribed",
        detail: over.slice(0, 4).map((s) => s.cluster.id).join(", ") + (over.length > 4 ? "…" : ""),
        go: () => { setTab("dashboard"); setCapacityFilter("over"); scrollToDash_("dashCapacityTable"); },
      });
    }

    const coverage = computeShiftCoverage_();
    const morningGaps = coverage.filter((c) => c.morningGap);
    if (morningGaps.length) {
      flags.push({
        severity: "medium",
        text: morningGaps.length + " cluster" + (morningGaps.length === 1 ? "" : "s") + " with no Morning-shift mentor (Form 4 window)",
        detail: morningGaps.slice(0, 4).map((c) => c.cluster.id).join(", ") + (morningGaps.length > 4 ? "…" : ""),
        go: () => { setTab("dashboard"); scrollToDash_("sessionCoverageTable"); },
      });
    }
    const afternoonGaps = coverage.filter((c) => c.afternoonGap);
    if (afternoonGaps.length) {
      flags.push({
        severity: "medium",
        text: afternoonGaps.length + " cluster" + (afternoonGaps.length === 1 ? "" : "s") + " with no Afternoon-shift mentor (Grade 10 windows)",
        detail: afternoonGaps.slice(0, 4).map((c) => c.cluster.id).join(", ") + (afternoonGaps.length > 4 ? "…" : ""),
        go: () => { setTab("dashboard"); scrollToDash_("sessionCoverageTable"); },
      });
    }

    if (now >= REG_OPEN && now <= REG_CLOSE) {
      const total = state.students.length;
      const target = Object.values(COHORT_TARGETS).reduce((a, b) => a + b, 0);
      const daysElapsed = Math.max(1, (now - REG_OPEN) / 86400000);
      const daysRemaining = Math.max(0, (REG_CLOSE - now) / 86400000);
      const dailyRate = total / daysElapsed;
      const projected = Math.min(target, total + dailyRate * daysRemaining);
      const projectedPct = target ? (projected / target) * 100 : 100;
      if (projectedPct < 85) {
        flags.push({
          severity: projectedPct < 60 ? "high" : "medium",
          text: "Registration pace projects ~" + projectedPct.toFixed(0) + "% by the 20 Aug close",
          detail: total + " registered so far · " + daysRemaining.toFixed(0) + " day(s) left",
          go: () => { setTab("dashboard"); scrollToDash_("dashProjection"); },
        });
      }
    }

    const classTeachers = state.team.filter((t) => t.role === "Class Teacher" && t.status !== "Deleted" && t.classStream);
    const emptyClasses = classTeachers.filter((t) => !state.students.some((s) => s.classStream === t.classStream));
    if (emptyClasses.length && now >= REG_OPEN) {
      flags.push({
        severity: "medium",
        text: emptyClasses.length + " class" + (emptyClasses.length === 1 ? "" : "es") + " with a teacher but zero registrations",
        detail: emptyClasses.slice(0, 4).map((t) => t.classStream).join(", ") + (emptyClasses.length > 4 ? "…" : ""),
        go: () => { setTab("dashboard"); scrollToDash_("dashRegProgress"); },
      });
    }

    // Event-day mentor coverage — only surfaced from 2 days out so this
    // doesn't nag for months about mentors who simply haven't checked in
    // yet for an event that hasn't happened.
    const EVENT_DAY = new Date("2026-08-29T00:00:00");
    const daysToEvent = (EVENT_DAY - now) / 86400000;
    if (daysToEvent <= 2 && daysToEvent >= -1) {
      const mentorGaps = state.team.filter((t) => t.role === "Mentor" && t.status !== "Deleted" && mentorOpsStatus_(t).flag === "nomentor");
      if (mentorGaps.length) {
        flags.push({
          severity: "high",
          text: mentorGaps.length + " mentor" + (mentorGaps.length === 1 ? "" : "s") + " not checked in / no link yet",
          detail: "Event-day coverage — see Mentor Status Board.",
          go: () => { setTab("dashboard"); scrollToDash_("mentorOpsSection"); },
        });
      }
    }

    const order = { high: 0, medium: 1, low: 2 };
    return flags.sort((a, b) => order[a.severity] - order[b.severity]);
  }

  function handleAttentionClick(e) {
    const card = e.target.closest("[data-attn-idx]");
    if (!card) return;
    const flags = state._attnFlags || [];
    const flag = flags[parseInt(card.dataset.attnIdx, 10)];
    if (flag && flag.go) flag.go();
  }

  function renderAttentionPanel_() {
    const el = $("attentionPanel");
    if (!el) return;
    const flags = computeAttentionFlags_();
    state._attnFlags = flags;
    if (!flags.length) {
      el.innerHTML = '<div class="attn-card attn-ok">Nothing needs attention right now — everything\'s on track.</div>';
      return;
    }
    el.innerHTML = flags
      .map(
        (f, i) => `
      <div class="attn-card attn-${f.severity}" data-attn-idx="${i}">
        <div class="attn-text">${esc(f.text)}</div>
        ${f.detail ? `<div class="attn-detail">${esc(f.detail)}</div>` : ""}
      </div>`
      )
      .join("");
  }

  // ---------------------------------------------------------------------
  // LIGHTWEIGHT SVG CHARTS — plain inline SVG, no external chart library,
  // so the offline PWA shell stays fully self-contained (same reasoning as
  // the inline icon SVGs used elsewhere in this file). Enough for an
  // at-a-glance executive view: a donut for part-to-whole breakdowns and
  // horizontal bars for a ranked list. Colors are pulled from the same
  // CSS custom properties as the rest of the UI (var(--red-dark) etc.)
  // since this markup is injected into the live document and inherits
  // :root — keeps charts visually consistent with the KPI tiles/bars.
  // ---------------------------------------------------------------------
  function svgDonut_(segments, opts) {
    opts = opts || {};
    const size = opts.size || 120;
    const stroke = opts.stroke || 16;
    const r = (size - stroke) / 2;
    const c = size / 2;
    const circumference = 2 * Math.PI * r;
    const total = segments.reduce((a, s) => a + s.value, 0);
    let offset = 0;
    const arcs = total > 0
      ? segments
          .filter((s) => s.value > 0)
          .map((s) => {
            const dash = (s.value / total) * circumference;
            const circle = `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${stroke}" stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${c} ${c})"></circle>`;
            offset += dash;
            return circle;
          })
          .join("")
      : "";
    const centerBig = opts.centerText !== undefined ? esc(String(opts.centerText)) : "";
    const centerSmall = opts.centerSub ? esc(opts.centerSub) : "";
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" class="donut-svg">
      <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="var(--grey-light)" stroke-width="${stroke}"></circle>
      ${arcs}
      <text x="${c}" y="${c - 2}" text-anchor="middle" class="donut-center-n">${centerBig}</text>
      ${centerSmall ? `<text x="${c}" y="${c + 15}" text-anchor="middle" class="donut-center-l">${centerSmall}</text>` : ""}
    </svg>`;
  }

  function donutLegendHtml_(segments) {
    return `<div class="donut-legend">${segments
      .map((s) => `<div class="donut-legend-row"><span class="donut-swatch" style="background:${s.color};"></span>${esc(s.label)} <b>${s.value}</b></div>`)
      .join("")}</div>`;
  }

  function svgHBars_(rows) {
    const max = Math.max(1, ...rows.map((r) => r.value));
    return `<div class="chart-hbars">${rows
      .map(
        (r) => `
      <div class="chart-hbar-row">
        <div class="chart-hbar-label">${esc(r.label)}</div>
        <div class="chart-hbar-track"><div class="chart-hbar-fill" style="width:${((r.value / max) * 100).toFixed(1)}%;background:${r.color || "var(--red-dark)"};"></div></div>
        <div class="chart-hbar-value">${r.value}</div>
      </div>`
      )
      .join("")}</div>`;
  }

  function renderDashCharts_() {
    const chartsEl = $("dashCharts");
    if (!chartsEl) return;

    const cohortSegs = Object.keys(COHORT_TARGETS).map((coh) => ({
      label: COHORT_LABELS[coh] || coh,
      value: state.students.filter((s) => s.cohort === coh).length,
      color: coh === "F4" ? "var(--red-dark)" : coh === "G10A" ? "var(--amber)" : "var(--green)",
    }));

    const confirmedCount = state.team.filter((t) => t.status === "Confirmed").length;
    const activeTeam = state.team.filter((t) => t.status !== "Deleted");
    const teamSegs = [
      { label: "Confirmed", value: confirmedCount, color: "var(--green)" },
      { label: "Unconfirmed", value: activeTeam.length - confirmedCount, color: "var(--amber)" },
    ];

    const doneCount = state.tasks.filter((t) => t.state === "Done").length;
    const progCount = state.tasks.filter((t) => t.state === "In Progress").length;
    const pendCount = Math.max(0, state.tasks.length - doneCount - progCount);
    const taskSegs = [
      { label: "Done", value: doneCount, color: "var(--green)" },
      { label: "In Progress", value: progCount, color: "var(--amber)" },
      { label: "Pending", value: pendCount, color: "var(--grey)" },
    ];

    chartsEl.innerHTML = `
      <div class="chart-card">
        <div class="chart-title">Registration by Cohort</div>
        <div class="chart-body">
          ${svgDonut_(cohortSegs, { centerText: state.students.length, centerSub: "students" })}
          ${donutLegendHtml_(cohortSegs)}
        </div>
      </div>
      <div class="chart-card">
        <div class="chart-title">Team Confirmation</div>
        <div class="chart-body">
          ${svgDonut_(teamSegs, { centerText: activeTeam.length, centerSub: "team" })}
          ${donutLegendHtml_(teamSegs)}
        </div>
      </div>
      <div class="chart-card">
        <div class="chart-title">Task Status</div>
        <div class="chart-body">
          ${svgDonut_(taskSegs, { centerText: state.tasks.length, centerSub: "tasks" })}
          ${donutLegendHtml_(taskSegs)}
        </div>
      </div>
      <div class="chart-card chart-card--wide">
        <div class="chart-title">Team by Zone</div>
        ${svgHBars_(["A", "B", "C", "D", "E"].map((z) => ({ label: "Zone " + z, value: activeTeam.filter((t) => zoneLetterOfClient(t.zone) === z).length })))}
      </div>
    `;
  }

  // ---------------------------------------------------------------------
  // MY DAY — the non-leadership counterpart to the executive Dashboard.
  // Interns, Class Teachers, and Mentors/Cluster-tier team members don't
  // need (or, per WG2's request, shouldn't default to seeing) the full
  // org-wide numbers — they need "what do I personally need to do, and by
  // when." Reuses the same data already loaded client-side; no new API.
  // ---------------------------------------------------------------------
  function renderMyDayPanel_() {
    const el = $("myDayPanel");
    if (!el || !state.session) return;
    const level = accessLevel();
    const me = state.team.find((t) => t.id === state.session.memberId);
    const myName = state.session.name || (me && me.name) || "there";
    const firstName = myName.split(" ")[0];
    const today = todayMidnight_();

    const myTasks = state.tasks.filter((t) => t.state !== "Done" && (t.owner || "").toLowerCase().indexOf(myName.toLowerCase()) !== -1);
    const overdueMine = myTasks.filter((t) => { const d = parseDueDate_(t.due); return d && d < today; });
    const dueTodayMine = myTasks.filter((t) => { const d = parseDueDate_(t.due); return d && d.getTime() === today.getTime(); });

    let roleBlockHtml = "";
    if (level === "class") {
      const myClass = me ? String(me.classStream || "").trim() : "";
      const myStudents = myClass ? state.students.filter((s) => s.classStream === myClass) : [];
      const noChoices = myStudents.filter((s) => !s.choices).length;
      const notAllocated = myStudents.filter((s) => !(s.round1 && s.round2 && s.round3)).length;
      roleBlockHtml = `
        <div class="myday-block">
          <div class="myday-block-title">Your class${myClass ? " — " + esc(myClass) : ""}</div>
          <div class="summary">
            <div class="box"><div class="n">${myStudents.length}</div><div class="l">Registered</div></div>
            <div class="box"><div class="n">${noChoices}</div><div class="l">No choices yet</div></div>
            <div class="box"><div class="n">${notAllocated}</div><div class="l">Not fully allocated</div></div>
          </div>
        </div>`;
    } else if (me && me.role === "Mentor") {
      const status = mentorOpsStatus_(me);
      roleBlockHtml = `
        <div class="myday-block">
          <div class="myday-block-title">Your mentor status</div>
          <span class="flagpill flag-${status.flag}" style="font-size:12px;padding:6px 12px;">${esc(status.label)}</span>
          ${me.cluster ? `<div class="myday-sub">${esc(me.cluster)}</div>` : ""}
          ${teamMemberCluster(me) ? `<button type="button" class="btn ghost" data-jump-guide style="width:100%;margin-top:10px;font-size:12px;">🎤 Your Session Guide →</button>` : ""}
        </div>`;
    } else if (me && (me.role === "Cluster Lead" || me.role === "Sub-Lead")) {
      // Cluster Leads/Sub-Leads previously fell through to nothing here —
      // no branch matched (level is "cluster", role isn't "Mentor"), so
      // they only ever saw the generic task list. This reuses the exact
      // same Cluster Command Center card the exec Dashboard and Intern My
      // Day already render (computeClusterCommandData_ / clusterCommandCardHtml_),
      // scoped to just their own cluster via teamMemberCluster(me), so it's
      // the same trusted data with zero new logic. Action buttons on the
      // card stay admin-gated (isAdmin() inside backupMentorRowHtml_/
      // suggestionRowHtml_), so a Cluster Lead sees their roster, coverage
      // gaps and recruiting suggestions but can't move/confirm mentors
      // directly — matching the "grid access: Leads & Zone Coordinators
      // only" decision without opening any new permission surface.
      const myCluster = teamMemberCluster(me);
      if (!myCluster) {
        roleBlockHtml = `
          <div class="myday-block">
            <div class="myday-block-title">Your cluster</div>
            <div class="empty">No cluster is on file for you yet — ask a Zone Coordinator to add it in the Team tab.</div>
          </div>`;
      } else {
        if (state.clusterCommandExpanded[myCluster.id] === undefined) state.clusterCommandExpanded[myCluster.id] = true;
        roleBlockHtml = `
          <div class="myday-block">
            <div class="myday-block-title">${esc(myCluster.id)} · ${esc(myCluster.name)} — your action points</div>
            <div id="clusterLeadCommand"></div>
          </div>`;
      }
    } else if (level === "intern") {
      // Interns are the ones who action recruitment gaps — see WG2's
      // request to surface this "clearly... for actioning by interns."
      // Same computeShiftCoverage_() data the Leads' Dashboard uses, and the
      // same coverageGapCardHtml_() card (with suggested mentors to ask)
      // so Leads and Interns see identical information, just in different
      // places.
      const gaps = computeShiftCoverage_().filter((c) => c.morningGap || c.afternoonGap);
      const gapCards = gaps.length ? gaps.map(coverageGapCardHtml_).join("") : '<div class="empty">No shift-coverage gaps right now.</div>';
      roleBlockHtml = `
        <div class="myday-block">
          <div class="myday-block-title">Sessions that need filling</div>
          ${gapCards}
        </div>`;
    }

    const sortedTasks = myTasks.slice().sort((a, b) => { const da = parseDueDate_(a.due); const db = parseDueDate_(b.due); if (!da && !db) return 0; if (!da) return 1; if (!db) return -1; return da - db; });
    const taskListHtml = sortedTasks.length
      ? sortedTasks
          .map((t) => {
            const cls = overdueMine.indexOf(t) !== -1 ? "flag-over" : dueTodayMine.indexOf(t) !== -1 ? "flag-under" : "flag-ok";
            return `<div class="myday-task"><span class="myday-task-dot ${cls}"></span><span class="myday-task-text">${esc(t.task)}</span><span class="myday-task-due">${esc(t.due || "")}</span></div>`;
          })
          .join("")
      : '<div class="empty">No open tasks assigned to you right now.</div>';

    // Self-service "raise your hand" for a leadership role — open to
    // Mentors and already-promoted Cluster Leads/Sub-Leads (e.g. a Cluster
    // Lead who'd now like to be considered for Zone Coordinator). Zone
    // Coordinators/Leads/Assistant Leads don't see the exec Dashboard at
    // all here (they're already past this), and Class Teachers/Interns
    // aren't part of the mentor cluster ladder, so this only shows for
    // ROOM_MENTOR_ROLES. See leadershipInterestBlockHtml_.
    const leadershipBlockHtml = me && ROOM_MENTOR_ROLES.indexOf(me.role) !== -1 ? leadershipInterestBlockHtml_(me) : "";

    const myRoleForBanner = (me && me.role) || (state.session && state.session.role) || "";
    el.innerHTML = `
      <div class="myday-greeting">Hi ${esc(firstName)} — here's what's on your plate.</div>
      ${roleGuideBannerHtml_(myRoleForBanner)}
      ${overdueMine.length ? `<div class="attn-card attn-high">${overdueMine.length} of your task${overdueMine.length === 1 ? " is" : "s are"} overdue</div>` : ""}
      ${dueTodayMine.length ? `<div class="attn-card attn-medium">${dueTodayMine.length} task${dueTodayMine.length === 1 ? "" : "s"} due today</div>` : ""}
      ${roleBlockHtml}
      <div class="myday-block">
        <div class="myday-block-title">Your open tasks</div>
        ${taskListHtml}
      </div>
      ${leadershipBlockHtml}
      ${level === "intern" ? `
      <div class="myday-block">
        <div class="myday-block-title">Cluster Command Center — all 23 clusters</div>
        <p class="hint">Mentor count, shift breakdown, a proposed AM/PM rotation, and who to recruit — per cluster. Tap a card to expand.</p>
        <div id="internClusterCommand"></div>
      </div>` : ""}
    `;
    if (level === "intern") renderClusterCommandCenter_("internClusterCommand");
    if ($("clusterLeadCommand") && me && (me.role === "Cluster Lead" || me.role === "Sub-Lead")) {
      const myCluster = teamMemberCluster(me);
      if (myCluster) renderMyClusterCommand_("clusterLeadCommand", myCluster.id);
    }
  }

  // ---------------------------------------------------------------------
  // LEADERSHIP INTEREST — self-service half of the "information bank" of
  // who'd like to lead a cluster or zone (the other half is the existing
  // public application form's "additional role" checkboxes, carried over
  // automatically on admission — see approveMentorApplication_/
  // canonicalLeadershipRole_ in Code.gs). Both land in the same
  // leadershipStatus="Pending" state on the person's Team row, so Leads
  // review one single queue (see renderLeadershipCandidates_) regardless
  // of where the interest came from.
  // ---------------------------------------------------------------------
  const LEADERSHIP_ROLE_OPTIONS_ = ["Cluster Lead", "Sub-Lead", "Zone Coordinator"];

  function leadershipInterestBlockHtml_(me) {
    const status = me.leadershipStatus || "";
    const interest = me.leadershipInterest || "";
    if (status === "Pending") {
      return `
        <div class="myday-block">
          <div class="myday-block-title">Leadership interest</div>
          <p class="hint" style="margin:0 0 8px 0;">Your request for <b>${esc(interest)}</b> is with the Leads for review — you'll hear back by email once it's actioned.</p>
          <button class="btn ghost" data-withdraw-leadership style="font-size:11.5px;padding:6px 10px;">Withdraw request</button>
          <div class="myday-result" data-leadership-result></div>
        </div>`;
    }
    if (status === "Approved") {
      return `
        <div class="myday-block">
          <div class="myday-block-title">Leadership interest</div>
          <p class="hint" style="margin:0;">You're approved as <b>${esc(me.role)}</b> — thank you for stepping up! 🎉</p>
        </div>`;
    }
    const declinedNote = status === "Declined"
      ? '<p class="hint" style="margin:0 0 8px 0;">Your earlier request wasn\'t approved this time — you\'re welcome to raise it again if things change.</p>'
      : "";
    return `
      <div class="myday-block">
        <div class="myday-block-title">Interested in a leadership role?</div>
        ${declinedNote}
        <p class="hint" style="margin:0 0 8px 0;">Cluster Lead and Sub-Lead coordinate mentors within one cluster; Zone Coordinator oversees a whole zone. Tick what you'd consider and let a Lead know.</p>
        <div class="pubreg-check-group" id="mydayLeadershipRoles">
          ${LEADERSHIP_ROLE_OPTIONS_.map((r) => `<label class="pubreg-check-row"><input type="checkbox" name="mydayLeadRole" value="${escAttr(r)}"> ${esc(r)}</label>`).join("")}
        </div>
        <button class="btn primary" data-submit-leadership style="font-size:11.5px;padding:7px 12px;margin-top:8px;">Submit interest</button>
        <div class="myday-result" data-leadership-result></div>
      </div>`;
  }

  function handleMyDayLeadershipClick_(e) {
    if (e.target.closest("[data-jump-guide]")) { jumpToMyGuideCluster_(); return; }
    const submitBtn = e.target.closest("[data-submit-leadership]");
    const withdrawBtn = e.target.closest("[data-withdraw-leadership]");
    if (!submitBtn && !withdrawBtn) return;
    const btn = submitBtn || withdrawBtn;
    const resultEl = btn.closest(".myday-block").querySelector("[data-leadership-result]");
    const roles = submitBtn ? checkedValues_("mydayLeadRole") : [];
    if (submitBtn && !roles.length) {
      if (resultEl) { resultEl.textContent = "Pick at least one role first."; resultEl.style.color = "var(--red)"; }
      return;
    }
    btn.disabled = true;
    apiPost({ action: "request_leadership_role", roles })
      .then((res) => {
        btn.disabled = false;
        if (!res || (!res.ok && !res.queued)) {
          if (resultEl) { resultEl.textContent = (res && res.error) || "Couldn't save — please try again."; resultEl.style.color = "var(--red)"; }
          return;
        }
        const me = state.team.find((t) => t.id === state.session.memberId);
        if (me) {
          me.leadershipInterest = res.leadershipInterest !== undefined ? res.leadershipInterest : roles.join(", ");
          me.leadershipStatus = res.leadershipStatus !== undefined ? res.leadershipStatus : (roles.length ? "Pending" : "");
        }
        renderMyDayPanel_();
      })
      .catch(() => {
        btn.disabled = false;
        if (resultEl) { resultEl.textContent = "Couldn't reach the server. Please try again."; resultEl.style.color = "var(--red)"; }
      });
  }

  // ---------------------------------------------------------------------
  // REPORTS — a free-text box parsed with plain keyword matching (no
  // external AI service, no subscription — WG2's explicit requirement)
  // pre-fills a visible, editable structured filter panel; results render
  // as an on-screen sortable table with a CSV export. Covers Students/
  // Team/Tasks/Clusters/Attendance, all already loaded client-side.
  // Leads/Assistant Leads/Zone Coordinators only (see reportsTabBtn gating
  // in renderAccessGatedUI) — same tier as the executive Dashboard.
  // ---------------------------------------------------------------------
  const REPORT_SOURCES = {
    students: {
      label: "Students",
      columns: [
        { key: "id", label: "ID" }, { key: "name", label: "Name" }, { key: "classStream", label: "Class" },
        { key: "cohort", label: "Cohort" }, { key: "choices", label: "Choices" },
        { key: "round1", label: "Round 1" }, { key: "round2", label: "Round 2" }, { key: "round3", label: "Round 3" }, { key: "round4", label: "Round 4" },
        { key: "status", label: "Status" }, { key: "teacherName", label: "Teacher" }, { key: "teacherEmail", label: "Teacher Email" }, { key: "email", label: "Student Email" },
      ],
      rows: () => state.students,
    },
    team: {
      label: "Team",
      columns: [
        { key: "id", label: "ID" }, { key: "name", label: "Name" }, { key: "role", label: "Role" }, { key: "phone", label: "Phone" }, { key: "email", label: "Email" },
        { key: "zone", label: "Zone" }, { key: "cluster", label: "Cluster" }, { key: "status", label: "Status" }, { key: "accessLevel", label: "Access Level" },
        { key: "mode", label: "Mode" }, { key: "classStream", label: "Class" },
      ],
      rows: () => state.team.filter((t) => t.status !== "Deleted"),
    },
    tasks: {
      label: "Tasks",
      columns: [
        { key: "id", label: "ID" }, { key: "phase", label: "Phase" }, { key: "task", label: "Task" }, { key: "owner", label: "Owner" },
        { key: "due", label: "Due" }, { key: "status", label: "Status" }, { key: "state", label: "State" }, { key: "notes", label: "Notes" },
      ],
      rows: () => state.tasks,
    },
    clusters: {
      label: "Clusters & Capacity",
      // Student figures and mentor figures are kept as clearly separate
      // columns on purpose — see the note above clusterStats() in app.js.
      // "Student Interest"/"Students Allocated" = students who ranked/were
      // placed here. "Mentors Assigned" = mentors whose PRIMARY cluster is
      // this one (counts toward capacity). "Backup Mentors (2nd choice)" =
      // mentors who listed this as their 2nd choice — visible here even if
      // not yet confirmed, so they're never "invisible" the way the old
      // single "Mentors" column made them.
      columns: [
        { key: "id", label: "ID" }, { key: "name", label: "Name" }, { key: "zone", label: "Zone" }, { key: "capacity", label: "Room Capacity" },
        { key: "dayCapacity", label: "Day Capacity" }, { key: "interested", label: "Student Interest" }, { key: "allocated", label: "Students Allocated" },
        { key: "mentorsAssigned", label: "Mentors Assigned" }, { key: "mentorsBackup", label: "Backup Mentors (2nd choice)" },
        { key: "mentorsInterested", label: "Total Mentor Interest" }, { key: "flag", label: "Status" },
      ],
      rows: () =>
        clusterStats().map((s) => ({
          id: s.cluster.id, name: s.cluster.name, zone: s.cluster.zone, capacity: s.cluster.capacity,
          dayCapacity: s.dayCapacity, interested: s.interested, allocated: s.allocated,
          mentorsAssigned: s.mentorsAssigned, mentorsBackup: s.mentorsBackup, mentorsInterested: s.mentorsInterested,
          flag: FLAG_LABEL[s.flag] || s.flag,
          _clusterId: s.cluster.id, // not a visible column — used by the click-through handler (renderReportTable_)
        })),
    },
    attendance: {
      label: "Attendance / Check-ins",
      columns: [
        { key: "timestamp", label: "Time" }, { key: "type", label: "Type" }, { key: "personName", label: "Name" }, { key: "round", label: "Round" },
        { key: "room", label: "Room" }, { key: "method", label: "Method" }, { key: "checkedInBy", label: "Checked In By" },
      ],
      rows: () => state.attendance,
    },
  };

  function reportSourceHasCol_(source, field) {
    return REPORT_SOURCES[source].columns.some((c) => c.key === field);
  }

  const ROLE_KEYWORDS_ = ["Zone Coordinator", "Cluster Lead", "Sub-Lead", "Class Teacher", "WG8 Teacher Liaison", "Assistant Lead", "Lead", "Mentor", "Intern"];

  // Word-boundary PREFIX matches only (no trailing \b) so plurals still hit
  // — "mentors"/"clusters"/"coordinators" must match "mentor"/"cluster"/
  // "coordinator" — this bit me during testing (Zone Coordinator: "Zone C"
  // was missed because "mentors" doesn't satisfy \bmentor\b).
  function detectReportSource_(lower) {
    if (/\battendance|\bcheck-?in/.test(lower)) return "attendance";
    if (/\bcluster|\bcapacity|\bcoverage/.test(lower)) return "clusters";
    if (/\btask/.test(lower)) return "tasks";
    if (/\bteam\b|\bmentor|\bvolunteer|\bcoordinator|\bintern|\bteacher/.test(lower)) return "team";
    return "students";
  }

  // Rule-based, keyword-matching parser — deliberately NOT true natural
  // language understanding (WG2 asked for this without any paid/subscription
  // AI service). It only ever pre-fills the visible filter panel below, which
  // stays fully editable, so a missed or wrong match is a one-click fix, not
  // a silent bad report.
  function parseReportQuery_(text) {
    const lower = String(text || "").trim().toLowerCase();
    const source = detectReportSource_(lower);
    const filters = [];

    const zoneMatch = lower.match(/\bzone\s*([a-e])\b/);
    if (zoneMatch && reportSourceHasCol_(source, "zone")) filters.push({ field: "zone", value: "Zone " + zoneMatch[1].toUpperCase() });

    if (source === "team") {
      const role = ROLE_KEYWORDS_.find((r) => lower.indexOf(r.toLowerCase()) !== -1);
      if (role) filters.push({ field: "role", value: role });
      if (/\bunconfirmed\b/.test(lower)) filters.push({ field: "status", value: "Unconfirmed" });
      else if (/\bconfirmed\b/.test(lower)) filters.push({ field: "status", value: "Confirmed" });
    } else if (source === "students") {
      if (/\bform\s*4\b|\bf4\b/.test(lower)) filters.push({ field: "cohort", value: "F4" });
      else if (/\bgrade\s*10\s*a\b|\bg10a\b/.test(lower)) filters.push({ field: "cohort", value: "G10A" });
      else if (/\bgrade\s*10\s*b\b|\bg10b\b/.test(lower)) filters.push({ field: "cohort", value: "G10B" });
      if (/\bno choices?\b/.test(lower)) filters.push({ field: "choices", value: "-" });
    } else if (source === "tasks") {
      if (/\bdone\b|\bcompleted\b/.test(lower)) filters.push({ field: "state", value: "Done" });
      else if (/\bin progress\b/.test(lower)) filters.push({ field: "state", value: "In Progress" });
      else if (/\bpending\b|\bnot started\b/.test(lower)) filters.push({ field: "state", value: "Pending" });
      const owner = state.team.find((m) => lower.indexOf(m.name.toLowerCase()) !== -1);
      if (owner) filters.push({ field: "owner", value: owner.name });
    } else if (source === "clusters") {
      if (/\boversubscribed\b|\bover.?subscribed\b|\bover capacity\b/.test(lower)) filters.push({ field: "flag", value: FLAG_LABEL.over });
      else if (/\bno mentor\b|\bwithout a mentor\b|\bunmentored\b/.test(lower)) filters.push({ field: "flag", value: FLAG_LABEL.nomentor });
      else if (/\bspare capacity\b|\bunder capacity\b/.test(lower)) filters.push({ field: "flag", value: FLAG_LABEL.under });
      else if (/\bno interest\b|\bunused\b/.test(lower)) filters.push({ field: "flag", value: FLAG_LABEL.unused });
      else if (/\bbackup mentor\b|\bbackup only\b|\b2nd.?choice mentor\b/.test(lower)) filters.push({ field: "flag", value: FLAG_LABEL.backuponly });
    } else if (source === "attendance") {
      if (/\bstudent/.test(lower)) filters.push({ field: "type", value: "Student" });
      else if (/\bteam\b|\bmentor\b/.test(lower)) filters.push({ field: "type", value: "Team" });
      const roundMatch = lower.match(/\bround\s*([1-4])\b/);
      if (roundMatch) filters.push({ field: "round", value: "Round " + roundMatch[1] });
    }

    // "only/just <columns>" — best-effort column selection; falls back to
    // every column if nothing recognizable follows.
    let columns = null;
    const onlyMatch = lower.match(/\b(?:only|just)\b(.*)$/);
    if (onlyMatch) {
      const cols = REPORT_SOURCES[source].columns.filter((c) => onlyMatch[1].indexOf(c.label.toLowerCase()) !== -1);
      if (cols.length) columns = cols.map((c) => c.key);
    }

    return { source, filters, columns };
  }

  // Word-boundary match, not plain substring — "Confirmed" must NOT match
  // the cell "Unconfirmed" (a real case in this app: team.status is exactly
  // "Confirmed"/"Unconfirmed", where one is a substring of the other).
  // \b before the term means it only matches at the start of a word.
  function reportTermMatches_(cellStr, term) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("\\b" + escaped).test(cellStr);
  }

  // Tiny filter mini-language on top of word-boundary match, so the
  // structured panel stays a single text box per row instead of an
  // operator dropdown: "*" = not blank, "-" = blank, leading "!" = NOT
  // matching, anything else = case-insensitive word-boundary match.
  function applyReportFilters_(rows, filters) {
    const active = filters.filter((f) => f.field && String(f.value || "").trim() !== "");
    if (!active.length) return rows;
    return rows.filter((r) =>
      active.every((f) => {
        const cellStr = String(r[f.field] == null ? "" : r[f.field]).toLowerCase();
        const val = String(f.value).trim().toLowerCase();
        if (val === "*") return cellStr !== "";
        if (val === "-") return cellStr === "";
        if (val[0] === "!") return !reportTermMatches_(cellStr, val.slice(1));
        return reportTermMatches_(cellStr, val);
      })
    );
  }

  function renderReportFilterFields_() {
    const src = REPORT_SOURCES[state.reportSource];
    document.querySelectorAll("#reportFilterRows [data-rf-field]").forEach((sel) => {
      const cur = sel.value;
      sel.innerHTML = '<option value="">— no filter —</option>' + src.columns.map((c) => `<option value="${escAttr(c.key)}">${esc(c.label)}</option>`).join("");
      if (src.columns.some((c) => c.key === cur)) sel.value = cur;
    });
    $("reportColumnPicker").innerHTML = src.columns
      .map(
        (c) =>
          `<label class="report-col-chk"><input type="checkbox" data-rf-col value="${escAttr(c.key)}" ${!state.reportColumns || state.reportColumns.indexOf(c.key) !== -1 ? "checked" : ""}> ${esc(c.label)}</label>`
      )
      .join("");
    if ($("reportCoverageBtn")) $("reportCoverageBtn").classList.toggle("hidden", state.reportSource !== "clusters");
  }

  function setReportSource_(source) {
    if (!REPORT_SOURCES[source]) return;
    state.reportSource = source;
    state.reportColumns = null;
    state.reportSort = { col: null, dir: 1 };
    document.querySelectorAll("#reportSourceChips [data-rsource]").forEach((b) => b.classList.toggle("active", b.dataset.rsource === source));
    document.querySelectorAll("#reportFilterRows [data-rf-value]").forEach((inp) => (inp.value = ""));
    showReportTableView_();
    renderReportFilterFields_();
  }

  function applyReportQueryText_() {
    const text = $("reportQueryInput").value;
    const parsed = parseReportQuery_(text);
    setReportSource_(parsed.source);
    state.reportColumns = parsed.columns;
    renderReportFilterFields_();
    const rows = document.querySelectorAll("#reportFilterRows .report-filter-row");
    rows.forEach((row, i) => {
      const f = parsed.filters[i];
      row.querySelector("[data-rf-field]").value = f ? f.field : "";
      row.querySelector("[data-rf-value]").value = f ? f.value : "";
    });
    runReport_();
  }

  function runReport_() {
    if (!$("reportTableWrap")) return;
    const src = REPORT_SOURCES[state.reportSource];
    const filters = Array.from(document.querySelectorAll("#reportFilterRows .report-filter-row")).map((row) => ({
      field: row.querySelector("[data-rf-field]").value,
      value: row.querySelector("[data-rf-value]").value,
    }));
    const checkedCols = Array.from(document.querySelectorAll("#reportColumnPicker [data-rf-col]:checked")).map((c) => c.value);
    state.reportColumns = checkedCols.length ? checkedCols : src.columns.map((c) => c.key);
    state.reportRows = applyReportFilters_(src.rows(), filters);
    renderReportTable_();
  }

  function renderReportTable_() {
    const src = REPORT_SOURCES[state.reportSource];
    const cols = src.columns.filter((c) => state.reportColumns.indexOf(c.key) !== -1);
    // Sort in place on state.reportRows (not a throwaway copy) so the CSV
    // export matches whatever order is currently on screen.
    if (state.reportSort.col) {
      const col = state.reportSort.col, dir = state.reportSort.dir;
      state.reportRows.sort((a, b) => {
        const av = a[col], bv = b[col];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
        return String(av).localeCompare(String(bv)) * dir;
      });
    }
    const rows = state.reportRows;
    $("reportResultCount").textContent = rows.length + " row" + (rows.length === 1 ? "" : "s") + " · " + src.label;
    if (!rows.length) {
      $("reportTableWrap").innerHTML = '<div class="empty">No rows match this report.</div>';
    } else {
      const thead = cols
        .map((c) => `<th data-rf-sort="${escAttr(c.key)}">${esc(c.label)}${state.reportSort.col === c.key ? (state.reportSort.dir === 1 ? " ▲" : " ▼") : ""}</th>`)
        .join("");
      // Clusters report rows are clickable — jump straight to that cluster's
      // card in the Cluster Command Center for mentor detail and actions
      // (contact, pull a backup mentor in, confirm dual mentorship, etc.).
      // See jumpToClusterCommand_/handleReportTableClick_.
      const clickable = state.reportSource === "clusters";
      const tbody = rows
        .map(
          (r) =>
            `<tr${clickable ? ` class="report-row-clickable" data-report-cluster="${escAttr(r.id)}" title="Click to see mentors and actions for this cluster"` : ""}>` +
            cols.map((c) => `<td>${esc(r[c.key])}</td>`).join("") +
            "</tr>"
        )
        .join("");
      $("reportTableWrap").innerHTML = `<table class="dash-table report-table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`;
    }
    renderReportPreview_();
    setReportPreviewMode_(state.reportPreviewMode);
  }

  function handleReportSortClick_(e) {
    const th = e.target.closest("[data-rf-sort]");
    if (!th) return;
    const col = th.dataset.rfSort;
    if (state.reportSort.col === col) state.reportSort.dir *= -1;
    else state.reportSort = { col, dir: 1 };
    renderReportTable_();
  }

  // Clicking anywhere on a clusters-report row (except the sortable header,
  // handled separately) jumps to that cluster's card in the Cluster Command
  // Center — on the exec Dashboard if this person can manage a zone, or the
  // Intern My Day panel otherwise — expands it, and scrolls it into view.
  function handleReportTableClick_(e) {
    if (e.target.closest("[data-rf-sort]")) { handleReportSortClick_(e); return; }
    const row = e.target.closest("[data-report-cluster]");
    if (row) jumpToClusterCommand_(row.dataset.reportCluster);
  }

  function jumpToClusterCommand_(clusterId) {
    if (!clusterId) return;
    state.clusterCommandExpanded[clusterId] = true;
    setTab("dashboard");
    requestAnimationFrame(() => {
      setTimeout(() => {
        const card = Array.from(document.querySelectorAll("[data-ccc-toggle]")).find((el) => el.dataset.cccToggle === clusterId);
        if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 30);
    });
  }

  // ---------------------------------------------------------------------
  // REPORTS TAB PREVIEW — same filtered result set (state.reportRows) shown
  // three ways: the existing sortable Table, a Chart view (reusing the same
  // svgDonut_/svgHBars_ helpers the Dashboard charts use — no new library),
  // and a plain-language Summary paragraph. Purely a different view of data
  // already on screen — no extra fetch, no AI service.
  // ---------------------------------------------------------------------
  const FLAG_COLOR_ = {};
  FLAG_COLOR_[FLAG_LABEL.over] = "var(--red)";
  FLAG_COLOR_[FLAG_LABEL.under] = "var(--amber)";
  FLAG_COLOR_[FLAG_LABEL.unused] = "var(--grey)";
  FLAG_COLOR_[FLAG_LABEL.nomentor] = "var(--red-dark)";
  FLAG_COLOR_[FLAG_LABEL.backuponly] = "var(--amber)";
  FLAG_COLOR_[FLAG_LABEL.ok] = "var(--green)";

  const REPORT_SEG_COLOR_ = {
    F4: "var(--red-dark)", G10A: "var(--amber)", G10B: "var(--green)",
    Confirmed: "var(--green)", Unconfirmed: "var(--amber)",
    Done: "var(--green)", "In Progress": "var(--amber)", Pending: "var(--grey)",
    Student: "var(--red-dark)", Team: "var(--amber)",
  };

  function countReportRowsBy_(rows, key) {
    const counts = {};
    rows.forEach((r) => {
      const v = (r[key] === undefined || r[key] === null || r[key] === "") ? "(blank)" : String(r[key]);
      counts[v] = (counts[v] || 0) + 1;
    });
    return counts;
  }

  function pct_(part, whole) {
    return whole ? ((part / whole) * 100).toFixed(0) : "0";
  }

  function renderReportPreview_() {
    const chartEl = $("reportChartWrap");
    const textEl = $("reportTextWrap");
    if (!chartEl || !textEl) return;
    const src = state.reportSource;
    const rows = state.reportRows;
    const n = rows.length;

    if (!n) {
      chartEl.innerHTML = '<div class="empty">No rows to chart.</div>';
      textEl.innerHTML = '<div class="empty">No rows to summarize.</div>';
      return;
    }

    let chartHtml = "";
    let textHtml = "";

    if (src === "students") {
      const cohortCounts = countReportRowsBy_(rows, "cohort");
      const cohortSegs = Object.keys(COHORT_TARGETS).map((c) => ({ label: COHORT_LABELS[c] || c, value: cohortCounts[c] || 0, color: REPORT_SEG_COLOR_[c] }));
      const withChoices = rows.filter((r) => r.choices).length;
      const fullyAllocated = rows.filter((r) => r.round1 && r.round2 && r.round3).length;
      chartHtml = `
        <div class="chart-card"><div class="chart-title">By Cohort</div><div class="chart-body">${svgDonut_(cohortSegs, { centerText: n, centerSub: "students" })}${donutLegendHtml_(cohortSegs)}</div></div>
        <div class="chart-card chart-card--wide"><div class="chart-title">Choices &amp; Allocation</div>${svgHBars_([
          { label: "Submitted choices", value: withChoices, color: "var(--green)" },
          { label: "No choices yet", value: n - withChoices, color: "var(--grey)" },
          { label: "Fully allocated (3 rounds)", value: fullyAllocated, color: "var(--red-dark)" },
        ])}</div>`;
      textHtml = `<p>${n} student${n === 1 ? "" : "s"} in this result set. ${withChoices} (${pct_(withChoices, n)}%) have submitted cluster choices, and ${fullyAllocated} (${pct_(fullyAllocated, n)}%) are fully allocated across all 3 standard rounds.</p>`;
    } else if (src === "team") {
      const statusCounts = countReportRowsBy_(rows, "status");
      const statusSegs = Object.keys(statusCounts).map((s) => ({ label: s, value: statusCounts[s], color: REPORT_SEG_COLOR_[s] || "var(--grey)" }));
      const roleCounts = countReportRowsBy_(rows, "role");
      const roleRows = Object.keys(roleCounts).sort((a, b) => roleCounts[b] - roleCounts[a]).map((r) => ({ label: r, value: roleCounts[r] }));
      chartHtml = `
        <div class="chart-card"><div class="chart-title">By Status</div><div class="chart-body">${svgDonut_(statusSegs, { centerText: n, centerSub: "team" })}${donutLegendHtml_(statusSegs)}</div></div>
        <div class="chart-card chart-card--wide"><div class="chart-title">By Role</div>${svgHBars_(roleRows)}</div>`;
      const confirmed = statusCounts["Confirmed"] || 0;
      textHtml = `<p>${n} team member${n === 1 ? "" : "s"} in this result set. ${confirmed} (${pct_(confirmed, n)}%) are confirmed. Most common role: ${roleRows[0] ? roleRows[0].label + " (" + roleRows[0].value + ")" : "—"}.</p>`;
    } else if (src === "tasks") {
      const stateCounts = countReportRowsBy_(rows, "state");
      const stateSegs = ["Done", "In Progress", "Pending"].map((s) => ({ label: s, value: stateCounts[s] || 0, color: REPORT_SEG_COLOR_[s] }));
      chartHtml = `<div class="chart-card"><div class="chart-title">By Status</div><div class="chart-body">${svgDonut_(stateSegs, { centerText: n, centerSub: "tasks" })}${donutLegendHtml_(stateSegs)}</div></div>`;
      const done = stateCounts["Done"] || 0;
      textHtml = `<p>${n} task${n === 1 ? "" : "s"} in this result set. ${done} (${pct_(done, n)}%) are done.</p>`;
    } else if (src === "clusters") {
      const interestRows = rows.slice().sort((a, b) => b.interested - a.interested).slice(0, 12).map((r) => ({ label: r.id, value: r.interested }));
      const mentorRows = rows.slice().sort((a, b) => b.mentorsAssigned - a.mentorsAssigned).slice(0, 12).map((r) => ({ label: r.id, value: r.mentorsAssigned, color: "var(--green)" }));
      const flagCounts = countReportRowsBy_(rows, "flag");
      const flagSegs = Object.keys(flagCounts).map((f) => ({ label: f, value: flagCounts[f], color: FLAG_COLOR_[f] || "var(--grey)" }));
      const noMentor = rows.filter((r) => r.flag === FLAG_LABEL.nomentor).length;
      const backupOnly = rows.filter((r) => r.flag === FLAG_LABEL.backuponly).length;
      chartHtml = `
        <div class="chart-card"><div class="chart-title">Status Breakdown</div><div class="chart-body">${svgDonut_(flagSegs, { centerText: n, centerSub: "clusters" })}${donutLegendHtml_(flagSegs)}</div></div>
        <div class="chart-card chart-card--wide"><div class="chart-title">Student Interest by Cluster</div>${svgHBars_(interestRows)}</div>
        <div class="chart-card chart-card--wide"><div class="chart-title">Mentors Assigned by Cluster</div>${svgHBars_(mentorRows)}</div>`;
      textHtml = `<p>${n} cluster${n === 1 ? "" : "s"} in this result set. ${noMentor} ${noMentor === 1 ? "has" : "have"} no mentor assigned yet` +
        (backupOnly ? `, and ${backupOnly} ${backupOnly === 1 ? "has" : "have"} only a backup (2nd-choice) mentor on file so far — open the Cluster Command Center to pull them in.` : ".") +
        ` Click any row in the table above to jump straight to that cluster's card for mentor detail and actions.</p>`;
    } else if (src === "attendance") {
      const typeCounts = countReportRowsBy_(rows, "type");
      const typeSegs = Object.keys(typeCounts).map((t) => ({ label: t, value: typeCounts[t], color: REPORT_SEG_COLOR_[t] || "var(--grey)" }));
      const roundCounts = countReportRowsBy_(rows, "round");
      const roundRows = Object.keys(roundCounts).sort().map((r) => ({ label: r, value: roundCounts[r] }));
      chartHtml = `
        <div class="chart-card"><div class="chart-title">By Type</div><div class="chart-body">${svgDonut_(typeSegs, { centerText: n, centerSub: "check-ins" })}${donutLegendHtml_(typeSegs)}</div></div>
        <div class="chart-card chart-card--wide"><div class="chart-title">By Round</div>${svgHBars_(roundRows)}</div>`;
      textHtml = `<p>${n} check-in${n === 1 ? "" : "s"} in this result set.</p>`;
    }

    chartEl.innerHTML = `<div class="charts-grid">${chartHtml}</div>`;
    textEl.innerHTML = textHtml;
  }

  function setReportPreviewMode_(mode) {
    state.reportPreviewMode = mode;
    document.querySelectorAll("#reportPreviewChips [data-rpmode]").forEach((b) => b.classList.toggle("active", b.dataset.rpmode === mode));
    if ($("reportTableWrap")) $("reportTableWrap").classList.toggle("hidden", mode !== "table");
    if ($("reportChartWrap")) $("reportChartWrap").classList.toggle("hidden", mode !== "chart");
    if ($("reportTextWrap")) $("reportTextWrap").classList.toggle("hidden", mode !== "text");
  }

  function downloadReportCsv_() {
    const src = REPORT_SOURCES[state.reportSource];
    const cols = src.columns.filter((c) => state.reportColumns.indexOf(c.key) !== -1);
    downloadCSV("wg2-report-" + state.reportSource + "-" + todayStr() + ".csv", cols.map((c) => c.key), state.reportRows);
  }

  // ---------------------------------------------------------------------
  // MENTOR COVERAGE ANALYSIS — a templated (not generative) narrative
  // report: priority gaps / needs-reinforcement / strongest tiers, plus a
  // recruitment-math paragraph, all computed from real clusterStats() data
  // (the same mentor counts already used in the Capacity & Coverage table).
  // Every number is arithmetic on live data substituted into a fixed
  // sentence template — no external AI service, reproducible on demand.
  // ---------------------------------------------------------------------
  function coverageTierLabel_(n) {
    if (n === 0) return "No mentors";
    if (n === 1) return "Low";
    if (n === 2) return "Covered";
    if (n <= 4) return "Good";
    if (n <= 6) return "Strong";
    return "Strongest";
  }
  function coverageTierEmoji_(n) {
    return n === 0 ? "🔴" : n === 1 ? "🟡" : "🟢";
  }

  function computeCoverageTiers_() {
    const rows = clusterStats()
      .map((s) => ({ id: s.cluster.id, name: s.cluster.name, zone: s.cluster.zone, mentors: s.mentors }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const empty = rows.filter((r) => r.mentors === 0);
    const low = rows.filter((r) => r.mentors === 1);
    const strong = rows.filter((r) => r.mentors >= 2).sort((a, b) => b.mentors - a.mentors);
    const total = rows.length;
    const totalMentors = rows.reduce((a, r) => a + r.mentors, 0);
    const minTarget = total * 2;
    const gapToTarget = Math.max(0, minTarget - totalMentors);
    const idealAdditional = empty.length + low.length;
    return { rows, empty, low, strong, total, totalMentors, minTarget, gapToTarget, idealAdditional };
  }

  function coverageNarrative_(c) {
    const pctEmpty = c.total ? ((c.empty.length / c.total) * 100).toFixed(0) : "0";
    return (
      `Based on ${c.totalMentors} mentor${c.totalMentors === 1 ? "" : "s"} currently on the Team roster across ${c.total} career clusters, coverage is uneven: ` +
      `${c.empty.length} cluster${c.empty.length === 1 ? "" : "s"} (${pctEmpty}%) ${c.empty.length === 1 ? "has" : "have"} no mentor at all, and ${c.low.length} more ${c.low.length === 1 ? "has" : "have"} only one — a single cancellation away from a gap. ` +
      `A reasonable target is at least 2 mentors per cluster (${c.minTarget} slots total): at the current count of ${c.totalMentors}, that's a shortfall of ${c.gapToTarget} if every existing mentor could simply be redistributed — but redistribution across clusters isn't realistic, so the practical need is at least ${c.empty.length} more ${c.empty.length === 1 ? "mentor" : "mentors"} just to put one person in every empty cluster, and ideally ${c.idealAdditional}+ to also bring the single-mentor clusters up to two.`
    );
  }

  function renderReportCoverageAnalysis_() {
    if (!$("reportAnalysisWrap")) return;
    const c = computeCoverageTiers_();
    const narrative = coverageNarrative_(c);
    const tableRows = c.rows
      .map((r) => `<tr><td>${esc(r.id)}</td><td>${esc(r.name)}</td><td>${r.mentors}</td><td>${coverageTierEmoji_(r.mentors)} ${esc(coverageTierLabel_(r.mentors))}</td></tr>`)
      .join("");
    const emptyList = c.empty.map((r) => `<li>${esc(r.id)} — ${esc(r.name)}</li>`).join("") || "<li>None — every cluster has at least one mentor.</li>";
    const lowList = c.low.map((r) => `<li>${esc(r.id)} — ${esc(r.name)} — 1</li>`).join("") || "<li>None.</li>";
    const strongList = c.strong.slice(0, 8).map((r) => `<li>${esc(r.id)} — ${esc(r.name)}: ${r.mentors}</li>`).join("") || "<li>No cluster has 2+ mentors yet.</li>";

    $("reportAnalysisWrap").innerHTML = `
      <div class="coverage-summary">${esc(narrative)}</div>
      <div class="coverage-section">
        <div class="coverage-section-title">🔴 Priority gaps — ${c.empty.length} cluster${c.empty.length === 1 ? "" : "s"} with zero mentors</div>
        <ul>${emptyList}</ul>
      </div>
      <div class="coverage-section">
        <div class="coverage-section-title">🟡 Needs reinforcement — one mentor is a single point of failure</div>
        <ul>${lowList}</ul>
      </div>
      <div class="coverage-section">
        <div class="coverage-section-title">🟢 Strongest coverage</div>
        <ul>${strongList}</ul>
      </div>
      <div class="coverage-section">
        <div class="coverage-section-title">Full breakdown</div>
        <table class="dash-table"><thead><tr><th>Code</th><th>Cluster</th><th>Mentors</th><th>Status</th></tr></thead><tbody>${tableRows}</tbody></table>
      </div>
    `;
    state._coverageData = c;
    state._coverageNarrative = narrative;
    $("reportTableWrap").classList.add("hidden");
    if ($("reportChartWrap")) $("reportChartWrap").classList.add("hidden");
    if ($("reportTextWrap")) $("reportTextWrap").classList.add("hidden");
    if ($("reportPreviewChips")) $("reportPreviewChips").classList.add("hidden");
    $("downloadReportCsvBtn").classList.add("hidden");
    $("reportAnalysisWrap").classList.remove("hidden");
    $("reportBackToTableBtn").classList.remove("hidden");
    $("copyCoverageBtn").classList.remove("hidden");
  }

  function showReportTableView_() {
    if (!$("reportAnalysisWrap")) return;
    $("reportAnalysisWrap").classList.add("hidden");
    $("reportBackToTableBtn").classList.add("hidden");
    $("copyCoverageBtn").classList.add("hidden");
    if ($("reportPreviewChips")) $("reportPreviewChips").classList.remove("hidden");
    $("downloadReportCsvBtn").classList.remove("hidden");
    setReportPreviewMode_(state.reportPreviewMode);
  }

  function fallbackCopyText_(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      alert("Copied to clipboard.");
    } catch (e) {
      alert("Couldn't copy automatically — select and copy the text manually.");
    }
    ta.remove();
  }

  function copyCoverageAsText_() {
    const c = state._coverageData;
    if (!c) return;
    const lines = [];
    lines.push("🔴 *Priority gaps* — " + c.empty.length + " cluster" + (c.empty.length === 1 ? "" : "s") + " with zero mentors");
    (c.empty.length ? c.empty : []).forEach((r) => lines.push(r.id + " — " + r.name));
    lines.push("");
    lines.push("🟡 *Clusters that need reinforcement*");
    (c.low.length ? c.low : []).forEach((r) => lines.push(r.id + " — " + r.name + " — 1"));
    lines.push("");
    lines.push("🟢 *Strongest coverage*");
    c.strong.slice(0, 8).forEach((r) => lines.push(r.id + " — " + r.name + ": " + r.mentors));
    lines.push("");
    lines.push(state._coverageNarrative || "");
    const text = lines.join("\n");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => alert("Copied to clipboard."),
        () => fallbackCopyText_(text)
      );
    } else {
      fallbackCopyText_(text);
    }
  }

  function renderReportsTab_() {
    if (!$("reportQueryInput")) return;
    document.querySelectorAll("#reportSourceChips [data-rsource]").forEach((b) => b.classList.toggle("active", b.dataset.rsource === state.reportSource));
    showReportTableView_();
    renderReportFilterFields_();
    runReport_();
  }

  // ---------------------------------------------------------------------
  // SEARCH / COMMAND PALETTE — "search for things I'd like to do, in
  // natural language, without a paid AI service." This is plain keyword
  // scoring against a small registry (tabs, common actions, team members,
  // and — for Leads/Assistant Leads/Zone Coordinators — quick report
  // shortcuts that hand off to the real Reports tab). It deliberately only
  // ever NAVIGATES or OPENS a form; it never fires a consequential API call
  // (allocation run, send update, delete) on its own — those still require
  // the person to press the real button once they're taken to it.
  // ---------------------------------------------------------------------
  function buildSearchIndex_() {
    const admin = isAdmin();
    const zoneOrAbove = canManageZone();
    const opsOrAbove = canManageOps();
    const items = [];

    const TAB_ITEMS = [
      { tab: "tasks", label: "Tasks", sub: "Task list & status" },
      { tab: "team", label: "Team", sub: "Team directory & access" },
      { tab: "register", label: "Register", sub: "Register a student or mentor" },
      { tab: "checkin", label: "Check-In", sub: "Scan or check someone in" },
      { tab: "schedule", label: "Schedule", sub: "Find student / My Class / My Room" },
      { tab: "dashboard", label: "Dashboard", sub: zoneOrAbove ? "Executive overview" : "My Day" },
      { tab: "reports", label: "Reports", sub: "Build a custom report", need: zoneOrAbove },
      { tab: "brief", label: "Brief", sub: "Team brief & countdown" },
    ];
    TAB_ITEMS.forEach((t) => {
      if (t.need === false) return;
      items.push({ group: "Go to", label: t.label, sub: t.sub, kw: t.label + " " + t.sub, run: () => setTab(t.tab) });
    });

    function action(need, label, sub, kw, run) {
      if (!need) return;
      items.push({ group: "Actions", label, sub, kw: label + " " + sub + " " + kw, run });
    }
    action(opsOrAbove, "Add a task", "Create a new task", "new todo add task", () => { setTab("tasks"); openAddTaskModal(); });
    action(true, "My Details", "Update your name, phone, or email", "profile account edit", () => openWhoami());
    action(true, "My Class / My Room", "Your own class or cluster schedule", "my class my room schedule", () => { setTab("schedule"); setScheduleMode(isClassTeacher() ? "class" : "room"); });
    action(true, "Find a Student", "Look up a student's schedule", "find student search", () => { setTab("schedule"); setScheduleMode("find"); });
    action(zoneOrAbove, "Needs Attention", "What needs a decision right now", "attention flags alerts", () => { setTab("dashboard"); scrollToDash_("attentionPanel"); });
    action(zoneOrAbove, "Capacity & Coverage", "Cluster demand vs. seats and mentors", "capacity coverage clusters rooms", () => { setTab("dashboard"); scrollToDash_("dashCapacityTable"); });
    action(zoneOrAbove, "Mentor Status Board", "Who's checked in / live today", "mentor status board ops", () => { setTab("dashboard"); scrollToDash_("mentorOpsSection"); });
    action(zoneOrAbove, "Send Update", "Email a segment of team or a class", "send update email broadcast", () => { setTab("dashboard"); scrollToDash_("sendUpdateSection"); });
    action(admin, "Run Allocation", "Assign students to clusters/rounds", "run allocation assign", () => { setTab("dashboard"); scrollToDash_("allocationSection"); });
    action(admin, "Team Access", "Add people, set access levels", "team access add member roles", () => { setTab("dashboard"); scrollToDash_("teamAccessSection"); });
    action(admin || isIntern(), "Bulk Import Mentors", "Onboard many mentors from a list", "bulk import mentors", () => { setTab("dashboard"); scrollToDash_("mentorBulkImportSection"); });
    action(admin, "Mentor Applications", "Review public mentor sign-ups", "mentor applications review", () => { setTab("dashboard"); scrollToDash_("mentorApplicationsSection"); });
    action(admin, "Leadership Candidates", "Who wants to lead a cluster or zone", "leadership candidates cluster lead zone coordinator promote", () => { setTab("dashboard"); scrollToDash_("leadershipCandidatesSection"); });
    action(opsOrAbove, "Mentor Database", "Past mentors for re-outreach", "mentor database outreach history", () => { setTab("dashboard"); scrollToDash_("mentorDatabaseSection"); });

    if (zoneOrAbove) {
      function reportShortcut(label, query) {
        items.push({
          group: "Reports",
          label,
          sub: "Quick report",
          kw: label,
          run: () => { setTab("reports"); $("reportQueryInput").value = query; applyReportQueryText_(); },
        });
      }
      reportShortcut("Unconfirmed team members", "unconfirmed team");
      reportShortcut("Clusters with no mentor", "clusters with no mentor");
      reportShortcut("Oversubscribed clusters", "oversubscribed clusters");
      reportShortcut("Students with no choices yet", "students with no choices");
      reportShortcut("Pending tasks", "pending tasks");
      items.push({
        group: "Reports",
        label: "Mentor Coverage Analysis",
        sub: "Priority gaps, reinforcement needs, recruitment math",
        kw: "mentor coverage analysis recruitment gaps priority strongest",
        run: () => { setTab("reports"); setReportSource_("clusters"); renderReportCoverageAnalysis_(); },
      });
    }

    state.team
      .filter((t) => t.status !== "Deleted")
      .forEach((t) => {
        const where = t.cluster || t.zone || t.classStream || "";
        items.push({
          group: "Team",
          label: t.name,
          sub: [t.role, where].filter(Boolean).join(" · "),
          kw: t.name + " " + (t.role || "") + " " + where,
          run: () => { setTab("team"); if ($("teamSearch")) { $("teamSearch").value = t.name; state.teamFilters.q = t.name; renderTeamList(); } },
        });
      });

    return items;
  }

  function scoreSearchItem_(item, queryWords) {
    const kw = item.kw.toLowerCase();
    const tokens = kw.split(/\s+/);
    let score = 0;
    queryWords.forEach((w) => {
      if (!w) return;
      if (kw.indexOf(w) !== -1) score += 1;
      if (tokens.some((tok) => tok.indexOf(w) === 0)) score += 1;
    });
    return score;
  }

  function renderSearchResults_() {
    const q = $("searchInput").value.trim().toLowerCase();
    const items = buildSearchIndex_();
    let results;
    if (!q) {
      results = items.slice(0, 12);
    } else {
      const words = q.split(/\s+/).filter(Boolean);
      results = items
        .map((it) => ({ it, score: scoreSearchItem_(it, words) }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20)
        .map((s) => s.it);
    }
    state._searchResults = results;
    if (!results.length) {
      $("searchResults").innerHTML = '<div class="empty">Nothing matches — try a tab name, a person, or a role.</div>';
      return;
    }
    let lastGroup = null;
    $("searchResults").innerHTML = results
      .map((it, i) => {
        const groupHeader = it.group !== lastGroup ? `<div class="search-group-label">${esc(it.group)}</div>` : "";
        lastGroup = it.group;
        return `${groupHeader}<div class="search-result-row" data-search-idx="${i}">
          <div class="search-result-label">${esc(it.label)}</div>
          ${it.sub ? `<div class="search-result-sub">${esc(it.sub)}</div>` : ""}
        </div>`;
      })
      .join("");
  }

  function runSearchResult_(idx) {
    const results = state._searchResults || [];
    const item = results[idx];
    if (!item) return;
    closeSearchModal();
    item.run();
  }

  function handleSearchResultClick_(e) {
    const row = e.target.closest("[data-search-idx]");
    if (!row) return;
    runSearchResult_(parseInt(row.dataset.searchIdx, 10));
  }

  function handleSearchKeydown_(e) {
    if (e.key === "Escape") { closeSearchModal(); return; }
    if (e.key === "Enter") { runSearchResult_(0); }
  }

  function openSearchModal() {
    $("searchModal").classList.remove("hidden");
    $("searchInput").value = "";
    renderSearchResults_();
    setTimeout(() => $("searchInput").focus(), 30);
  }

  function closeSearchModal() {
    $("searchModal").classList.add("hidden");
  }

  // ---------------------------------------------------------------------
  // ACCESS-LEVEL UI GATING — mirrors the server-side checks in Code.gs.
  // Hiding a control here is a convenience, not the security boundary:
  // the API itself refuses these actions for the wrong accessLevel even
  // if someone tampered with the page.
  // ---------------------------------------------------------------------
  function renderAccessGatedUI() {
    if (!$("teamAccessSection")) return; // not yet in DOM on very first paint
    const admin = isAdmin();
    const zoneOrAbove = canManageZone();

    const opsOrAbove = canManageOps();

    $("teamAccessSection").classList.toggle("hidden", !admin);
    $("mentorBulkImportSection").classList.toggle("hidden", !admin && !isIntern());
    $("mentorApplicationsSection").classList.toggle("hidden", !admin);
    $("leadershipCandidatesSection").classList.toggle("hidden", !admin);
    $("roomAssignSection").classList.toggle("hidden", !opsOrAbove);
    $("opsSettingsSection").classList.toggle("hidden", !opsOrAbove);
    $("classesSection").classList.toggle("hidden", !zoneOrAbove);
    $("scheduleSection").classList.toggle("hidden", !opsOrAbove);
    $("allocationSection").classList.toggle("hidden", !admin);
    $("sendUpdateSection").classList.toggle("hidden", !zoneOrAbove);
    $("sendUpdateHint").classList.toggle("hidden", zoneOrAbove);
    $("helpFab").classList.toggle("hidden", DEMO_MODE || !state.session);
    if ($("openSearchBtn")) $("openSearchBtn").classList.toggle("hidden", DEMO_MODE || !state.session);
    $("internTaskBanner").classList.toggle("hidden", !isIntern());
    $("classTeacherTaskBanner").classList.toggle("hidden", !isClassTeacher());
    $("addTaskBtn").classList.toggle("hidden", !opsOrAbove);
    $("mentorOpsSection").classList.toggle("hidden", !zoneOrAbove);
    if ($("reportsTabBtn")) $("reportsTabBtn").classList.toggle("hidden", !zoneOrAbove);
    // Mentors & Clusters Hub — same "Leads & Zone Coordinators only" audience
    // as the rest of the exec-tier views (Reports, Send Update); no new
    // permission surface, it's a consolidated read-through of data those
    // roles could already reach on Dashboard/Team/Reports.
    if ($("hubTabBtn")) $("hubTabBtn").classList.toggle("hidden", !zoneOrAbove);
    if ($("docsTabBtn")) $("docsTabBtn").classList.toggle("hidden", !canViewDocs());
    updateMfRoleOptionsVisibility();
    // Mentor Database — Lead/Assistant Lead, Zone Coordinators, Interns
    // only, same "ops" tier as room/schedule logistics — see
    // canViewMentorDatabase_ in Code.gs (the actual access boundary; this
    // is just the matching client-side convenience).
    $("mentorDatabaseSection").classList.toggle("hidden", !opsOrAbove);

    if (admin) renderTeamAccessList();
    if (admin) refreshMentorApplications();
    if (opsOrAbove) loadMentorDatabase();
    if (admin) buildZoneClusterSelect("amZone", "amCluster");
    if (admin) updateAmModeVisibility();
    if (opsOrAbove) renderRoomAssignList();
    if (opsOrAbove) renderOpsSettings();
    if (opsOrAbove) renderSchedulePanel();
    if (zoneOrAbove) renderClassesPanel();
    if (zoneOrAbove) renderMentorOps();
  }

  // ---- Team Access panel (Lead/Assistant Lead only) ----
  // Grouped <option>s for a classStream picker built inline as an HTML
  // string (unlike populateClassStreamSelect_, which targets an existing
  // <select> element) — used by renderTeamAccessList, which builds each
  // row as one big template string rather than individual DOM nodes.
  function classOptionsHtml_(selected) {
    const byCohort = { F4: [], G10A: [], G10B: [] };
    state.classes.forEach((c) => { (byCohort[c.cohort] = byCohort[c.cohort] || []).push(c); });
    return Object.keys(COHORT_LABELS)
      .map((coh) => {
        const opts = (byCohort[coh] || [])
          .slice()
          .sort((a, b) => naturalClassCompare_(a.name, b.name))
          .map((c) => `<option value="${escAttr(c.name)}" ${c.name === selected ? "selected" : ""}>${esc(c.name)}</option>`)
          .join("");
        return opts ? `<optgroup label="${escAttr(COHORT_LABELS[coh])}">${opts}</optgroup>` : "";
      })
      .join("");
  }

  function renderTeamAccessList() {
    if (!state.team.length) {
      $("teamAccessList").innerHTML = '<div class="empty">No team members yet.</div>';
      return;
    }
    $("teamAccessList").innerHTML = state.team
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(
        (p) => `
      <div class="access-row ${p.status === "Deleted" ? "access-row--deleted" : ""}" data-access-id="${escAttr(p.id)}">
        <div class="artop">
          <div>
            <div class="arname">${esc(p.name)}${p.status === "Deleted" ? ' <span class="ardeleted-badge">DELETED</span>' : ""}</div>
            <div class="armeta">${esc(p.role || "")}${p.zone ? " · " + esc(p.zone) : ""}${p.cluster ? " · " + esc(p.cluster) : ""}</div>
          </div>
        </div>
        <div class="arcontrols">
          <input type="text" data-access-name placeholder="Full name" value="${escAttr(p.name || "")}">
          <input type="text" data-access-phone placeholder="Phone" value="${escAttr(p.phone || "")}">
        </div>
        <div class="arcontrols" style="margin-top:6px;">
          <input type="text" data-access-email placeholder="email@example.com (for PIN emails)" value="${escAttr(p.email || "")}">
          <select data-access-select>
            <option value="cluster" ${p.accessLevel === "cluster" || !p.accessLevel ? "selected" : ""}>Cluster</option>
            <option value="zone" ${p.accessLevel === "zone" ? "selected" : ""}>Zone</option>
            <option value="intern" ${p.accessLevel === "intern" ? "selected" : ""}>Intern</option>
            <option value="class" ${p.accessLevel === "class" ? "selected" : ""}>Class</option>
            <option value="all" ${p.accessLevel === "all" ? "selected" : ""}>All</option>
          </select>
        </div>
        <div class="arcontrols" style="margin-top:6px;">
          <button data-access-save>Save</button>
          <button data-access-regen>Regenerate PIN</button>
          <button data-access-resend>Resend PIN</button>
          ${p.status === "Deleted" ? "" : `<button data-access-delete style="color:var(--red);">Delete Account</button>`}
        </div>
        ${p.role === "Mentor" ? `
        <div class="arcontrols" style="margin-top:6px;">
          <select data-access-mode>
            <option value="In-person" ${(p.mode || "In-person") === "In-person" ? "selected" : ""}>In-person</option>
            <option value="Live virtual" ${p.mode === "Live virtual" ? "selected" : ""}>Live virtual</option>
            <option value="Pre-recorded" ${p.mode === "Pre-recorded" ? "selected" : ""}>Pre-recorded</option>
          </select>
          <input type="text" data-access-sessionlink placeholder="Zoom/video link (if not in-person)" value="${escAttr(p.sessionLink || "")}">
        </div>` : ""}
        ${p.role === "Class Teacher" ? `
        <div class="arcontrols" style="margin-top:6px;">
          <select data-access-classstream>
            <option value="">— pick a class —</option>
            ${classOptionsHtml_(p.classStream || "")}
          </select>
        </div>` : ""}
        <div class="arpin" data-access-pinshow></div>
      </div>
    `
      )
      .join("");
  }

  function submitAddMember(e) {
    e.preventDefault();
    const role = $("amRole").value;
    const isClassTeacher = role === "Class Teacher";
    const body = {
      action: "add_team_member",
      name: $("amName").value.trim(),
      phone: $("amPhone").value.trim(),
      email: $("amEmail").value.trim(),
      role: role,
      zone: isClassTeacher ? "" : $("amZone").value.trim(),
      cluster: isClassTeacher ? "" : $("amCluster").value.trim(),
      accessLevel: $("amAccessLevel").value,
      mode: role === "Mentor" ? $("amMode").value : "In-person",
      classStream: isClassTeacher ? $("amClassStream").value.trim() : "",
    };
    if (!body.name) return;
    if (isClassTeacher && !body.classStream) { alert("Please pick their class/stream."); return; }
    apiPost(body).then((res) => {
      const resultEl = $("addMemberResult");
      if (!res.ok) {
        resultEl.textContent = res.error || "Couldn't add this person.";
        resultEl.style.color = "var(--red)";
        return;
      }
      let msg = res.queued
        ? "Saved offline — will sync once back online."
        : `Added. Their PIN is ${res.pin} — share it with them so they can sign in. ${res.duplicateWarning ? "⚠ " + res.duplicateWarning : ""}`;
      resultEl.textContent = msg;
      resultEl.style.color = res.duplicateWarning ? "var(--amber)" : "var(--green)";
      $("addMemberForm").reset();
      if (!res.queued) refresh(false);
    });
  }

  function handleAccessRowClick(e) {
    const row = e.target.closest("[data-access-id]");
    if (!row) return;
    const id = row.dataset.accessId;
    if (e.target.matches("[data-access-save]")) {
      const level = row.querySelector("[data-access-select]").value;
      const name = row.querySelector("[data-access-name]").value.trim();
      const phone = row.querySelector("[data-access-phone]").value.trim();
      const email = row.querySelector("[data-access-email]").value.trim();
      const modeEl = row.querySelector("[data-access-mode]");
      const linkEl = row.querySelector("[data-access-sessionlink]");
      const classEl = row.querySelector("[data-access-classstream]");
      if (!name) { alert("Name can't be blank."); return; }
      const body = { action: "update_access", id, accessLevel: level, name, phone, email };
      if (modeEl) body.mode = modeEl.value;
      if (linkEl) body.sessionLink = linkEl.value.trim();
      if (classEl) body.classStream = classEl.value;
      apiPost(body).then((res) => {
        if (!res.ok && !res.queued) { alert(res.error || "Couldn't update access."); return; }
        refresh(false);
      });
    } else if (e.target.matches("[data-access-regen]")) {
      if (!confirm("Regenerate this person's PIN? Their old PIN (and any device still signed in with it) will stop working immediately.")) return;
      apiPost({ action: "update_access", id, regeneratePin: true }).then((res) => {
        if (!res.ok && !res.queued) { alert(res.error || "Couldn't regenerate PIN."); return; }
        if (res.pin) row.querySelector("[data-access-pinshow]").textContent = "New PIN: " + res.pin + " — share it with them now.";
        refresh(false);
      });
    } else if (e.target.matches("[data-access-resend]")) {
      const email = row.querySelector("[data-access-email]").value.trim();
      if (!email) { alert("Add an email for this person and click Save first, then Resend PIN."); return; }
      if (!confirm("Email their current PIN to " + email + "?")) return;
      apiPost({ action: "resend_pin", id }).then((res) => {
        alert(res && res.ok ? "PIN emailed to " + res.email + "." : (res && res.error) || "Couldn't send the email.");
      });
    } else if (e.target.matches("[data-access-delete]")) {
      const name = row.querySelector("[data-access-name]").value.trim() || "this person";
      if (!confirm(`Delete ${name}'s account? They'll be signed out and blocked from signing back in until a Lead restores it. Their task history stays on record.`)) return;
      apiPost({ action: "admin_delete_member", id }).then((res) => {
        if (!res.ok && !res.queued) { alert(res.error || "Couldn't delete this account."); return; }
        refresh(false);
      });
    }
  }

  // ---- Bulk Import Mentors (Lead/Assistant Lead only) ----
  // Onboards many mentors at once from a list compiled outside the app
  // (paste box or an uploaded .xlsx), instead of each person filling the
  // individual public registration form. See bulkRegisterMentors_ in
  // Code.gs for what actually happens server-side (skips the review queue
  // entirely — straight to a confirmed Team record + PIN per row). This
  // client side just parses whichever input was given into a common row
  // shape and does light validation before sending, so obviously-bad rows
  // (no cluster match, etc.) are caught before a round trip.

  // Matches free-text cluster input (a code like "A3", or a name/partial
  // name) to a real Clusters row — same idea as teamMemberCluster, but
  // starting from raw typed/pasted text rather than a stored Team field.
  function resolveMentorClusterInput_(text) {
    const raw = String(text || "").trim();
    if (!raw) return "";
    const upper = raw.toUpperCase();
    const byCode = state.clusters.find((c) => c.id === upper);
    if (byCode) return byCode.id;
    const lower = raw.toLowerCase();
    const byExactName = state.clusters.find((c) => String(c.name || "").trim().toLowerCase() === lower);
    if (byExactName) return byExactName.id;
    const byPartialName = state.clusters.find((c) => String(c.name || "").toLowerCase().indexOf(lower) !== -1);
    return byPartialName ? byPartialName.id : "";
  }

  function normalizeMentorMode_(text) {
    const s = String(text || "").toLowerCase();
    if (s.indexOf("virtual") !== -1 || s.indexOf("online") !== -1) return "Live virtual";
    if (s.indexOf("record") !== -1) return "Pre-recorded";
    return "In-person";
  }

  function normalizeMentorShifts_(text) {
    const s = String(text || "").toLowerCase();
    const morning = s.indexOf("morning") !== -1;
    const afternoon = s.indexOf("afternoon") !== -1;
    if (s.indexOf("both") !== -1 || s.indexOf("either") !== -1 || (morning && afternoon)) return "Either / both shifts";
    if (morning) return "Morning shift";
    if (afternoon) return "Afternoon shift";
    return "";
  }

  // One row of cells (from a pasted line or an .xlsx row) -> the shape
  // bulkRegisterMentors_ expects. Cluster/mode/shift are pre-resolved here
  // too (not just server-side) so a bad cluster name shows up as a clear
  // "skipped locally" reason before ever hitting the network.
  function mentorBulkRowFromCells_(cells) {
    const [name, phone, email, clusterText, modeText, shiftText, jobTitle, organisation, profession, notes] = cells;
    return {
      name: String(name || "").trim(),
      phone: String(phone || "").trim(),
      email: String(email || "").trim(),
      cluster: resolveMentorClusterInput_(clusterText),
      clusterRaw: String(clusterText || "").trim(),
      mode: normalizeMentorMode_(modeText),
      shifts: normalizeMentorShifts_(shiftText),
      jobTitle: String(jobTitle || "").trim(),
      organisation: String(organisation || "").trim(),
      profession: String(profession || "").trim(),
      notes: String(notes || "").trim(),
    };
  }

  function parseMentorBulkText_(text) {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => mentorBulkRowFromCells_(line.indexOf("\t") !== -1 ? line.split("\t") : line.split(",")))
      .filter((r) => r.name);
  }

  // Reads the first sheet of an uploaded workbook via SheetJS. Skips a
  // header row if the first cell of the first row reads "name" (so a file
  // exported straight from a Google/Excel form with column headers doesn't
  // get treated as mentor #1 called "Name").
  function parseMentorBulkWorkbook_(arrayBuffer) {
    const wb = XLSX.read(arrayBuffer, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false });
    const dataRows = rows.length && String((rows[0] || [])[0] || "").trim().toLowerCase() === "name" ? rows.slice(1) : rows;
    return dataRows
      .map((cells) => mentorBulkRowFromCells_((cells || []).map((c) => (c === undefined || c === null ? "" : String(c).trim()))))
      .filter((r) => r.name);
  }

  function runMentorBulkImport_(rows) {
    const resultEl = $("mentorBulkResult");
    if (!rows.length) {
      resultEl.textContent = "No valid rows found. Check the column order: Name, Phone, Email, Cluster, Mode, Shift…";
      return;
    }
    const invalid = rows.filter((r) => !r.name || !r.phone || !r.email || !r.cluster || !r.shifts);
    const valid = rows.filter((r) => r.name && r.phone && r.email && r.cluster && r.shifts);
    if (!valid.length) {
      resultEl.innerHTML =
        "None of the " + rows.length + " row(s) had every required field (Name, Phone, Email, a matching Cluster, and Shift). " +
        "Rows that didn't match a cluster: " + esc(invalid.filter((r) => r.clusterRaw && !r.cluster).map((r) => `"${r.clusterRaw}"`).join(", ") || "none") + ".";
      return;
    }
    if (DEMO_MODE) {
      resultEl.textContent = "Demo mode has no live backend to submit to — connect the app in config.js to try this for real.";
      return;
    }
    const btn = $("mentorBulkSubmitBtn");
    btn.disabled = true;
    btn.textContent = "Importing…";
    apiPost({ action: "bulk_register_mentors", rows: valid })
      .then((res) => {
        btn.disabled = false;
        btn.textContent = "Import Mentors";
        if (!res) { resultEl.textContent = "Couldn't reach the server. Check your connection and try again."; return; }
        if (res.queued) { resultEl.textContent = "You're offline — this import is queued and will run once you're back online."; return; }
        if (!res.ok) { resultEl.textContent = res.error || "Import failed."; return; }
        let msg = `<b>${res.created} / ${res.total}</b> mentor(s) created`;
        if (typeof res.emailsSent === "number") {
          msg += `. ${res.emailsSent} PIN email(s) sent`;
          if (res.emailsFailed) msg += `, ${res.emailsFailed} failed — likely Gmail's daily send quota on a big batch; share those PINs manually from Team Access`;
        }
        msg += ".";
        if (invalid.length) msg += `<br>${invalid.length} row(s) skipped locally (missing a required field).`;
        if (res.errors && res.errors.length) msg += "<br>Skipped on the server:<br>" + res.errors.map(esc).join("<br>");
        resultEl.innerHTML = msg;
        $("mentorBulkFile").value = "";
        $("mentorBulkText").value = "";
        refreshMentorApplications();
        refresh(false);
      })
      .catch(() => {
        btn.disabled = false;
        btn.textContent = "Import Mentors";
        resultEl.textContent = "Couldn't reach the server. Check your connection and try again.";
      });
  }

  function submitMentorBulkImport_() {
    const resultEl = $("mentorBulkResult");
    resultEl.textContent = "";
    const file = $("mentorBulkFile").files && $("mentorBulkFile").files[0];
    if (file) {
      if (typeof XLSX === "undefined") {
        resultEl.textContent = "The Excel-reading library didn't load (offline, or the CDN is blocked) — paste the rows into the text box instead.";
        return;
      }
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          runMentorBulkImport_(parseMentorBulkWorkbook_(e.target.result));
        } catch (err) {
          resultEl.textContent = "Couldn't read that file — make sure it's a valid .xlsx/.xls file, or use the paste box instead.";
        }
      };
      reader.onerror = () => { resultEl.textContent = "Couldn't read that file."; };
      reader.readAsArrayBuffer(file);
      return;
    }
    runMentorBulkImport_(parseMentorBulkText_($("mentorBulkText").value));
  }

  // ---- Mentor Applications panel (Lead/Assistant Lead only) ----
  // Loaded separately from the main refresh() round trip (see doGet's
  // "mentor_applications" action) since it carries real personal detail
  // that shouldn't ride along in the default payload every signed-in
  // person gets — only fetched here, only when accessLevel is "all".
  function refreshMentorApplications() {
    apiGet("mentor_applications").then((res) => {
      if (!res || !res.ok) return;
      state.mentorApplications = res.applications || [];
      renderMentorApplicationsList();
    });
  }

  function clusterLabelById_(id) {
    const c = state.clusters.find((x) => x.id === id);
    return c ? `${c.id} — ${c.name}` : id || "—";
  }

  function renderMentorApplicationsList() {
    const apps = state.mentorApplications.slice().sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));
    const pending = apps.filter((a) => a.status === "Pending");
    const reviewed = apps.filter((a) => a.status !== "Pending");

    const badge = $("mentorAppPendingBadge");
    if (pending.length) {
      badge.textContent = pending.length + " pending";
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }

    if (!apps.length) {
      $("mentorApplicationsList").innerHTML = '<div class="empty">No mentor applications yet.</div>';
      return;
    }

    const cardHtml = (a, reviewedCard) => {
      const statusClass = a.status === "Approved" ? "st-approved" : a.status === "Rejected" ? "st-rejected" : "st-pending";
      const shifts = a.shifts || "—";
      const addRole = a.additionalRole || "Mentor only";
      const exbomarianLine = a.exbomarian === "No"
        ? `Referred by ${esc(a.refereeName || "—")}${a.refereeContact ? " (" + esc(a.refereeContact) + ")" : ""}`
        : `Bomarian${a.gradYear ? ", class of " + esc(a.gradYear) : ""}`;
      return `
      <div class="mentorapp-card${reviewedCard ? " reviewed" : ""}" data-mentorapp-id="${escAttr(a.id)}">
        <div class="mentorapp-top">
          <div>
            <div class="mentorapp-name">${esc(a.name)}</div>
            <div class="mentorapp-meta">${esc(a.jobTitle || "")}${a.organisation ? " · " + esc(a.organisation) : ""}</div>
            <div class="mentorapp-meta">${exbomarianLine}</div>
          </div>
          <span class="mentorapp-status ${statusClass}">${esc(a.status)}</span>
        </div>
        <div class="mentorapp-detail-grid">
          <div><span class="lbl">Phone</span><br>${esc(a.phone || "—")}</div>
          <div><span class="lbl">Email</span><br>${esc(a.email || "—")}</div>
          <div><span class="lbl">Prefers</span><br>${esc(a.preferredContact || "—")}</div>
          <div><span class="lbl">Experience</span><br>${esc(a.yearsExperience || "—")}</div>
          <div><span class="lbl">Primary cluster</span><br>${esc(clusterLabelById_(a.primaryCluster))}</div>
          <div><span class="lbl">Second choice</span><br>${esc(a.secondaryCluster ? clusterLabelById_(a.secondaryCluster) : "N/A")}</div>
          <div><span class="lbl">Participation</span><br>${esc(a.mode || "In-person")}</div>
          <div><span class="lbl">Shift(s)</span><br>${esc(shifts)}</div>
          <div><span class="lbl">Additional role</span><br>${esc(addRole)}</div>
          <div><span class="lbl">Mentored before</span><br>${esc(a.priorMentor || "—")}</div>
          <div><span class="lbl">Briefing session</span><br>${esc(a.briefingAttend || "—")}</div>
        </div>
        ${a.bio ? `<div class="mentorapp-bio">${esc(a.bio)}</div>` : ""}
        ${a.accessNeeds ? `<div class="mentorapp-meta">Accessibility/support needs: ${esc(a.accessNeeds)}</div>` : ""}
        ${a.notes ? `<div class="mentorapp-meta">Note from applicant: ${esc(a.notes)}</div>` : ""}
        ${reviewedCard
          ? `<div class="mentorapp-meta" style="margin-top:6px;">${esc(a.status)} by ${esc(a.reviewedBy || "—")}${a.reviewedAt ? " on " + esc(String(a.reviewedAt).slice(0, 10)) : ""}</div>`
          : `<div class="mentorapp-controls">
              <select data-mentorapp-cluster>${state.clusters.slice().sort((x, y) => x.id.localeCompare(y.id)).map((c) => `<option value="${escAttr(c.id)}" ${c.id === a.primaryCluster ? "selected" : ""}>${esc(clusterLabelById_(c.id))}</option>`).join("")}</select>
              <input type="text" data-mentorapp-remarks placeholder="Optional remark for interns (e.g. call to confirm availability) — leave blank if none" class="mentorapp-remarks-input">
              <button class="approve-btn" data-mentorapp-approve>Approve</button>
              <button class="reject-btn" data-mentorapp-reject>Reject</button>
             </div>
             <div class="mentorapp-result" data-mentorapp-result></div>`
        }
      </div>`;
    };

    let html = pending.map((a) => cardHtml(a, false)).join("");
    if (reviewed.length) {
      html += '<div class="group-label" style="margin-top:14px;">Previously Reviewed</div>';
      html += reviewed.map((a) => cardHtml(a, true)).join("");
    }
    if (!pending.length && !reviewed.length) html = '<div class="empty">No mentor applications yet.</div>';
    $("mentorApplicationsList").innerHTML = html;
  }

  function handleMentorApplicationsClick(e) {
    const card = e.target.closest("[data-mentorapp-id]");
    if (!card) return;
    const id = card.dataset.mentorappId;
    const resultEl = card.querySelector("[data-mentorapp-result]");
    // One optional field serves both buttons — a reviewer who has nothing to
    // add just leaves it blank and clicks straight through, no popup forced
    // on the common case. See WG2's request: "optional to the reviewer but
    // can be actioned should there be need to clarify some things."
    const remarksEl = card.querySelector("[data-mentorapp-remarks]");
    const remarks = remarksEl ? remarksEl.value.trim() : "";

    if (e.target.matches("[data-mentorapp-approve]")) {
      const cluster = card.querySelector("[data-mentorapp-cluster]").value;
      if (!confirm("Approve this mentor and email them their sign-in PIN now?")) return;
      apiPost({ action: "approve_mentor_application", id, cluster, reviewNotes: remarks }).then((res) => {
        if (!res.ok && !res.queued) {
          if (resultEl) { resultEl.textContent = res.error || "Couldn't approve."; resultEl.style.color = "var(--red)"; }
          return;
        }
        if (resultEl) { resultEl.textContent = res.queued ? "Saved offline — will sync once back online." : `Approved. PIN emailed${res.emailSent === false ? " — actually, the email couldn't be sent, share it manually: " + res.pin : ""}.${remarks ? " Your remark is saved on their Team record for interns to see." : ""}`; resultEl.style.color = "var(--green)"; }
        refreshMentorApplications();
      });
    } else if (e.target.matches("[data-mentorapp-reject]")) {
      if (!confirm("Reject this mentor application?")) return;
      apiPost({ action: "reject_mentor_application", id, reviewNotes: remarks }).then((res) => {
        if (!res.ok && !res.queued) {
          if (resultEl) { resultEl.textContent = res.error || "Couldn't reject."; resultEl.style.color = "var(--red)"; }
          return;
        }
        refreshMentorApplications();
      });
    }
  }

  // ---------------------------------------------------------------------
  // LEADERSHIP CANDIDATES — Lead/Assistant Lead only. One review queue for
  // everyone with leadershipStatus "Pending", regardless of whether that
  // interest came from a new mentor application's checkboxes or an
  // already-confirmed mentor raising their own hand (see
  // leadershipInterestBlockHtml_ in My Day). Unlike Mentor Applications,
  // this needs no separate GET action — leadershipStatus/leadershipInterest
  // already ride along on the normal Team rows every admin-tier caller
  // already has in state.team, so it's a pure client-side filter.
  // ---------------------------------------------------------------------
  function leadershipCandidates_() {
    return state.team.filter((t) => t.status !== "Deleted" && t.leadershipStatus === "Pending");
  }

  function leadershipCandidateCardHtml_(t) {
    const interestRoles = String(t.leadershipInterest || "").split(",").map((s) => s.trim()).filter(Boolean);
    const roleOptions = interestRoles.length ? interestRoles : LEADERSHIP_ROLE_OPTIONS_;
    const whereBits = [t.cluster, t.zone].filter(Boolean).join(" · ");
    return `
      <div class="mentorapp-card" data-leadcand-id="${escAttr(t.id)}">
        <div class="mentorapp-top">
          <div>
            <div class="mentorapp-name">${esc(t.name)}</div>
            <div class="mentorapp-meta">Currently ${esc(t.role || "—")}${whereBits ? " · " + esc(whereBits) : ""}</div>
            <div class="mentorapp-meta">Requested: <b>${esc(t.leadershipInterest || "—")}</b></div>
          </div>
        </div>
        <div class="mentorapp-controls">
          <select data-leadcand-role>${roleOptions.map((r) => `<option value="${escAttr(r)}">${esc(r)}</option>`).join("")}</select>
          <input type="text" data-leadcand-remarks placeholder="Optional note (lands on their Team record)" class="mentorapp-remarks-input">
          <button class="approve-btn" data-leadcand-approve>Approve</button>
          <button class="reject-btn" data-leadcand-decline>Decline</button>
        </div>
        <div class="mentorapp-result" data-leadcand-result></div>
      </div>`;
  }

  function renderLeadershipCandidates_() {
    if (!$("leadershipCandidatesList")) return;
    const candidates = leadershipCandidates_();
    const badge = $("leadershipCandidatesBadge");
    if (badge) {
      if (candidates.length) { badge.textContent = candidates.length + " pending"; badge.classList.remove("hidden"); }
      else badge.classList.add("hidden");
    }
    $("leadershipCandidatesList").innerHTML = candidates.length
      ? candidates.map(leadershipCandidateCardHtml_).join("")
      : '<div class="empty">No leadership interest pending review right now.</div>';
  }

  function handleLeadershipCandidatesClick_(e) {
    const card = e.target.closest("[data-leadcand-id]");
    if (!card) return;
    const id = card.dataset.leadcandId;
    const resultEl = card.querySelector("[data-leadcand-result]");
    const remarksEl = card.querySelector("[data-leadcand-remarks]");
    const remarks = remarksEl ? remarksEl.value.trim() : "";

    if (e.target.matches("[data-leadcand-approve]")) {
      const role = card.querySelector("[data-leadcand-role]").value;
      if (!confirm(`Approve as ${role} and email them now?`)) return;
      apiPost({ action: "approve_leadership_role", id, role, reviewNotes: remarks }).then((res) => {
        if (!res.ok && !res.queued) {
          if (resultEl) { resultEl.textContent = res.error || "Couldn't approve."; resultEl.style.color = "var(--red)"; }
          return;
        }
        if (resultEl) { resultEl.textContent = res.queued ? "Saved offline — will sync once back online." : `Approved as ${role}.${res.emailSent === false ? " (Email couldn't be sent — let them know directly.)" : " They've been emailed."}`; resultEl.style.color = "var(--green)"; }
        refresh(false).then(() => renderLeadershipCandidates_());
      });
    } else if (e.target.matches("[data-leadcand-decline]")) {
      if (!confirm("Decline this leadership request? No email is sent automatically — you can still follow up personally.")) return;
      apiPost({ action: "decline_leadership_interest", id, reviewNotes: remarks }).then((res) => {
        if (!res.ok && !res.queued) {
          if (resultEl) { resultEl.textContent = res.error || "Couldn't decline."; resultEl.style.color = "var(--red)"; }
          return;
        }
        refresh(false).then(() => renderLeadershipCandidates_());
      });
    }
  }

  // ---- Mentor Database panel (Lead/Assistant Lead, Zone Coordinator,
  // Intern only — see canViewMentorDatabase_) ----
  // Loaded separately from the main refresh() round trip, same reasoning as
  // refreshMentorApplications: this carries real personal detail (phone,
  // email) about people who aren't even in the Team roster, so it only
  // rides along for the access levels that are actually allowed to see it.
  function loadMentorDatabase() {
    apiGet("mentor_database").then((res) => {
      if (!res || !res.ok) return;
      state.mentorDatabase = res.mentorDatabase || [];
      populateMentorDbClusterFilter();
      renderMentorDatabaseList();
    });
  }

  function populateMentorDbClusterFilter() {
    const sel = $("mentorDbClusterFilter");
    if (sel.options.length > 1) return; // only needs building once — clusters don't change per refresh
    const current = sel.value;
    const opts = state.clusters
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((c) => `<option value="${escAttr(c.id)}">${esc(clusterLabelById_(c.id))}</option>`)
      .join("");
    sel.innerHTML = '<option value="">All clusters</option>' + opts;
    sel.value = current;
  }

  function filteredMentorDatabase_() {
    const q = $("mentorDbSearch").value.trim().toLowerCase();
    const clusterFilter = $("mentorDbClusterFilter").value;
    const statusFilter = $("mentorDbStatusFilter").value;
    return state.mentorDatabase.filter((m) => {
      if (clusterFilter && m.primaryClusterId !== clusterFilter) return false;
      if (statusFilter && (m.outreachStatus || "Not yet contacted (2026)") !== statusFilter) return false;
      if (!q) return true;
      const hay = [m.name, m.profession, m.designation, m.organisation, m.primaryClusterName, m.secondaryClusterNames, m.notes]
        .filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    });
  }

  function renderMentorDatabaseList() {
    const all = filteredMentorDatabase_();
    const badge = $("mentorDbCountBadge");
    badge.textContent = all.length + (all.length === 1 ? " mentor" : " mentors");
    badge.classList.remove("hidden");

    if (!all.length) {
      $("mentorDbList").innerHTML = '<div class="empty">No mentors match this search/filter.</div>';
      $("mentorDbShowMoreWrap").classList.add("hidden");
      return;
    }

    const shown = all.slice().sort((a, b) => a.name.localeCompare(b.name)).slice(0, state.mentorDbShowCount);
    const statusClass = (s) => s === "Confirmed for 2026" ? "st-approved" : s === "Declined" || s === "Unreachable" ? "st-rejected" : s === "Contacted" ? "st-pending" : "";

    $("mentorDbList").innerHTML = shown.map((m) => {
      const status = m.outreachStatus || "Not yet contacted (2026)";
      const otherFits = m.secondaryClusterNames ? `<div><span class="lbl">Other possible fit</span><br>${esc(m.secondaryClusterNames)}</div>` : "";
      return `
      <div class="mentorapp-card" data-mentordb-id="${escAttr(m.id)}">
        <div class="mentorapp-top">
          <div>
            <div class="mentorapp-name">${esc(m.name)}${m.classOf ? ` <span style="font-weight:400;color:var(--grey);">(${esc(m.classOf)})</span>` : ""}</div>
            <div class="mentorapp-meta">${esc(m.designation || m.profession || "")}${m.organisation ? " · " + esc(m.organisation) : ""}</div>
            <span class="mentordb-cluster-tag">${esc(m.primaryClusterId)} — ${esc(m.primaryClusterName)}</span>
          </div>
          <span class="mentorapp-status ${statusClass(status)}">${esc(status)}</span>
        </div>
        <div class="mentorapp-detail-grid">
          <div><span class="lbl">Phone</span><br>${esc(m.phone || "—")}</div>
          <div><span class="lbl">Email</span><br>${esc(m.email || "—")}</div>
          <div><span class="lbl">Years involved</span><br>${esc(m.yearsInvolved || "—")}</div>
          <div><span class="lbl">Location</span><br>${esc(m.location || "—")}</div>
          ${otherFits}
          <div><span class="lbl">Source</span><br>${esc(m.source || "—")}</div>
        </div>
        ${m.notes ? `<div class="mentorapp-meta">${esc(m.notes)}</div>` : ""}
        <div class="mentordb-ai" data-mentordb-ai${m.aiStrengthsSummary ? "" : ' style="display:none;"'}>${esc(m.aiStrengthsSummary || "")}</div>
        <div class="mentorapp-controls">
          <select data-mentordb-status>
            <option value="Not yet contacted (2026)" ${status === "Not yet contacted (2026)" ? "selected" : ""}>Not yet contacted (2026)</option>
            <option value="Contacted" ${status === "Contacted" ? "selected" : ""}>Contacted</option>
            <option value="Confirmed for 2026" ${status === "Confirmed for 2026" ? "selected" : ""}>Confirmed for 2026</option>
            <option value="Declined" ${status === "Declined" ? "selected" : ""}>Declined</option>
            <option value="Unreachable" ${status === "Unreachable" ? "selected" : ""}>Unreachable</option>
          </select>
          <button class="approve-btn" data-mentordb-suggest>Suggest Fit (AI)</button>
          <button class="approve-btn" data-mentordb-save>Save</button>
        </div>
        <textarea class="mentordb-notes" data-mentordb-notes rows="2" placeholder="Outreach notes (who called, when, what they said)…">${esc(m.outreachNotes || "")}</textarea>
        <div class="mentorapp-result" data-mentordb-result></div>
      </div>`;
    }).join("");

    $("mentorDbShowMoreWrap").classList.toggle("hidden", all.length <= state.mentorDbShowCount);
  }

  function handleMentorDatabaseClick(e) {
    const card = e.target.closest("[data-mentordb-id]");
    if (!card) return;
    const id = card.dataset.mentordbId;
    const resultEl = card.querySelector("[data-mentordb-result]");

    if (e.target.matches("[data-mentordb-save]")) {
      const status = card.querySelector("[data-mentordb-status]").value;
      const outreachNotes = card.querySelector("[data-mentordb-notes]").value.trim();
      apiPost({ action: "update_mentor_database_entry", id, outreachStatus: status, outreachNotes }).then((res) => {
        if (!res.ok && !res.queued) {
          resultEl.textContent = res.error || "Couldn't save."; resultEl.style.color = "var(--red)"; return;
        }
        resultEl.textContent = res.queued ? "Saved offline — will sync once back online." : "Saved.";
        resultEl.style.color = "var(--green)";
        const rec = state.mentorDatabase.find((m) => m.id === id);
        if (rec) { rec.outreachStatus = status; rec.outreachNotes = outreachNotes; }
      });
    } else if (e.target.matches("[data-mentordb-suggest]")) {
      const btn = e.target;
      btn.disabled = true;
      btn.textContent = "Thinking…";
      apiPost({ action: "suggest_mentor_fit", mentorDbId: id }).then((res) => {
        btn.disabled = false;
        btn.textContent = "Suggest Fit (AI)";
        if (!res.ok) {
          resultEl.textContent = res.error || "Couldn't get a suggestion."; resultEl.style.color = "var(--red)"; return;
        }
        const aiEl = card.querySelector("[data-mentordb-ai]");
        aiEl.textContent = res.aiStrengthsSummary || "";
        aiEl.style.display = res.aiStrengthsSummary ? "" : "none";
        const rec = state.mentorDatabase.find((m) => m.id === id);
        if (rec) rec.aiStrengthsSummary = res.aiStrengthsSummary || "";
        resultEl.textContent = res.usedGemini ? "AI summary generated." : "Heuristic suggestion generated (AI summary not configured).";
        resultEl.style.color = "var(--green)";
      });
    }
  }

  // ---- Room Assignments panel (all / zone access) ----
  function renderRoomAssignList() {
    if (!state.clusters.length) {
      $("roomAssignList").innerHTML = '<div class="empty">No clusters loaded yet.</div>';
      return;
    }
    const myZone = zoneLetterOfClient(state.session ? state.session.zone : "");
    // Admins and Interns see every zone (an intern coordinating rooms
    // isn't tied to one zone); a Zone Coordinator only sees their own.
    const visible = state.clusters
      .slice()
      .filter((c) => isAdmin() || isIntern() || c.zone === myZone)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (!visible.length) {
      $("roomAssignList").innerHTML = '<div class="empty">No clusters in your zone.</div>';
      return;
    }
    $("roomAssignList").innerHTML = visible
      .map(
        (c) => `
      <div class="room-row" data-room-id="${escAttr(c.id)}">
        <div class="rrtop">
          <div class="rrmeta"><b>${esc(c.id)}</b> · ${esc(c.name)} · Zone ${esc(c.zone)}</div>
        </div>
        <div class="rrcontrols">
          <input type="text" value="${escAttr(c.room || "")}" placeholder="e.g. 1K1, Senior Corridor" data-room-input>
          <button data-room-save>Save</button>
        </div>
      </div>
    `
      )
      .join("");
  }

  // Client-side mirror of Code.gs's zoneLetterOf_: anchored to the END of
  // the string so "Zone A" -> "A" and the word "Zone" itself (which
  // contains an "E") never gets matched instead.
  function zoneLetterOfClient(zoneText) {
    const m = String(zoneText || "").trim().toUpperCase().match(/([A-E])\s*$/);
    return m ? m[1] : "";
  }

  function handleRoomRowClick(e) {
    if (!e.target.matches("[data-room-save]")) return;
    const row = e.target.closest("[data-room-id]");
    const id = row.dataset.roomId;
    const room = row.querySelector("[data-room-input]").value.trim();
    apiPost({ action: "update_cluster_room", id, room }).then((res) => {
      if (!res.ok && !res.queued) { alert(res.error || "Couldn't update room."); return; }
      if (!res.queued) refresh(false);
    });
  }

  // ---- Room Map & Coordination settings (Ops access) ----
  function renderOpsSettings() {
    if (!$("stgRoomMapUrl")) return;
    $("stgRoomMapUrl").value = state.settings.roomMapUrl || "";
    $("stgRoomCoordName").value = state.settings.roomCoordinatorName || "";
    $("stgRoomCoordContact").value = state.settings.roomCoordinatorContact || "";
    if ($("stgMentorCapacity")) $("stgMentorCapacity").value = state.settings.mentorCapacityPerShift || "8";
  }
  function saveOpsSettings() {
    const capRaw = $("stgMentorCapacity") ? parseInt($("stgMentorCapacity").value, 10) : NaN;
    const updates = [
      ["roomMapUrl", $("stgRoomMapUrl").value.trim()],
      ["roomCoordinatorName", $("stgRoomCoordName").value.trim()],
      ["roomCoordinatorContact", $("stgRoomCoordContact").value.trim()],
    ];
    if ($("stgMentorCapacity")) updates.push(["mentorCapacityPerShift", String(!isNaN(capRaw) && capRaw > 0 ? capRaw : 8)]);
    const resultEl = $("stgSaveResult");
    resultEl.textContent = "Saving…";
    resultEl.style.color = "#777";
    Promise.all(updates.map(([key, value]) => apiPost({ action: "update_setting", key, value })))
      .then((results) => {
        if (results.some((r) => !r.ok && !r.queued)) {
          resultEl.textContent = "Couldn't save one or more fields.";
          resultEl.style.color = "var(--red)";
          return;
        }
        resultEl.textContent = "Saved.";
        resultEl.style.color = "var(--green)";
        refresh(false);
      })
      .catch(() => { resultEl.textContent = "Couldn't save — check your connection."; resultEl.style.color = "var(--red)"; });
  }

  // ---- Classes & Streams (Zone access and above) ----
  function renderClassesPanel() {
    if (!$("classesList")) return;
    if (!state.classes.length) {
      $("classesList").innerHTML = '<div class="empty">No classes added yet — use the form above.</div>';
      return;
    }
    const order = ["F4", "G10A", "G10B"];
    let html = "";
    order.forEach((coh) => {
      const rows = state.classes.filter((c) => c.cohort === coh).sort((a, b) => naturalClassCompare_(a.name, b.name));
      if (!rows.length) return;
      html += `<div class="group-label">${esc(COHORT_LABELS[coh] || coh)} (${rows.length})</div>`;
      html += rows
        .map(
          (c) => `
        <div class="room-row" data-class-id="${escAttr(c.id)}">
          <div class="rrcontrols">
            <input type="text" value="${escAttr(c.name)}" data-class-input>
            <button data-class-save>Save</button>
          </div>
        </div>
      `
        )
        .join("");
    });
    $("classesList").innerHTML = html || '<div class="empty">No classes added yet.</div>';
  }
  function submitAddClass(e) {
    e.preventDefault();
    const cohort = $("clsCohort").value;
    const name = $("clsName").value.trim();
    if (!name) return;
    apiPost({ action: "add_class", cohort, name }).then((res) => {
      const resultEl = $("addClassResult");
      if (!res.ok && !res.queued) { resultEl.textContent = res.error || "Couldn't add class."; resultEl.style.color = "var(--red)"; return; }
      resultEl.textContent = res.queued ? "Saved offline — will sync once back online." : "Added.";
      resultEl.style.color = "var(--green)";
      $("addClassForm").reset();
      if (!res.queued) refresh(false);
    });
  }
  function handleClassesListClick(e) {
    if (!e.target.matches("[data-class-save]")) return;
    const row = e.target.closest("[data-class-id]");
    const id = row.dataset.classId;
    const name = row.querySelector("[data-class-input]").value.trim();
    apiPost({ action: "update_class", id, name }).then((res) => {
      if (!res.ok && !res.queued) { alert(res.error || "Couldn't update class."); return; }
      if (!res.queued) refresh(false);
    });
  }

  // ---- Session Schedule (Ops access) ----
  function renderSchedulePanel() {
    if (!$("scheduleList")) return;
    if (!state.schedule.length) {
      $("scheduleList").innerHTML = '<div class="empty">No schedule rows found — run setupSheets() again in Apps Script to create them.</div>';
      return;
    }
    const order = ["F4", "G10A", "G10B"];
    let html = "";
    order.forEach((coh) => {
      const rows = state.schedule.filter((s) => s.cohort === coh).sort((a, b) => Number(a.round) - Number(b.round));
      if (!rows.length) return;
      html += `<div class="group-label">${esc(COHORT_LABELS[coh] || coh)}</div>`;
      html += rows
        .map(
          (s) => `
        <div class="room-row" data-schedule-id="${escAttr(s.id)}">
          <div class="rrtop"><div class="rrmeta"><b>Round ${esc(s.round)}</b></div></div>
          <div class="rrcontrols">
            <input type="text" value="${escAttr(s.startTime || "")}" placeholder="Start e.g. 09:25" data-schedule-start style="max-width:90px;">
            <input type="text" value="${escAttr(s.endTime || "")}" placeholder="End e.g. 09:50" data-schedule-end style="max-width:90px;">
            <button data-schedule-save>Save</button>
          </div>
        </div>
      `
        )
        .join("");
    });
    $("scheduleList").innerHTML = html;
  }
  function handleScheduleListClick(e) {
    if (!e.target.matches("[data-schedule-save]")) return;
    const row = e.target.closest("[data-schedule-id]");
    const id = row.dataset.scheduleId;
    const startTime = row.querySelector("[data-schedule-start]").value.trim();
    const endTime = row.querySelector("[data-schedule-end]").value.trim();
    apiPost({ action: "update_schedule_slot", id, startTime, endTime }).then((res) => {
      if (!res.ok && !res.queued) { alert(res.error || "Couldn't update schedule."); return; }
      if (!res.queued) refresh(false);
    });
  }

  // ---------------------------------------------------------------------
  // PRIVACY POLICY — one shared modal (see #privacyModal in index.html),
  // opened from the login screen, both public no-sign-in registration
  // forms, and the Help modal. Content lives here as a single source of
  // truth rather than duplicated HTML in three places. This is a condensed
  // in-app version of the full Privacy Policy document (WG2_Privacy_
  // Policy_2026.docx) delivered alongside the app — same 15 sections, same
  // substance, tightened for on-screen reading. Governing law: the Data
  // Protection Act, 2019 (Kenya), plus the international standards (GDPR
  // principles) referenced in Section 3, per the Society's decision that
  // every user is bound by whichever gives them stronger protection.
  // ---------------------------------------------------------------------
  const PRIVACY_POLICY_HTML = `
    <p><i>Effective 15 August 2026. Applies to every user of this app and its public registration pages — WG2 Leads/Assistant Leads, Zone Coordinators, Cluster/Sub-Cluster Leads, Interns, Mentors, Class Teachers, registering students and their parents/guardians, and anyone recorded in the Mentor Database from a past Career Day.</i></p>
    <h3>1. Scope &amp; Who We Are</h3>
    <p>This Policy is issued by the KHS Alumnae Society's Working Group 2 (Mentors), the data controller for Boma Career Day. By using this app, submitting a registration form, or continuing to serve on the WG2 team, you agree to the handling of personal data described here. Questions or requests: WG2 Lead Dr Muthoni Mugambi, Assistant Lead Cizarina Nasirumbi, boma.alumnae@gmail.com, or the in-app Feedback form.</p>
    <h3>2. Governing Law</h3>
    <p>This app and its data are governed primarily by Kenya's Data Protection Act, No. 24 of 2019, enforced by the Office of the Data Protection Commissioner (ODPC), together with Article 31 of the Constitution of Kenya. Because Boma Career Day involves diaspora alumnae and international mentors, WG2 also applies GDPR-aligned principles (lawfulness, purpose limitation, data minimisation, accuracy, storage limitation, confidentiality) as good practice, and will honour a data subject's stronger home-jurisdiction right on request. Every user is bound by Kenyan law and by these international standards, whichever protects them more.</p>
    <h3>3. What We Collect &amp; Why</h3>
    <ul>
      <li><b>Team/Roster:</b> name, contact, role, zone/cluster/class, sign-in PIN (never readable once set) — to coordinate the WG2 team.</li>
      <li><b>Students &amp; parents/guardians:</b> student name and a system-generated Career Day ID (never the school's own admission number), class/stream, cluster choices; for parent-assisted sign-up, the parent/guardian's name, contact, and a timestamped consent record — to register and allocate students, and to record that a parent authorised a minor's participation.</li>
      <li><b>Mentor applications:</b> contact details, job title, organisation, profession, experience, bio, cluster preference, availability, and an optional LinkedIn/profile link — to review and approve mentor sign-ups and suggest a good cluster fit.</li>
      <li><b>Mentor Database:</b> name, class year, organisation, profession, cluster(s), and contact details for people who have mentored/spoken/led a cluster at a Career Day. Compiled from the Society's own records for 2017 onward, and updated automatically each year as new mentors are approved through this app — so a 2026 mentor's record merges with their history if they've mentored before, or is created fresh if not — to re-invite past mentors and plan resourcing.</li>
      <li><b>Communications:</b> team broadcast chat, group channels, and private 1:1 messages (private messages are visible only to the two participants, never anyone else).</li>
      <li><b>Feedback &amp; Mentor Survey:</b> bug reports/questions, and post-event survey responses — to improve the app and future Career Days.</li>
      <li><b>Activity log:</b> a basic audit trail of who did what, when — for accountability.</li>
    </ul>
    <p>Data is used only for these purposes — never sold, and never used for marketing unrelated to Boma Career Day.</p>
    <h3>4. Children's Data &amp; Parental Consent</h3>
    <p>Registering students are minors. The app never collects the school's own admission number. Parent-assisted registration requires an explicit, timestamped parent/guardian consent before submission; in-person registration by a Class Teacher or WG2 member treats that adult as the consenting party, as with normal school enrolment. A student's own email is used only to send her own QR code.</p>
    <h3>5. AI-Assisted Cluster Matching</h3>
    <p>A keyword-based tool (no external data transfer) automatically suggests a matching or alternate cluster from a mentor's own profession/bio. If a mentor voluntarily shares a LinkedIn/profile link, an authorised admin (Lead, Assistant Lead, Zone Coordinator, or Intern) may optionally request a richer AI-generated summary via Google's Gemini service — only if the Society has configured this, only on explicit request for a specific person, never automatically or in bulk, and always advisory: a person reviews every suggestion. Only profession/bio/voluntary profile text is ever sent for this — never phone, email, or any other field. You may decline to share a profile link, or ask that no AI summary be produced or kept for your record.</p>
    <h3>6. Who Can See Your Data</h3>
    <p>Access is enforced by the app itself, not just hidden in the interface. Whole-event data (Team, Tasks, Clusters, Schedule) is visible to signed-in team members, scoped to their zone/cluster/class. Mentor Applications: Leads/Assistant Leads only. <b>Historical Mentor Database: Leads, Assistant Leads, Zone Coordinators, and Interns only</b> — not plain Mentors, Sub-Leads, or Class Teachers. Private messages: only the two participants. Group channels: only that group's members. A sign-in PIN is never sent back to any client once set, for anyone.</p>
    <h3>7. Retention</h3>
    <p>Team/student/mentor-application data is kept for the current cycle plus a reasonable period for continuity into next year, then reviewed. Mentor Database records are kept longer by design (multi-year outreach), but any person recorded there may ask to have their entry corrected, restricted, or removed at any time — honoured even though it reduces the database's completeness. Activity logs are periodically reviewed and may be pruned.</p>
    <h3>8. Sharing &amp; International Transfers</h3>
    <p>No sale of data, ever. The app runs on Google Apps Script/Sheets and sends email via Gmail, under the Society's own account and Google's standard security/processing terms — this may involve processing outside Kenya, on infrastructure with its own international compliance programme. Optional AI processing is described in Section 5. WG2 leadership may share relevant contact details with other Working Groups strictly for Career Day coordination. Nothing is published publicly without explicit consent.</p>
    <h3>9. Your Rights</h3>
    <p>Under Kenya's Data Protection Act, 2019 (Section 26) and the standards in Section 2, you can: be informed how your data is used (this notice); access it; correct it; object to or restrict processing; request deletion once it's no longer needed; and withdraw consent at any time (a parent may withdraw a student's consent; a mentor may withdraw a shared profile link). Contact the WG2 Data Contact above to exercise any of these. You may also lodge a complaint with the Office of the Data Protection Commissioner (ODPC), Kenya.</p>
    <h3>10. Security</h3>
    <p>Signed, time-limited sign-in tokens rather than stored passwords; every write action is checked against the requester's real access level on the server; PINs are never returned once set; the underlying data store is restricted to the Society's authorised account holders. WG2 will notify affected users, and the ODPC where required, without undue delay if a breach poses a risk to anyone's rights.</p>
    <h3>11. How This Binds You &amp; Changes</h3>
    <p>This Policy binds anyone who submits a public registration form, signs in as a team member, or is recorded in the Mentor Database (regardless of whether they've personally used the app — they keep the full rights in Section 9 regardless). It may be updated as the Society's practices mature; material changes are announced in-app and the effective date above will change. Continued use after an update means you accept it.</p>
    <p style="margin-top:12px;color:#888;">The full document — <b>WG2_Privacy_Policy_2026.docx</b> — is available from WG2 leadership for reference, printing, or sharing outside the app.</p>
  `;

  function openPrivacyModal() {
    $("privacyModalBody").innerHTML = PRIVACY_POLICY_HTML;
    $("privacyModal").classList.remove("hidden");
  }
  function closePrivacyModal() {
    $("privacyModal").classList.add("hidden");
  }

  // ---------------------------------------------------------------------
  // ATTACHMENTS — shared by team chat, DMs, group chats, and Shared Team
  // Files (Docs tab). A File -> data URL, staged on state.pendingAttachment
  // (keyed "chat"/"dm"/"group"), then read and sent as { name, dataUrl } on
  // the next submit — see saveAttachment_ in Code.gs for what happens with
  // it server-side.
  // ---------------------------------------------------------------------
  function readFileAsDataUrl_(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function attachmentChipHtml_(name) {
    return `<span>📎 ${esc(name)}</span> <button type="button" class="attach-remove" data-attach-remove>&times;</button>`;
  }

  // Wires a <input type="file"> + its preview <div> for one chat context
  // (key: "chat" | "dm" | "group"). Selecting a file stages it on
  // state.pendingAttachment[key] and shows a removable chip; it isn't
  // actually read/sent until the form's submit handler calls
  // readFileAsDataUrl_ on it.
  function wireAttachInput_(inputId, previewId, key) {
    const input = $(inputId);
    const preview = $(previewId);
    if (!input || !preview) return;
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (!file) return;
      if (file.size > MAX_ATTACHMENT_BYTES) {
        alert("That file's too big (" + Math.round(file.size / 1024 / 1024) + "MB) — please keep attachments under " + Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024) + "MB.");
        input.value = "";
        return;
      }
      state.pendingAttachment[key] = file;
      preview.innerHTML = attachmentChipHtml_(file.name);
      preview.classList.remove("hidden");
    });
    preview.addEventListener("click", (e) => {
      if (!e.target.closest("[data-attach-remove]")) return;
      state.pendingAttachment[key] = null;
      input.value = "";
      preview.innerHTML = "";
      preview.classList.add("hidden");
    });
  }

  function clearAttachment_(inputId, previewId, key) {
    state.pendingAttachment[key] = null;
    if ($(inputId)) $(inputId).value = "";
    if ($(previewId)) { $(previewId).innerHTML = ""; $(previewId).classList.add("hidden"); }
  }

  function attachmentLinkHtml_(m) {
    if (!m.attachmentUrl) return "";
    return `<div class="chat-attachment"><a href="${escAttr(m.attachmentUrl)}" target="_blank" rel="noopener">📎 ${esc(m.attachmentName || "Attachment")}</a></div>`;
  }

  // ---------------------------------------------------------------------
  // FEEDBACK + TEAM CHAT
  // ---------------------------------------------------------------------
  function openHelpModal() {
    $("helpModal").classList.remove("hidden");
    renderFeedbackList();
    renderChatList();
    populateDmRecipientSelect();
    loadPrivateChat();
    loadGroupChat();
    loadMentorSurvey();
  }
  function closeHelpModal() {
    $("helpModal").classList.add("hidden");
  }
  function setHelpTab(tab) {
    state.helpTab = tab;
    document.querySelectorAll("#helpTabChips [data-helptab]").forEach((b) => b.classList.toggle("active", b.dataset.helptab === tab));
    $("helpFeedbackPane").classList.toggle("hidden", tab !== "feedback");
    $("helpChatPane").classList.toggle("hidden", tab !== "chat");
    $("helpDmPane").classList.toggle("hidden", tab !== "dm");
    $("helpGroupPane").classList.toggle("hidden", tab !== "group");
    $("helpSurveyPane").classList.toggle("hidden", tab !== "survey");
    $("helpFaqPane").classList.toggle("hidden", tab !== "faq");
  }

  function renderFeedbackList() {
    if (!$("feedbackList")) return;
    const items = state.feedback.slice().reverse();
    if (!items.length) {
      $("feedbackList").innerHTML = '<div class="empty">Nothing reported yet.</div>';
      return;
    }
    $("feedbackList").innerHTML = items
      .map((f) => {
        const canResolve = isAdmin() && f.status !== "Resolved";
        return `
      <div class="fb-item" data-fb-id="${escAttr(f.id)}">
        <div class="fbtop">
          <span>${esc(f.who || "Someone")} · ${esc(f.category || "Other")} · ${esc(timeAgo(f.timestamp))}</span>
          <span class="fbstatus ${f.status === "Resolved" ? "Resolved" : "Open"}">${esc(f.status || "Open")}</span>
        </div>
        <div class="fbmsg">${esc(f.message)}${f.screen ? " (" + esc(f.screen) + ")" : ""}</div>
        ${f.reply ? `<div class="fbreply">Reply: ${esc(f.reply)}</div>` : ""}
        ${canResolve ? `
        <div class="fbresolve">
          <input type="text" placeholder="Reply (optional)" data-fb-reply>
          <button data-fb-resolve>Mark Resolved</button>
        </div>` : ""}
      </div>
    `;
      })
      .join("");
  }

  function submitFeedback(e) {
    e.preventDefault();
    const body = {
      action: "submit_feedback",
      category: $("fbCategory").value,
      message: $("fbMessage").value.trim(),
      screen: state.activeTab,
    };
    if (!body.message) return;
    apiPost(body).then((res) => {
      if (!res.ok && !res.queued) { alert(res.error || "Couldn't submit."); return; }
      $("feedbackForm").reset();
      if (res.queued) {
        state.feedback.push({ id: "pending", timestamp: new Date().toISOString(), who: state.session ? state.session.name : "", category: body.category, message: body.message, screen: body.screen, status: "Open" });
        renderFeedbackList();
      } else {
        refresh(false).then(renderFeedbackList);
      }
    });
  }

  function handleFeedbackListClick(e) {
    if (!e.target.matches("[data-fb-resolve]")) return;
    const row = e.target.closest("[data-fb-id]");
    const id = row.dataset.fbId;
    const reply = row.querySelector("[data-fb-reply]").value.trim();
    apiPost({ action: "resolve_feedback", id, reply, status: "Resolved" }).then((res) => {
      if (!res.ok && !res.queued) { alert(res.error || "Couldn't update."); return; }
      if (!res.queued) refresh(false).then(renderFeedbackList);
    });
  }

  function renderChatList() {
    if (!$("chatList")) return;
    if (!state.chat.length) {
      $("chatList").innerHTML = '<div class="empty">No messages yet — say hello.</div>';
      return;
    }
    $("chatList").innerHTML = state.chat
      .map(
        (m) => `
      <div class="chat-item">
        <div class="chattop"><b>${esc(m.who || "Someone")}</b><span>${esc(timeAgo(m.timestamp))}</span></div>
        ${m.message ? `<div class="chatmsg">${esc(m.message)}</div>` : ""}
        ${attachmentLinkHtml_(m)}
      </div>
    `
      )
      .join("");
    $("chatList").scrollTop = $("chatList").scrollHeight;
  }

  function submitChat(e) {
    e.preventDefault();
    const message = $("chatInput").value.trim();
    const file = state.pendingAttachment.chat;
    if (!message && !file) return;
    const btn = e.target.querySelector('button[type="submit"]');
    const send = (attachment) => {
      apiPost({ action: "post_chat", message, attachment }).then((res) => {
        if (btn) btn.disabled = false;
        if (!res.ok && !res.queued) { alert(res.error || "Couldn't send."); return; }
        $("chatInput").value = "";
        clearAttachment_("chatAttachInput", "chatAttachPreview", "chat");
        if (res.queued) {
          state.chat.push({ id: "pending", timestamp: new Date().toISOString(), who: state.session ? state.session.name : "", message, attachmentUrl: "", attachmentName: "" });
          renderChatList();
        } else {
          refresh(false).then(renderChatList);
        }
      });
    };
    if (btn) btn.disabled = true;
    if (file) {
      readFileAsDataUrl_(file).then((dataUrl) => send({ name: file.name, dataUrl })).catch(() => { if (btn) btn.disabled = false; alert("Couldn't read that file."); });
    } else {
      send(undefined);
    }
  }

  // ---------------------------------------------------------------------
  // PRIVATE MESSAGES (1:1 DMs) — separate from the whole-team broadcast
  // Chat above. Server filters to just this person's own messages (see
  // visiblePrivateChat_ in Code.gs); everything below just groups that flat
  // list into per-person conversations for the UI.
  // ---------------------------------------------------------------------
  function populateDmRecipientSelect() {
    const sel = $("dmNewRecipient");
    if (!sel) return;
    const myId = state.session ? state.session.memberId : null;
    const opts = state.team
      .filter((t) => t.id !== myId)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => `<option value="${escAttr(t.id)}">${esc(t.name)}${t.role ? " — " + esc(t.role) : ""}</option>`)
      .join("");
    sel.innerHTML = '<option value="">— message someone new —</option>' + opts;
  }

  function loadPrivateChat() {
    if (DEMO_MODE || !state.session) return;
    apiGet("private_chat").then((res) => {
      if (!res || !res.ok) return;
      state.privateChat = res.privateChat || [];
      renderDmUnreadBadge();
      if (state.dmActiveWith) renderDmThread();
      else renderDmConversations();
    });
  }

  function dmConversations_() {
    const myId = state.session ? state.session.memberId : null;
    const byOther = {};
    state.privateChat.forEach((m) => {
      const otherId = m.fromId === myId ? m.toId : m.fromId;
      const otherName = m.fromId === myId ? m.toName : m.fromName;
      if (!byOther[otherId]) byOther[otherId] = { id: otherId, name: otherName, messages: [] };
      byOther[otherId].messages.push(m);
    });
    return Object.values(byOther)
      .map((c) => {
        c.messages.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
        c.last = c.messages[c.messages.length - 1];
        c.unread = c.messages.filter((m) => m.toId === myId && m.readByRecipient !== "Yes").length;
        return c;
      })
      .sort((a, b) => String(b.last.timestamp).localeCompare(String(a.last.timestamp)));
  }

  function renderDmUnreadBadge() {
    const total = dmConversations_().reduce((sum, c) => sum + c.unread, 0);
    const badge = $("dmUnreadBadge");
    if (!badge) return;
    if (total) { badge.textContent = total; badge.classList.remove("hidden"); } else { badge.classList.add("hidden"); }
  }

  function renderDmConversations() {
    const list = $("dmConversations");
    if (!list) return;
    const convos = dmConversations_();
    if (!convos.length) {
      list.innerHTML = '<div class="empty">No private conversations yet — pick someone above to start one.</div>';
      return;
    }
    list.innerHTML = convos
      .map(
        (c) => `
      <div class="result-item" data-dm-open="${escAttr(c.id)}" data-dm-name="${escAttr(c.name || "")}" style="cursor:pointer;">
        <div>
          <div class="rname">${esc(c.name || "Unknown")} ${c.unread ? `<span class="mentorapp-badge">${c.unread}</span>` : ""}</div>
          <div class="rmeta">${esc((c.last.fromId === (state.session && state.session.memberId) ? "You: " : "") + c.last.message)} &middot; ${esc(timeAgo(c.last.timestamp))}</div>
        </div>
      </div>`
      )
      .join("");
  }

  function openDmThread(id, name) {
    state.dmActiveWith = { id, name };
    $("dmConversationsWrap").classList.add("hidden");
    $("dmThreadWrap").classList.remove("hidden");
    $("dmThreadWithLabel").textContent = "Conversation with " + name;
    renderDmThread();
    apiPost({ action: "mark_private_read", fromId: id }).then(() => loadPrivateChat());
  }

  function closeDmThread() {
    state.dmActiveWith = null;
    $("dmThreadWrap").classList.add("hidden");
    $("dmConversationsWrap").classList.remove("hidden");
    renderDmConversations();
  }

  function renderDmThread() {
    if (!state.dmActiveWith) return;
    const myId = state.session ? state.session.memberId : null;
    const otherId = state.dmActiveWith.id;
    const msgs = state.privateChat
      .filter((m) => m.fromId === otherId || m.toId === otherId)
      .filter((m) => m.fromId === myId || m.toId === myId)
      .slice()
      .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    const box = $("dmMessages");
    if (!msgs.length) {
      box.innerHTML = '<div class="empty">No messages yet — say hello.</div>';
      return;
    }
    box.innerHTML = msgs
      .map(
        (m) => `
      <div class="chat-item">
        <div class="chattop"><b>${esc(m.fromId === myId ? "You" : m.fromName)}</b><span>${esc(timeAgo(m.timestamp))}</span></div>
        ${m.message ? `<div class="chatmsg">${esc(m.message)}</div>` : ""}
        ${attachmentLinkHtml_(m)}
      </div>`
      )
      .join("");
    box.scrollTop = box.scrollHeight;
  }

  function submitDmNew(e) {
    e.preventDefault();
    const sel = $("dmNewRecipient");
    const id = sel.value;
    if (!id) return;
    openDmThread(id, sel.options[sel.selectedIndex].text);
  }

  function submitDm(e) {
    e.preventDefault();
    if (!state.dmActiveWith) return;
    const message = $("dmInput").value.trim();
    const file = state.pendingAttachment.dm;
    if (!message && !file) return;
    const btn = e.target.querySelector('button[type="submit"]');
    const send = (attachment) => {
      apiPost({ action: "send_private_message", toId: state.dmActiveWith.id, message, attachment }).then((res) => {
        if (btn) btn.disabled = false;
        if (!res.ok && !res.queued) { alert(res.error || "Couldn't send."); return; }
        $("dmInput").value = "";
        clearAttachment_("dmAttachInput", "dmAttachPreview", "dm");
        loadPrivateChat();
      });
    };
    if (btn) btn.disabled = true;
    if (file) {
      readFileAsDataUrl_(file).then((dataUrl) => send({ name: file.name, dataUrl })).catch(() => { if (btn) btn.disabled = false; alert("Couldn't read that file."); });
    } else {
      send(undefined);
    }
  }

  function handleDmConversationsClick(e) {
    const row = e.target.closest("[data-dm-open]");
    if (!row) return;
    openDmThread(row.dataset.dmOpen, row.dataset.dmName);
  }

  // ---------------------------------------------------------------------
  // GROUP CHATS — auto-membership channels (zone team, Class Teachers,
  // Leads & Interns). Membership comes straight from the server (see
  // myGroupIds_ in Code.gs) — nothing to configure client-side. "Unread" is
  // a lightweight localStorage-only concept (last-seen timestamp per group,
  // never sent to the server) since group read-receipts across many people
  // aren't worth a schema change for this.
  // ---------------------------------------------------------------------
  function groupLabel_(id) {
    if (id === "class-teachers") return "Class Teachers";
    if (id === "leads-interns") return "Leads & Interns";
    const zone = id.replace("zone-", "");
    return `Zone ${zone}${ZONE_NAMES[zone] ? " — " + ZONE_NAMES[zone] : ""}`;
  }

  function groupLastSeen_() {
    try { return JSON.parse(localStorage.getItem("wg2_group_lastseen") || "{}"); } catch (e) { return {}; }
  }
  function markGroupSeen_(groupId) {
    const seen = groupLastSeen_();
    seen[groupId] = new Date().toISOString();
    try { localStorage.setItem("wg2_group_lastseen", JSON.stringify(seen)); } catch (e) {}
  }

  function loadGroupChat() {
    if (DEMO_MODE || !state.session) return;
    apiGet("group_chat").then((res) => {
      if (!res || !res.ok) return;
      state.myGroups = res.myGroups || [];
      state.groupChat = res.groupChat || [];
      renderGroupUnreadBadge();
      if (state.activeGroup) renderGroupThread();
      else renderGroupList();
    });
  }

  function renderGroupUnreadBadge() {
    const seen = groupLastSeen_();
    const total = state.myGroups.reduce((sum, gid) => {
      const last = seen[gid];
      return sum + state.groupChat.filter((m) => m.groupId === gid && (!last || m.timestamp > last)).length;
    }, 0);
    const badge = $("groupUnreadBadge");
    if (!badge) return;
    if (total) { badge.textContent = total; badge.classList.remove("hidden"); } else { badge.classList.add("hidden"); }
  }

  function renderGroupList() {
    const list = $("groupList");
    if (!list) return;
    if (!state.myGroups.length) {
      list.innerHTML = '<div class="empty">No group applies to your current role yet.</div>';
      return;
    }
    const seen = groupLastSeen_();
    list.innerHTML = state.myGroups
      .map((gid) => {
        const msgs = state.groupChat.filter((m) => m.groupId === gid).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        const last = msgs[msgs.length - 1];
        const unread = msgs.filter((m) => !seen[gid] || m.timestamp > seen[gid]).length;
        return `
        <div class="result-item" data-group-open="${escAttr(gid)}" style="cursor:pointer;">
          <div>
            <div class="rname">${esc(groupLabel_(gid))} ${unread ? `<span class="mentorapp-badge">${unread}</span>` : ""}</div>
            <div class="rmeta">${last ? esc(last.who + ": " + last.message) + " &middot; " + esc(timeAgo(last.timestamp)) : "No messages yet — say hello."}</div>
          </div>
        </div>`;
      })
      .join("");
  }

  function openGroupThread(gid) {
    state.activeGroup = gid;
    $("groupListWrap").classList.add("hidden");
    $("groupThreadWrap").classList.remove("hidden");
    $("groupThreadLabel").textContent = groupLabel_(gid);
    markGroupSeen_(gid);
    renderGroupThread();
    renderGroupUnreadBadge();
  }
  function closeGroupThread() {
    state.activeGroup = null;
    $("groupThreadWrap").classList.add("hidden");
    $("groupListWrap").classList.remove("hidden");
    renderGroupList();
  }

  function renderGroupThread() {
    if (!state.activeGroup) return;
    const myId = state.session ? state.session.memberId : null;
    const msgs = state.groupChat
      .filter((m) => m.groupId === state.activeGroup)
      .slice()
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const box = $("groupMessages");
    if (!msgs.length) {
      box.innerHTML = '<div class="empty">No messages yet — say hello.</div>';
      return;
    }
    box.innerHTML = msgs
      .map(
        (m) => `
      <div class="chat-item">
        <div class="chattop"><b>${esc(m.whoId === myId ? "You" : m.who)}</b><span>${esc(timeAgo(m.timestamp))}</span></div>
        ${m.message ? `<div class="chatmsg">${esc(m.message)}</div>` : ""}
        ${attachmentLinkHtml_(m)}
      </div>`
      )
      .join("");
    box.scrollTop = box.scrollHeight;
  }

  function submitGroupMessage(e) {
    e.preventDefault();
    if (!state.activeGroup) return;
    const message = $("groupInput").value.trim();
    const file = state.pendingAttachment.group;
    if (!message && !file) return;
    const btn = e.target.querySelector('button[type="submit"]');
    const send = (attachment) => {
      apiPost({ action: "post_group_message", groupId: state.activeGroup, message, attachment }).then((res) => {
        if (btn) btn.disabled = false;
        if (!res.ok && !res.queued) { alert(res.error || "Couldn't send."); return; }
        $("groupInput").value = "";
        clearAttachment_("groupAttachInput", "groupAttachPreview", "group");
        markGroupSeen_(state.activeGroup);
        loadGroupChat();
      });
    };
    if (btn) btn.disabled = true;
    if (file) {
      readFileAsDataUrl_(file).then((dataUrl) => send({ name: file.name, dataUrl })).catch(() => { if (btn) btn.disabled = false; alert("Couldn't read that file."); });
    } else {
      send(undefined);
    }
  }

  function handleGroupListClick(e) {
    const row = e.target.closest("[data-group-open]");
    if (!row) return;
    openGroupThread(row.dataset.groupOpen);
  }

  // ---------------------------------------------------------------------
  // MENTOR FEEDBACK SURVEY — filled in-app on/after Career Day. Prompted by
  // the Society's own Mentors' Feedback Questionnaire lineage (2018-2024).
  // ---------------------------------------------------------------------
  const SURVEY_ORG_RATINGS = [
    ["ratingCommunicationPrior", "Communication before the event"],
    ["ratingTimeFormatInfo", "Info given about time & format"],
    ["ratingParking", "Parking arrangements"],
    ["ratingRoomSetup", "Your cluster's room/venue setup"],
    ["ratingSupport", "Support from your Zone Coordinator / Cluster Lead"],
    ["ratingSessionDuration", "Time given to interact with students"],
    ["ratingOverallOrganisation", "Overall organisation of Career Day"],
  ];
  const SURVEY_STUDENT_RATINGS = [
    ["ratingStudentQuestions", "Quality of students' questions"],
    ["ratingStudentCommunication", "Students' communication skills"],
    ["ratingStudentBehaviour", "Students' behaviour & presentation"],
    ["ratingStudentEngagement", "Students' overall interest & engagement"],
  ];
  const SURVEY_RATING_SCALE = [["5", "Excellent"], ["4", "Above Average"], ["3", "Average"], ["2", "Below Average"], ["1", "Needs Improvement"]];
  const SURVEY_ALL_RATINGS = SURVEY_ORG_RATINGS.concat(SURVEY_STUDENT_RATINGS);
  let surveyFieldsBuilt = false;

  function ratingFieldHtml_(id, label) {
    const opts = SURVEY_RATING_SCALE.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("");
    return `<div class="field"><label>${esc(label)}</label><select id="sv_${id}"><option value="">— choose one —</option>${opts}</select></div>`;
  }

  function buildSurveyFieldsOnce() {
    if (surveyFieldsBuilt) return;
    $("svRatingsOrg").innerHTML = SURVEY_ORG_RATINGS.map(([id, label]) => ratingFieldHtml_(id, label)).join("");
    $("svRatingsStudents").innerHTML = SURVEY_STUDENT_RATINGS.map(([id, label]) => ratingFieldHtml_(id, label)).join("");
    surveyFieldsBuilt = true;
  }

  function loadMentorSurvey() {
    if (DEMO_MODE || !state.session) return;
    buildSurveyFieldsOnce();
    apiGet("mentor_survey").then((res) => {
      if (!res || !res.ok) return;
      state.mentorSurveyMine = res.mine || null;
      if (res.responses) state.mentorSurveyResponses = res.responses;
      renderSurveyPane();
    });
  }

  function renderSurveyPane() {
    const mine = state.mentorSurveyMine;
    $("surveyAlreadyNote").classList.toggle("hidden", !mine);
    if (mine) {
      $("svAttended").value = mine.attended || "";
      $("svMentorsInCluster").value = mine.mentorsInCluster || "";
      $("svStudentsMet").value = mine.studentsMet || "";
      SURVEY_ALL_RATINGS.forEach(([id]) => { const el = $("sv_" + id); if (el) el.value = mine[id] || ""; });
      $("svAttendNextYear").value = mine.attendNextYear || "";
      $("svInternshipsAvailable").value = mine.internshipsAvailable || "";
      $("svInternshipListings").value = mine.internshipListings || "";
      $("svJobShadowing").value = mine.jobShadowing || "";
      $("svOpenToFutureNetwork").value = mine.openToFutureNetwork || "";
      $("svCommentsExpand").value = mine.commentsExpand || "";
      $("svCommentsForMentors").value = mine.commentsForMentors || "";
      $("svCommentsForStudents").value = mine.commentsForStudents || "";
      $("svCommentsOther").value = mine.commentsOther || "";
    }
    const admin = isAdmin();
    $("surveyAdminSection").classList.toggle("hidden", !admin);
    if (admin) {
      renderSurveyAnalytics();
      renderSurveyNonResponders();
    }
  }

  function submitMentorSurveyForm(e) {
    e.preventDefault();
    const body = { action: "submit_mentor_survey" };
    body.attended = $("svAttended").value;
    body.mentorsInCluster = $("svMentorsInCluster").value.trim();
    body.studentsMet = $("svStudentsMet").value.trim();
    SURVEY_ALL_RATINGS.forEach(([id]) => { body[id] = $("sv_" + id).value; });
    body.attendNextYear = $("svAttendNextYear").value;
    body.internshipsAvailable = $("svInternshipsAvailable").value;
    body.internshipListings = $("svInternshipListings").value.trim();
    body.jobShadowing = $("svJobShadowing").value;
    body.openToFutureNetwork = $("svOpenToFutureNetwork").value;
    body.commentsExpand = $("svCommentsExpand").value.trim();
    body.commentsForMentors = $("svCommentsForMentors").value.trim();
    body.commentsForStudents = $("svCommentsForStudents").value.trim();
    body.commentsOther = $("svCommentsOther").value.trim();

    const resultEl = $("surveyResult");
    apiPost(body).then((res) => {
      if (!res.ok && !res.queued) {
        resultEl.textContent = res.error || "Couldn't submit — please try again.";
        resultEl.style.color = "var(--red)";
        return;
      }
      resultEl.textContent = res.queued ? "Saved offline — will sync once back online." : "Thank you — your response has been saved.";
      resultEl.style.color = "var(--green)";
      if (!res.queued) loadMentorSurvey();
    });
  }

  function renderSurveyAnalytics() {
    const responses = state.mentorSurveyResponses;
    const el = $("surveyAnalytics");
    if (!responses.length) {
      el.innerHTML = '<div class="empty">No responses yet.</div>';
      return;
    }
    const rows = SURVEY_ALL_RATINGS.map(([id, label]) => {
      const vals = responses.map((r) => Number(r[id])).filter((n) => n >= 1 && n <= 5);
      const avg = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length) : null;
      return `<tr><td>${esc(label)}</td><td>${avg !== null ? avg.toFixed(1) + " / 5" : "—"}</td><td>${vals.length}</td></tr>`;
    }).join("");
    const nextYear = { Yes: 0, No: 0, Maybe: 0 };
    responses.forEach((r) => { if (nextYear[r.attendNextYear] !== undefined) nextYear[r.attendNextYear]++; });
    el.innerHTML = `
      <div class="summary" style="margin-bottom:10px;">
        <div><b>${responses.length}</b><span>Responses</span></div>
        <div><b>${nextYear.Yes}</b><span>Likely to return</span></div>
        <div><b>${responses.filter((r) => r.internshipsAvailable === "Yes").length}</b><span>Have internships</span></div>
      </div>
      <table class="dash-table"><thead><tr><th>Question</th><th>Average</th><th>N</th></tr></thead><tbody>${rows}</tbody></table>
    `;
  }

  function surveyMentorRoster_() {
    return state.team.filter((t) => ["Mentor", "Cluster Lead", "Sub-Lead", "Zone Coordinator"].indexOf(t.role) !== -1 && t.status !== "Unconfirmed");
  }

  function renderSurveyNonResponders() {
    const responded = new Set(state.mentorSurveyResponses.map((r) => r.teamMemberId));
    const missing = surveyMentorRoster_().filter((t) => !responded.has(t.id));
    const el = $("surveyNonResponders");
    if (!missing.length) {
      el.innerHTML = '<div class="empty">Everyone on the mentor roster has responded.</div>';
      return;
    }
    el.innerHTML = missing
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => `<div class="result-item"><div><div class="rname">${esc(t.name)}</div><div class="rmeta">${esc(t.role || "")}${t.cluster ? " · " + esc(t.cluster) : ""}${t.email ? " · " + esc(t.email) : ""}</div></div></div>`)
      .join("");
  }

  // ---------------------------------------------------------------------
  // SEND UPDATE — email a segment (team by zone/role/cluster, or a class)
  // straight from the app, via the WG2 Google account. See Code.gs
  // sendSegmentEmail_ for how recipients get resolved server-side.
  // ---------------------------------------------------------------------
  function sendSegmentTeamValues(field) {
    if (field === "zone") return uniqueSorted(state.team.map((t) => t.zone));
    if (field === "role") return uniqueSorted(state.team.map((t) => t.role));
    if (field === "cluster") return state.clusters.map((c) => ({ v: c.id, label: c.id + " — " + c.name }));
    return [];
  }

  function populateSendSegmentUI() {
    const type = $("sendSegmentType").value;
    $("sendTeamFields").classList.toggle("hidden", type !== "team");
    $("sendClassFields").classList.toggle("hidden", type !== "class");

    const field = $("sendTeamFilterField").value;
    const valueSel = $("sendTeamFilterValue");
    $("sendTeamFilterValueWrap").classList.toggle("hidden", field === "all");
    if (field !== "all") {
      const keepValue = valueSel.value;
      const opts = sendSegmentTeamValues(field);
      valueSel.innerHTML = opts
        .map((o) => (typeof o === "string" ? `<option value="${escAttr(o)}">${esc(o)}</option>` : `<option value="${escAttr(o.v)}">${esc(o.label)}</option>`))
        .join("");
      const values = opts.map((o) => (typeof o === "string" ? o : o.v));
      if (values.indexOf(keepValue) !== -1) valueSel.value = keepValue;
    }

    const classSel = $("sendClassSelect");
    const keepClass = classSel.value;
    const classes = uniqueSorted(state.students.map((s) => s.classStream));
    classSel.innerHTML = classes.map((c) => `<option value="${escAttr(c)}">${esc(c)}</option>`).join("");
    if (classes.indexOf(keepClass) !== -1) classSel.value = keepClass;

    renderSendRecipientPreview();
  }

  function renderSendRecipientPreview() {
    const type = $("sendSegmentType").value;
    const box = $("sendRecipientPreview");
    if (type === "team") {
      const field = $("sendTeamFilterField").value;
      const value = field === "all" ? "" : $("sendTeamFilterValue").value;
      const matched = state.team.filter((t) => {
        if (field === "all") return true;
        if (field === "zone") return (t.zone || "") === value;
        if (field === "role") return t.role === value;
        if (field === "cluster") return (t.cluster || "").indexOf(value) !== -1;
        return false;
      });
      const withEmail = matched.filter((t) => t.email);
      box.textContent = matched.length
        ? withEmail.length + " of " + matched.length + " matched team member(s) have an email on file — they'll be BCC'd."
        : "No team members match this filter yet.";
    } else {
      const cls = $("sendClassSelect").value;
      const roster = state.students.filter((s) => s.classStream === cls);
      const withEmail = roster.find((s) => s.teacherEmail);
      box.textContent = roster.length
        ? withEmail
          ? "Sends to " + withEmail.teacherEmail + " (" + roster.length + " student(s) in this class)."
          : "No class contact email on file yet for " + (cls || "this class") + " — add one at Register → Bulk Import first."
        : "No students registered under this class yet.";
    }
  }

  // Shared by the bulk-import "Email QR Codes" button and the Schedule ->
  // My Class "Email QR Codes to Class Contact" button, so both paths behave
  // identically (same image data, same server call).
  function sendClassEmail(classStream, teacherEmail, students, source) {
    if (!teacherEmail) {
      alert("No class contact email on file for " + classStream + ".");
      return;
    }
    if (DEMO_MODE) {
      alert("Demo mode — connect the backend in config.js to actually send email.");
      return;
    }
    if (!confirm("Email " + students.length + " QR code(s) for " + classStream + " to " + teacherEmail + "?")) return;
    const qrImages = collectQrImages(students);
    apiPost({
      action: "send_segment_email",
      segmentType: "class",
      classStream,
      teacherEmail,
      subject: "WG2 Boma Career Day 2026 — QR Codes for " + classStream,
      message: "Attached are the QR codes for every student registered under " + classStream + ". Each code is unique to that student — please keep the right code with the right learner when printing or forwarding. Students should carry their printed code (or a screenshot) and present it at Check-In on the day.",
      qrImages,
    })
      .then((res) => {
        if (!res.ok) throw new Error(res.error || "Send failed");
        alert("Sent to " + (res.recipients ? res.recipients.join(", ") : teacherEmail) + ".");
      })
      .catch((e) => alert("Couldn't send: " + e.message + (navigator.onLine ? "" : " (you're offline — try again once connected; nothing was queued for email sends, unlike check-ins/registrations)")));
  }

  function submitSendSegment() {
    const type = $("sendSegmentType").value;
    const subject = $("sendSubject").value.trim();
    const message = $("sendMessage").value.trim();
    if (!subject || !message) {
      alert("Add a subject and a message first.");
      return;
    }
    if (DEMO_MODE) {
      alert("Demo mode — connect the backend in config.js to actually send email.");
      return;
    }
    const btn = $("sendSegmentBtn");
    const body = { action: "send_segment_email", subject, message };
    let confirmText = "";
    if (type === "team") {
      body.segmentType = "team";
      body.filterField = $("sendTeamFilterField").value;
      body.filterValue = body.filterField === "all" ? "" : $("sendTeamFilterValue").value;
      confirmText = "Send this to " + (body.filterField === "all" ? "everyone with an email on file" : body.filterField + " = " + body.filterValue) + "?";
    } else {
      const cls = $("sendClassSelect").value;
      const roster = state.students.filter((s) => s.classStream === cls);
      const withEmail = roster.find((s) => s.teacherEmail);
      if (!withEmail) {
        alert("No class contact email on file for " + cls + " yet.");
        return;
      }
      body.segmentType = "class";
      body.classStream = cls;
      body.teacherEmail = withEmail.teacherEmail;
      confirmText = "Send this to " + withEmail.teacherEmail + " (" + cls + ")?";
    }
    if (!confirm(confirmText)) return;
    btn.disabled = true;
    btn.textContent = "Sending…";
    apiPost(body)
      .then((res) => {
        btn.disabled = false;
        btn.textContent = "Send Email";
        if (!res.ok) throw new Error(res.error || "Send failed");
        $("sendResult").textContent = "Sent to " + (res.sent || 1) + " recipient(s).";
        $("sendSubject").value = "";
        $("sendMessage").value = "";
      })
      .catch((e) => {
        btn.disabled = false;
        btn.textContent = "Send Email";
        $("sendResult").textContent = "Couldn't send: " + e.message;
      });
  }

  // ---------------------------------------------------------------------
  // EVENT WIRING
  // ---------------------------------------------------------------------
  document.querySelectorAll(".tab-btn").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

  $("taskSearch").addEventListener("input", (e) => {
    state.taskFilters.q = e.target.value;
    renderTaskList();
  });
  $("phaseChips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-phase]");
    if (!b) return;
    state.taskFilters.phase = b.dataset.phase;
    renderTaskChips();
    renderTaskList();
  });
  $("stateChips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-state]");
    if (!b) return;
    state.taskFilters.state = b.dataset.state;
    renderTaskChips();
    renderTaskList();
  });
  $("taskList").addEventListener("click", (e) => {
    const quick = e.target.closest("[data-quickstate]");
    if (quick) {
      cycleState(quick.dataset.quickstate);
      return;
    }
    const card = e.target.closest("[data-task-id]");
    if (card) openTaskModal(card.dataset.taskId);
  });
  $("taskModalCancel").addEventListener("click", closeTaskModal);
  $("taskModalSave").addEventListener("click", saveTask);
  $("addTaskBtn").addEventListener("click", openAddTaskModal);
  $("addTaskCancel").addEventListener("click", closeAddTaskModal);
  $("addTaskSave").addEventListener("click", submitAddTask);

  $("teamSearch").addEventListener("input", (e) => {
    state.teamFilters.q = e.target.value;
    renderTeamList();
  });
  $("roleChips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-role]");
    if (!b) return;
    state.teamFilters.role = b.dataset.role;
    renderTeamChips();
    renderTeamList();
  });
  $("teamList").addEventListener("click", (e) => {
    const card = e.target.closest("[data-person-id]");
    if (card) openTeamModal(card.dataset.personId);
  });
  $("teamModalCancel").addEventListener("click", closeTeamModal);
  $("teamModalSave").addEventListener("click", saveTeam);
  $("teamModalQr").addEventListener("click", () => {
    const p = state.team.find((t) => t.id === state.openTeamId);
    if (p) openQrLookup(p.id, p.name, p.email);
  });
  $("qrLookupClose").addEventListener("click", closeQrLookup);
  $("qrLookupDownload").addEventListener("click", downloadLookupQr);
  $("qrLookupEmail").addEventListener("click", emailLookupQr);
  $("findResults").addEventListener("click", (e) => {
    const qrBtn = e.target.closest("[data-qr-id]");
    if (qrBtn) { openQrLookup(qrBtn.dataset.qrId, qrBtn.dataset.qrName, qrBtn.dataset.qrEmail); return; }
    const spBtn = e.target.closest("[data-spillover-id]");
    if (spBtn) toggleStudentSpillover_(spBtn.dataset.spilloverId, spBtn.dataset.spilloverName, spBtn.dataset.spilloverCurrent === "1");
  });

  whoamiBtn.addEventListener("click", openWhoami);
  $("openCareersGuideBtnApp").addEventListener("click", () => showCareersGuide_("app"));
  $("whoamiCancel").addEventListener("click", closeWhoami);
  $("whoamiSave").addEventListener("click", saveWhoami);
  $("accountClose").addEventListener("click", closeAccountModal);
  $("accountSaveDetails").addEventListener("click", saveMyDetails);
  $("accountChangePin").addEventListener("click", changeMyPin);
  $("accountSignOut").addEventListener("click", signOutFromAccount);
  $("accountDeleteBtn").addEventListener("click", openDeleteAccountModal);
  $("deleteAccountCancel").addEventListener("click", closeDeleteAccountModal);
  $("deleteAccountConfirm").addEventListener("click", confirmDeleteMyAccount);

  // ---- Register ----
  $("regTypeChips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-regtype]");
    if (b) setRegType(b.dataset.regtype);
  });
  $("studentForm").addEventListener("submit", submitStudentForm);
  $("mentorForm").addEventListener("submit", submitMentorForm);
  $("mfRole").addEventListener("change", updateMfModeVisibility);
  $("mfMode").addEventListener("change", updateMfModeVisibility);
  $("amRole").addEventListener("change", updateAmModeVisibility);
  $("qrDownloadBtn").addEventListener("click", downloadQr);
  if ($("qrPrintScheduleBtn")) $("qrPrintScheduleBtn").addEventListener("click", printOwnSchedule);
  $("qrRegisterAnotherBtn").addEventListener("click", registerAnother);
  $("downloadTasksCsvBtn").addEventListener("click", () => {
    downloadCSV(
      "wg2-tasks-" + todayStr() + ".csv",
      ["id", "phase", "task", "owner", "state", "status", "due", "ref", "notes"],
      filteredTasks()
    );
  });
  $("downloadTeamCsvBtn").addEventListener("click", () => {
    downloadCSV(
      "wg2-team-" + todayStr() + ".csv",
      ["id", "name", "role", "zone", "cluster", "phone", "email", "status", "notes"],
      filteredTeam()
    );
  });

  // ---- Check-in ----
  $("checkinModeChips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-mode]");
    if (b) setCheckinMode(b.dataset.mode);
  });
  $("scanStartBtn").addEventListener("click", () => (state.scanning ? stopScanning() : startScanning()));
  $("checkinSearch").addEventListener("input", renderCheckinSearch);
  $("checkinSearchResults").addEventListener("click", (e) => {
    const b = e.target.closest("[data-checkin-id]");
    if (!b) return;
    const person = findPersonById(b.dataset.checkinId);
    if (person) openConfirmModal(person);
  });
  $("walkinForm").addEventListener("submit", submitWalkinForm);
  $("confirmCancel").addEventListener("click", closeConfirmModal);
  $("confirmSave").addEventListener("click", saveCheckin);

  // ---- Bulk import ----
  $("bulkSubmitBtn").addEventListener("click", submitBulkImport);
  $("bulkPrintQrBtn").addEventListener("click", printLastBulkBatch);
  $("bulkEmailQrBtn").addEventListener("click", emailLastBulkBatch);

  // ---- Schedule ----
  $("scheduleModeChips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-smode]");
    if (b) setScheduleMode(b.dataset.smode);
  });
  $("classPrintQrBtn").addEventListener("click", () => {
    const cls = $("classSelect").value;
    const roster = state.students.filter((s) => s.classStream === cls);
    openQrBatchPrintView(roster, "QR Codes — " + cls, roster.length + " student(s)");
  });
  $("classDownloadCsvBtn").addEventListener("click", () => {
    const cls = $("classSelect").value;
    const roster = state.students.filter((s) => s.classStream === cls);
    // Career Day ID only — never admission number (that's the school's own
    // private student record, not WG2's to export).
    downloadCSV(
      "wg2-class-" + (cls || "roster").replace(/[^a-z0-9]+/gi, "-") + "-" + todayStr() + ".csv",
      ["id", "name", "classStream", "cohort", "status", "round1", "round2", "round3", "round4"],
      roster
    );
  });
  $("classEmailQrBtn").addEventListener("click", () => {
    const cls = $("classSelect").value;
    const roster = state.students.filter((s) => s.classStream === cls);
    if (!roster.length) {
      alert("No students registered under this class yet.");
      return;
    }
    let teacherEmail = (roster.find((s) => s.teacherEmail) || {}).teacherEmail;
    if (!teacherEmail) {
      teacherEmail = (prompt("No class contact email on file for " + cls + ". Enter one to send to now (this won't be saved to the roster):") || "").trim();
      if (!teacherEmail) return;
    }
    sendClassEmail(cls, teacherEmail, roster, "schedule-my-class");
  });

  // ---- Dashboard: Mentor Status Board ----
  // ---- Dashboard: Needs Attention ----
  if ($("attentionPanel")) $("attentionPanel").addEventListener("click", handleAttentionClick);

  // ---- Search / command palette ----
  if ($("openSearchBtn")) {
    $("openSearchBtn").addEventListener("click", openSearchModal);
    $("searchCloseBtn").addEventListener("click", closeSearchModal);
    $("searchInput").addEventListener("input", renderSearchResults_);
    $("searchInput").addEventListener("keydown", handleSearchKeydown_);
    $("searchResults").addEventListener("click", handleSearchResultClick_);
  }

  // ---- Reports tab ----
  if ($("reportGenerateBtn")) {
    $("reportGenerateBtn").addEventListener("click", applyReportQueryText_);
    $("reportSourceChips").addEventListener("click", (e) => {
      const b = e.target.closest("[data-rsource]");
      if (!b) return;
      setReportSource_(b.dataset.rsource);
      runReport_();
    });
    $("reportRunBtn").addEventListener("click", runReport_);
    $("reportTableWrap").addEventListener("click", handleReportTableClick_);
    $("downloadReportCsvBtn").addEventListener("click", downloadReportCsv_);
    $("reportCoverageBtn").addEventListener("click", renderReportCoverageAnalysis_);
    $("reportBackToTableBtn").addEventListener("click", showReportTableView_);
    $("copyCoverageBtn").addEventListener("click", copyCoverageAsText_);
    if ($("reportPreviewChips")) {
      $("reportPreviewChips").addEventListener("click", (e) => {
        const b = e.target.closest("[data-rpmode]");
        if (b) setReportPreviewMode_(b.dataset.rpmode);
      });
    }
  }

  $("mentorOpsChips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-mzone]");
    if (!b) return;
    state.mentorOpsZone = b.dataset.mzone;
    renderMentorOps();
  });
  $("downloadMentorOpsCsvBtn").addEventListener("click", () => {
    const rows = filteredMentorOps().map((t) => {
      const s = mentorOpsStatus_(t);
      return { name: t.name, zone: t.zone || "", cluster: t.cluster || "", mode: t.mode || "In-person", status: s.label, sessionLink: t.sessionLink || "" };
    });
    downloadCSV("wg2-mentor-status-" + todayStr() + ".csv", ["name", "zone", "cluster", "mode", "status", "sessionLink"], rows);
  });

  // ---- Dashboard: Capacity & Coverage ----
  $("dashCapacityChips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-cfilter]");
    if (b) setCapacityFilter(b.dataset.cfilter);
  });

  // ---- Dashboard: Session Coverage ----
  if ($("sessionCoverageTable")) $("sessionCoverageTable").addEventListener("click", handleSessionCoverageClick_);
  // ---- My Day: Sessions that need filling (Interns) — same click handler,
  // same data-recruit-* attributes, different container ----
  if ($("myDayPanel")) $("myDayPanel").addEventListener("click", handleSessionCoverageClick_);
  if ($("myDayPanel")) $("myDayPanel").addEventListener("click", handleMyDayLeadershipClick_);
  if ($("leadershipCandidatesList")) $("leadershipCandidatesList").addEventListener("click", handleLeadershipCandidatesClick_);
  // ---- Cluster Command Center (Dashboard exec view + Intern My Day) ----
  if ($("execClusterCommand")) $("execClusterCommand").addEventListener("click", (e) => handleClusterCommandClick_(e, "execClusterCommand"));
  if ($("myDayPanel")) $("myDayPanel").addEventListener("click", (e) => {
    if (e.target.closest("#internClusterCommand")) handleClusterCommandClick_(e, "internClusterCommand");
    if (e.target.closest("#clusterLeadCommand")) handleClusterCommandClick_(e, "clusterLeadCommand");
  });
  // ---- Mentors & Clusters Hub ----
  if ($("hubClusterCommand")) $("hubClusterCommand").addEventListener("click", (e) => handleClusterCommandClick_(e, "hubClusterCommand"));
  if ($("hubOccupancyGrid")) $("hubOccupancyGrid").addEventListener("click", handleOccupancyGridClick_);
  // ---- Role guide banner — one-tap jump to Brief tab's "Your Orientation"
  // section, from wherever a role actually lands (exec Dashboard or My Day) ----
  if ($("dashRoleBanner")) $("dashRoleBanner").addEventListener("click", (e) => { if (e.target.closest("[data-jump-role-guide]")) jumpToRoleGuide_(); });
  if ($("myDayPanel")) $("myDayPanel").addEventListener("click", (e) => { if (e.target.closest("[data-jump-role-guide]")) jumpToRoleGuide_(); });
  $("downloadAttendanceCsvBtn").addEventListener("click", () => {
    downloadCSV(
      "wg2-attendance-" + todayStr() + ".csv",
      ["timestamp", "type", "personId", "personName", "round", "room", "method", "checkedInBy"],
      state.attendance
    );
  });
  $("downloadCapacityCsvBtn").addEventListener("click", () => {
    const rows = clusterStats().map((s) => ({
      cluster: s.cluster.id + " — " + s.cluster.name,
      zone: s.cluster.zone,
      interested: s.interested,
      dayCapacity: s.dayCapacity,
      allocated: s.allocated,
      mentors: s.mentors,
      status: FLAG_LABEL[s.flag],
    }));
    downloadCSV("wg2-capacity-" + todayStr() + ".csv", ["cluster", "zone", "interested", "dayCapacity", "allocated", "mentors", "status"], rows);
  });

  // ---- Dashboard: Send Update ----
  $("sendSegmentType").addEventListener("change", populateSendSegmentUI);
  $("sendTeamFilterField").addEventListener("change", populateSendSegmentUI);
  $("sendTeamFilterValue").addEventListener("change", renderSendRecipientPreview);
  $("sendClassSelect").addEventListener("change", renderSendRecipientPreview);
  $("sendSegmentBtn").addEventListener("click", submitSendSegment);
  $("findSearch").addEventListener("input", renderFindResults);
  $("classSelect").addEventListener("change", renderClassPane);
  $("roomPane").addEventListener("click", (e) => {
    const b = e.target.closest("[data-roomcluster]");
    if (!b) return;
    document.querySelectorAll("#roomClusterChips [data-roomcluster]").forEach((x) => x.classList.toggle("active", x === b));
    const cluster = state.clusters.find((c) => c.id === b.dataset.roomcluster);
    if (!cluster) return;
    let html = document.getElementById("roomClusterChips").outerHTML;
    for (let r = 1; r <= 4; r++) {
      const key = "round" + r;
      const inRound = state.students.filter((s) => s[key] === cluster.id);
      html += `<div class="group-label">Round ${r} &middot; ${inRound.length} student(s)</div>`;
      html += inRound.length
        ? inRound.map((s) => `<div class="checkin-row"><div><div class="cname">${esc(s.name)}</div><div class="cmeta">${esc(s.id)} &middot; ${esc(s.cohort)}</div></div></div>`).join("")
        : '<div class="empty">No one assigned here yet for this round.</div>';
    }
    $("roomRounds").innerHTML = html;
  });

  // ---- Allocation ----
  $("runAllocationBtn").addEventListener("click", runAllocationClick);

  // ---- Login ----
  $("loginSubmitBtn").addEventListener("click", submitLogin);
  $("loginPin").addEventListener("keydown", (e) => { if (e.key === "Enter") submitLogin(e); });
  $("loginName").addEventListener("keydown", (e) => { if (e.key === "Enter") $("loginPin").focus(); });

  // ---- Public Mentor Registration (no sign-in) ----
  $("openMentorRegisterBtn").addEventListener("click", showPublicMentorRegister);
  $("closeMentorRegisterBtn").addEventListener("click", hidePublicMentorRegister);
  $("pubMentorBackToLoginBtn").addEventListener("click", hidePublicMentorRegister);
  $("pmExbomarian").addEventListener("change", updateExbomarianConditional_);
  $("pubMentorForm").addEventListener("submit", submitPublicMentorRegister);
  document.querySelectorAll("#publicMentorScreen .pubreg-check-row input[type=checkbox]").forEach((input) => {
    input.addEventListener("change", () => input.closest(".pubreg-check-row").classList.toggle("checked", input.checked));
  });

  // ---- Public Parent-Assisted Student Registration (no sign-in) ----
  $("openStudentRegisterBtn").addEventListener("click", showPublicStudentRegister);
  $("closeStudentRegisterBtn").addEventListener("click", hidePublicStudentRegister);
  $("pubStudentBackToLoginBtn").addEventListener("click", hidePublicStudentRegister);
  $("pubStudentForm").addEventListener("submit", submitPublicStudentRegister);

  // ---- Public Edit Career Choices (no sign-in) ----
  $("openEditChoicesBtn").addEventListener("click", showPublicEditChoices_);
  $("closeEditChoicesBtn").addEventListener("click", hidePublicEditChoices_);
  $("peLookupBtn").addEventListener("click", lookupPublicStudent_);
  $("peBackToLookupBtn").addEventListener("click", resetPublicEditForm_);
  $("peSaveBtn").addEventListener("click", savePublicStudentChoices_);

  // ---- Public Careers & Clusters Guide (no sign-in) ----
  $("openCareersGuideBtn").addEventListener("click", showCareersGuide_);
  $("openCareersGuideBtnInline").addEventListener("click", (e) => { e.preventDefault(); showCareersGuide_(true); });
  $("closeCareersGuideBtn").addEventListener("click", hideCareersGuide_);
  // ---- Discover Your Career quiz ----
  $("openCareerQuizBtn").addEventListener("click", () => showCareerQuiz_());
  $("openCareerQuizBtnInline").addEventListener("click", (e) => { e.preventDefault(); showCareerQuiz_(true); });
  $("closeCareerQuizBtn").addEventListener("click", hideCareerQuiz_);
  $("cqBody").addEventListener("click", handleCareerQuizBodyClick_);
  $("cgSearch").addEventListener("input", renderCareersGuideContent_);
  $("cgZoneChips").addEventListener("click", handleCareersGuideZoneChipClick_);
  $("cgDownloadGuideBtn").addEventListener("click", downloadCareerGuidePdf_);
  $("cgDownloadAddendumBtn").addEventListener("click", downloadCareerBriefsAddendumPdf_);
  // ---- Cluster Session Guide (all signed-in roles) ----
  if ($("guideSearch")) $("guideSearch").addEventListener("input", renderGuideTab_);
  if ($("guideZoneChips")) $("guideZoneChips").addEventListener("click", handleGuideZoneChipClick_);
  if ($("guideList")) $("guideList").addEventListener("click", handleGuideListClick_);
  if ($("guideMyClusterPanel")) $("guideMyClusterPanel").addEventListener("click", handleGuideListClick_);

  $("briefOpenWebBtn").addEventListener("click", openTeamBriefWeb_);
  $("briefOpenPdfBtn").addEventListener("click", downloadTeamBriefPdf_);
  $("closeBriefWebBtn").addEventListener("click", closeTeamBriefWeb_);
  $("shareBriefWebBtn").addEventListener("click", () => window.open("WG2_Team_Brief.html", "_blank"));

  // ---- Team Access (Lead/Assistant Lead only) ----
  $("addMemberForm").addEventListener("submit", submitAddMember);
  $("teamAccessList").addEventListener("click", handleAccessRowClick);

  // ---- Mentor Applications (Lead/Assistant Lead only) ----
  $("mentorApplicationsList").addEventListener("click", handleMentorApplicationsClick);
  $("mentorBulkSubmitBtn").addEventListener("click", submitMentorBulkImport_);
  $("mentorDbList").addEventListener("click", handleMentorDatabaseClick);
  $("mentorDbSearch").addEventListener("input", () => { state.mentorDbShowCount = 30; renderMentorDatabaseList(); });
  $("mentorDbClusterFilter").addEventListener("change", () => { state.mentorDbShowCount = 30; renderMentorDatabaseList(); });
  $("mentorDbStatusFilter").addEventListener("change", () => { state.mentorDbShowCount = 30; renderMentorDatabaseList(); });
  $("mentorDbShowMoreBtn").addEventListener("click", () => { state.mentorDbShowCount += 30; renderMentorDatabaseList(); });

  // ---- Room Assignments ----
  $("roomAssignList").addEventListener("click", handleRoomRowClick);

  // ---- Room Map & Coordination settings ----
  $("stgSaveBtn").addEventListener("click", saveOpsSettings);

  // ---- Classes & Streams ----
  $("addClassForm").addEventListener("submit", submitAddClass);
  $("classesList").addEventListener("click", handleClassesListClick);

  // ---- Session Schedule ----
  $("scheduleList").addEventListener("click", handleScheduleListClick);

  // ---- Help: Feedback + Chat ----
  $("helpFab").addEventListener("click", openHelpModal);
  $("helpModalClose").addEventListener("click", closeHelpModal);
  $("privacyModalClose").addEventListener("click", closePrivacyModal);
  $("openPrivacyBtnLogin").addEventListener("click", openPrivacyModal);
  $("openPrivacyBtnMentor").addEventListener("click", openPrivacyModal);
  $("openPrivacyBtnStudent").addEventListener("click", openPrivacyModal);
  $("openPrivacyBtnHelp").addEventListener("click", openPrivacyModal);
  $("helpTabChips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-helptab]");
    if (b) setHelpTab(b.dataset.helptab);
  });
  $("feedbackForm").addEventListener("submit", submitFeedback);
  $("feedbackList").addEventListener("click", handleFeedbackListClick);
  $("chatForm").addEventListener("submit", submitChat);
  $("dmNewForm").addEventListener("submit", submitDmNew);
  $("dmForm").addEventListener("submit", submitDm);
  $("dmBackBtn").addEventListener("click", closeDmThread);
  $("dmConversations").addEventListener("click", handleDmConversationsClick);
  $("groupForm").addEventListener("submit", submitGroupMessage);
  $("groupBackBtn").addEventListener("click", closeGroupThread);
  $("groupList").addEventListener("click", handleGroupListClick);
  wireAttachInput_("chatAttachInput", "chatAttachPreview", "chat");
  wireAttachInput_("dmAttachInput", "dmAttachPreview", "dm");
  wireAttachInput_("groupAttachInput", "groupAttachPreview", "group");
  if ($("teamFileUploadForm")) $("teamFileUploadForm").addEventListener("submit", submitTeamFileUpload_);
  if ($("staffDirectoryPrintBtn")) $("staffDirectoryPrintBtn").addEventListener("click", openStaffDirectoryPrintView_);
  $("helpSurveyForm").addEventListener("submit", submitMentorSurveyForm);

  // ---------------------------------------------------------------------
  // INIT
  // ---------------------------------------------------------------------
  state.syncQueue = loadQueue();
  renderWhoami();
  setTab("tasks");

  if (DEMO_MODE) {
    // No backend configured — demo mode has no auth at all, browse freely.
    refresh(true).then(buildChoiceSelects);
  } else {
    // Live mode: every screen requires a signed-in session. If one is
    // saved from a previous visit, try it silently; if it's gone stale
    // (PIN reset, etc.) refresh()'s AUTH_REQUIRED handling drops back to
    // the login screen automatically.
    const saved = loadSavedSession();
    if (saved && saved.token) {
      state.session = saved;
      hideLoginScreen();
      renderWhoami();
      refresh(true).then(() => { buildChoiceSelects(); maybeHandleDeepLinkIntent_(); });
    } else {
      showLoginScreen();
    }
  }

  // Pull-to-refresh-ish: refresh when app regains focus after being backgrounded
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.session) { refresh(false); flushQueue(); }
    else if (document.visibilityState !== "visible") stopScanning(); // release the camera when backgrounded
  });

  // Offline-safe writes: retry the moment connectivity returns, and keep
  // trying quietly in the background in case the 'online' event doesn't fire
  // (flaky venue wifi often reconnects without a clean browser signal).
  window.addEventListener("online", () => { statusLine.classList.remove("offline"); flushQueue(); refresh(false); });
  window.addEventListener("offline", () => { statusLine.classList.add("offline"); renderSyncIndicator(); });
  setInterval(flushQueue, 20000);

  // Light polling refresh for the Reports and Dashboard tabs — the closest
  // thing this architecture has to "real time" without true push updates
  // (there's no websocket/pub-sub infra here, and Apps Script doesn't
  // support one cheaply). Only runs while one of those two tabs is actually
  // open, the tab is visible/foregrounded, and there's a session — so it
  // never polls in the background or while someone's mid-edit elsewhere.
  // renderAll() (inside refresh()) already re-renders the Dashboard as a
  // side effect; Reports isn't part of that pipeline, so re-apply the
  // current filters afterward via runReport_() to reflect fresh data.
  setInterval(() => {
    if (!DEMO_MODE && state.session && navigator.onLine && document.visibilityState === "visible" &&
        (state.activeTab === "reports" || state.activeTab === "dashboard")) {
      refresh(false).then(() => { if (state.activeTab === "reports" && $("reportTableWrap")) runReport_(); });
    }
  }, 45000);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("service-worker.js").catch((e) => console.warn("SW failed", e));
    });
    // Auto-refresh once when a new version of the app takes over. Without this,
    // a phone/browser with the app already cached can keep showing an old
    // index.html/app.js/styles.css combo indefinitely — even after we ship a
    // fix — because the service worker returns the cached shell instantly and
    // only updates it quietly in the background for the *next* load. This
    // makes "next load" happen automatically instead of relying on someone
    // knowing to hard-refresh or clear their cache.
    let swAutoRefreshed = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (swAutoRefreshed) return;
      swAutoRefreshed = true;
      window.location.reload();
    });
  }
})();
