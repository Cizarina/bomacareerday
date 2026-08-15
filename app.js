// ---------------------------------------------------------------------
// WG2 Team & Tasks — app logic (no framework, no build step)
// ---------------------------------------------------------------------
(function () {
  "use strict";

  const CFG = window.APP_CONFIG || {};
  const API_URL = (CFG.API_URL || "").trim();
  const DEMO_MODE = !API_URL;

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

  function filteredTasks() {
    const f = state.taskFilters;
    const q = f.q.trim().toLowerCase();
    return state.tasks.filter((t) => {
      if (f.phase !== "All" && t.phase !== f.phase) return false;
      if (f.state !== "All" && t.state !== f.state) return false;
      if (q && !(t.task.toLowerCase().includes(q) || (t.owner || "").toLowerCase().includes(q))) return false;
      return true;
    });
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
    $("taskList").innerHTML = items
      .map(
        (t) => `
      <div class="card" data-task-id="${escAttr(t.id)}">
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
    `
      )
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
      // a self-service PIN change, and sign out. Anyone can change their
      // own PIN this way, not just admins via Team Access.
      if (!state.session) return;
      $("accountName").textContent = state.session.name;
      $("accountMeta").textContent = state.session.role + " · " + state.session.accessLevel + " access";
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
        refresh(true).then(buildChoiceSelects);
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

    if (!exbomarian) { errEl.textContent = "Please answer the Exbomarian question."; errEl.classList.remove("hidden"); return; }
    if (exbomarian === "No" && !refereeName) { errEl.textContent = "Please give your referee's full name."; errEl.classList.remove("hidden"); return; }
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

  function loadPublicCareersForStudentForm_() {
    if (DEMO_MODE) { buildCareerChoiceSelects_("psChoiceSelects", "ps-choice-rank", CAREER_CATALOG); return; }
    publicApiGet("careers_public")
      .then((res) => buildCareerChoiceSelects_("psChoiceSelects", "ps-choice-rank", res && res.ok && res.careers && res.careers.length ? res.careers : CAREER_CATALOG))
      .catch(() => buildCareerChoiceSelects_("psChoiceSelects", "ps-choice-rank", CAREER_CATALOG));
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

  // ---------------------------------------------------------------------
  // TABS
  // ---------------------------------------------------------------------
  const ALL_TABS = ["tasks", "team", "register", "checkin", "schedule", "dashboard"];
  function setTab(tab) {
    state.activeTab = tab;
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    ALL_TABS.forEach((t) => $("view-" + t).classList.toggle("hidden", t !== tab));
    if (tab === "dashboard") renderDashboard();
    if (tab === "schedule") renderSchedule();
    if (tab !== "checkin") stopScanning();
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
          .sort((a, b) => a.name.localeCompare(b.name))
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
  // QR BATCH — print/download a whole class/cluster/zone at once, and the
  // same PNGs (base64) get reused to embed inline in a class's email.
  // ---------------------------------------------------------------------
  // people: [{id, name, ...}]. isStudent is detected the same way the rest
  // of the schedule code does (round1 !== undefined) — students get the
  // full ticket-style itinerary card below; everyone else (mentors/team,
  // who have no day-of schedule of their own to print) keeps the original
  // compact grid-of-QR-codes layout, so bulk-printing a whole team roster
  // still fits many per page instead of one page each.
  function collectQrImages(people) {
    return people.map((p) => {
      const isStudent = p.round1 !== undefined;
      return {
        id: p.id,
        name: p.name,
        dataUrl: labeledQrDataUrl(p.id, p.name, 240, isStudent ? [] : studentScheduleLines_(p)),
        plainDataUrl: plainQrDataUrl_(p.id, 280),
        isStudent,
        roleTag: isStudent ? (COHORT_LABELS[p.cohort] || p.cohort || "Student") : (p.role || "Team Member"),
        subInfo: isStudent ? p.classStream || "" : p.cluster || p.zone || "",
        blocks: isStudent ? studentItineraryBlocks_(p) : [],
      };
    });
  }

  const EXHIBITION_HOURS_NOTE = "Exhibition Hall stays open until 5:30 PM for anyone who wants to keep browsing.";

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
    return `
      <div class="ticket"${pageBreakBefore ? ' style="page-break-before:always;"' : ""}>
        <div class="ticket-header">
          <div class="ticket-header-left">
            <div class="ticket-logo">WG2</div>
            <div class="ticket-header-text">
              <div class="ticket-org">Kenya High School Alumnae Society</div>
              <div class="ticket-event">BOMA CAREER DAY 2026</div>
              <div class="ticket-tagline">Discover &middot; Connect &middot; Choose</div>
            </div>
          </div>
          <div class="ticket-roletag">${esc(img.roleTag)}</div>
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
          img.blocks.length
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
        }
        <div class="ticket-footer">
          <div class="ticket-footer-note">${scheduleIconHtml_("info")}<span>Arrive 10 minutes early for each session and show this QR code at check-in. ${esc(EXHIBITION_HOURS_NOTE)}</span></div>
          <div class="ticket-footer-tag">Karibu Boma!</div>
        </div>
      </div>`;
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
    const students = images.filter((img) => img.isStudent);
    const others = images.filter((img) => !img.isStudent);
    const ticketPages = students.map((img, i) => ticketHtml_(img, i > 0)).join("");
    const otherCards = others
      .map(
        (img) => `
      <div class="qrcard">
        <img src="${img.dataUrl}" style="width:150px;height:auto;display:block;margin:0 auto;">
        <div class="qname">${esc(img.name)}</div>
        <div class="qid">${esc(img.id)}</div>
      </div>`
      )
      .join("");
    const otherGrid = otherCards
      ? `<div class="grid"${students.length ? ' style="page-break-before:always;"' : ""}>
        <h1>${esc(title)}</h1>
        <div class="sub">${esc(subtitle || "")} &middot; ${others.length} QR code(s) &middot; WG2 Boma Career Day 2026</div>
        <div class="gridwrap">${otherCards}</div>
      </div>`
      : "";
    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
      <style id="pageA4style">@page { size: A4; margin: 12mm; }</style>
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

        /* ---- old compact grid (mentors/team — no day-of schedule) ---- */
        h1 { font-size: 16px; color: #7A1319; margin: 0 0 2px 0; }
        .sub { font-size: 11px; color: #777; margin-bottom: 14px; }
        .gridwrap { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-start; }
        .qrcard { width: 170px; border: 1px solid #ddd; border-radius: 8px; padding: 10px; text-align: center; page-break-inside: avoid; }
        .qname { font-size: 11.5px; font-weight: 700; margin-top: 6px; }
        .qid { font-size: 10px; color: #888; }

        /* ---- ticket (student itinerary card) ---- */
        .ticket { max-width: 720px; margin: 0 auto 16px; border: 1px solid #E3D9C9; border-radius: 14px; overflow: hidden; page-break-inside: avoid; }
        .ticket-header { background: linear-gradient(120deg, #7A1319, #4d0c10); color: #fff; padding: 16px 18px; display: flex; justify-content: space-between; align-items: flex-start; }
        .ticket-header-left { display: flex; gap: 12px; align-items: center; }
        .ticket-logo { width: 42px; height: 42px; border-radius: 50%; background: #FFF7E6; color: #7A1319; font-weight: 800; font-size: 12px; display: flex; align-items: center; justify-content: center; flex: 0 0 auto; }
        .ticket-org { font-size: 9px; letter-spacing: 0.5px; text-transform: uppercase; opacity: 0.85; }
        .ticket-event { font-size: 16px; font-weight: 800; letter-spacing: 0.3px; margin-top: 1px; }
        .ticket-tagline { font-size: 10px; color: #F0D9A6; margin-top: 2px; }
        .ticket-roletag { background: #B8862B; color: #fff; font-size: 10.5px; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase; padding: 6px 12px; border-radius: 20px; white-space: nowrap; }
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
        .ticket-footer { background: #7A1319; color: #fff; padding: 10px 18px; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
        .ticket-footer-note { font-size: 9.5px; opacity: 0.92; display: flex; gap: 6px; align-items: flex-start; max-width: 520px; }
        .ticket-footer-tag { font-style: italic; color: #F0D9A6; font-weight: 700; font-size: 13px; white-space: nowrap; }

        /* ---- A5 compact scale ---- */
        body.a5 .ticket { max-width: 100%; }
        body.a5 .ticket-header { padding: 10px 12px; }
        body.a5 .ticket-logo { width: 32px; height: 32px; font-size: 10px; }
        body.a5 .ticket-event { font-size: 12.5px; }
        body.a5 .ticket-org, body.a5 .ticket-tagline { font-size: 8px; }
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
        body.a5 .ticket-footer { padding: 8px 12px; }
        body.a5 .ticket-footer-note { font-size: 7.5px; }
        body.a5 .ticket-footer-tag { font-size: 10px; }
      </style></head><body>
      <div class="printbar">
        <button onclick="window.print()">Print / Save as PDF</button>
        <span class="sizebtns">
          <button type="button" id="btnA4" class="sizebtn active" onclick="setPageSize('A4')">A4</button>
          <button type="button" id="btnA5" class="sizebtn" onclick="setPageSize('A5')">A5</button>
        </span>
        <span style="font-size:11px;color:#777;">${images.length} QR code(s) &middot; ${esc(subtitle || "")}</span>
      </div>
      ${ticketPages}
      ${otherGrid}
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
    renderDashAllocStatus();
    renderDashRegProgress();
    renderDashLiveSummary();
    renderDashTeamSummary();
    renderDashTaskPhases();
    renderDashZoneTable();
    renderDashProjection();
    renderDashCapacity();
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
    const classes = uniqueSorted(state.students.map((s) => s.classStream));
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
      const mentors = state.team.filter((t) => ROOM_MENTOR_ROLES.indexOf(t.role) !== -1 && teamMemberCluster(t) && teamMemberCluster(t).id === c.id);
      let flag = "ok";
      if (interested.length > 0 && mentors.length === 0) flag = "nomentor";
      else if (ratio > 1.15) flag = "over";
      else if (ratio < 0.4 && interested.length === 0) flag = "unused";
      else if (ratio < 0.4) flag = "under";
      return { cluster: c, interested: interested.length, allocated: allocated.length, dayCapacity, ratio, mentors: mentors.length, flag };
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
    unused: "No interest yet",
    nomentor: "No mentor assigned",
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
    $("mentorApplicationsSection").classList.toggle("hidden", !admin);
    $("roomAssignSection").classList.toggle("hidden", !opsOrAbove);
    $("opsSettingsSection").classList.toggle("hidden", !opsOrAbove);
    $("classesSection").classList.toggle("hidden", !zoneOrAbove);
    $("scheduleSection").classList.toggle("hidden", !opsOrAbove);
    $("allocationSection").classList.toggle("hidden", !admin);
    $("sendUpdateSection").classList.toggle("hidden", !zoneOrAbove);
    $("sendUpdateHint").classList.toggle("hidden", zoneOrAbove);
    $("helpFab").classList.toggle("hidden", DEMO_MODE || !state.session);
    $("internTaskBanner").classList.toggle("hidden", !isIntern());
    $("classTeacherTaskBanner").classList.toggle("hidden", !isClassTeacher());
    $("addTaskBtn").classList.toggle("hidden", !opsOrAbove);
    $("mentorOpsSection").classList.toggle("hidden", !zoneOrAbove);
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
          .sort((a, b) => a.name.localeCompare(b.name))
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
      <div class="access-row" data-access-id="${escAttr(p.id)}">
        <div class="artop">
          <div>
            <div class="arname">${esc(p.name)}</div>
            <div class="armeta">${esc(p.role || "")}${p.zone ? " · " + esc(p.zone) : ""}${p.cluster ? " · " + esc(p.cluster) : ""}</div>
          </div>
        </div>
        <div class="arcontrols">
          <input type="text" data-access-email placeholder="email@example.com (for PIN emails)" value="${escAttr(p.email || "")}">
          <select data-access-select>
            <option value="cluster" ${p.accessLevel === "cluster" || !p.accessLevel ? "selected" : ""}>Cluster</option>
            <option value="zone" ${p.accessLevel === "zone" ? "selected" : ""}>Zone</option>
            <option value="intern" ${p.accessLevel === "intern" ? "selected" : ""}>Intern</option>
            <option value="class" ${p.accessLevel === "class" ? "selected" : ""}>Class</option>
            <option value="all" ${p.accessLevel === "all" ? "selected" : ""}>All</option>
          </select>
          <button data-access-save>Save</button>
          <button data-access-regen>Regenerate PIN</button>
          <button data-access-resend>Resend PIN</button>
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
      const email = row.querySelector("[data-access-email]").value.trim();
      const modeEl = row.querySelector("[data-access-mode]");
      const linkEl = row.querySelector("[data-access-sessionlink]");
      const classEl = row.querySelector("[data-access-classstream]");
      const body = { action: "update_access", id, accessLevel: level, email };
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
    }
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
        : `Exbomarian${a.gradYear ? ", class of " + esc(a.gradYear) : ""}`;
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

    if (e.target.matches("[data-mentorapp-approve]")) {
      const cluster = card.querySelector("[data-mentorapp-cluster]").value;
      if (!confirm("Approve this mentor and email them their sign-in PIN now?")) return;
      apiPost({ action: "approve_mentor_application", id, cluster }).then((res) => {
        if (!res.ok && !res.queued) {
          if (resultEl) { resultEl.textContent = res.error || "Couldn't approve."; resultEl.style.color = "var(--red)"; }
          return;
        }
        if (resultEl) { resultEl.textContent = res.queued ? "Saved offline — will sync once back online." : `Approved. PIN emailed${res.emailSent === false ? " — actually, the email couldn't be sent, share it manually: " + res.pin : ""}.`; resultEl.style.color = "var(--green)"; }
        refreshMentorApplications();
      });
    } else if (e.target.matches("[data-mentorapp-reject]")) {
      const reason = prompt("Optional note for the record (not sent to the applicant):", "") || "";
      if (!confirm("Reject this mentor application?")) return;
      apiPost({ action: "reject_mentor_application", id, reviewNotes: reason }).then((res) => {
        if (!res.ok && !res.queued) {
          if (resultEl) { resultEl.textContent = res.error || "Couldn't reject."; resultEl.style.color = "var(--red)"; }
          return;
        }
        refreshMentorApplications();
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
        resultEl.textContent = res.usedGemini ? "AI summary generated." : "Heuristic suggestion generated (no Gemini API key configured — see Code.gs).";
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
  }
  function saveOpsSettings() {
    const updates = [
      ["roomMapUrl", $("stgRoomMapUrl").value.trim()],
      ["roomCoordinatorName", $("stgRoomCoordName").value.trim()],
      ["roomCoordinatorContact", $("stgRoomCoordContact").value.trim()],
    ];
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
      const rows = state.classes.filter((c) => c.cohort === coh).sort((a, b) => a.name.localeCompare(b.name));
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
        <div class="chatmsg">${esc(m.message)}</div>
      </div>
    `
      )
      .join("");
    $("chatList").scrollTop = $("chatList").scrollHeight;
  }

  function submitChat(e) {
    e.preventDefault();
    const message = $("chatInput").value.trim();
    if (!message) return;
    apiPost({ action: "post_chat", message }).then((res) => {
      if (!res.ok && !res.queued) { alert(res.error || "Couldn't send."); return; }
      $("chatInput").value = "";
      if (res.queued) {
        state.chat.push({ id: "pending", timestamp: new Date().toISOString(), who: state.session ? state.session.name : "", message });
        renderChatList();
      } else {
        refresh(false).then(renderChatList);
      }
    });
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
        <div class="chatmsg">${esc(m.message)}</div>
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
    if (!message) return;
    apiPost({ action: "send_private_message", toId: state.dmActiveWith.id, message }).then((res) => {
      if (!res.ok && !res.queued) { alert(res.error || "Couldn't send."); return; }
      $("dmInput").value = "";
      loadPrivateChat();
    });
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
        <div class="chatmsg">${esc(m.message)}</div>
      </div>`
      )
      .join("");
    box.scrollTop = box.scrollHeight;
  }

  function submitGroupMessage(e) {
    e.preventDefault();
    if (!state.activeGroup) return;
    const message = $("groupInput").value.trim();
    if (!message) return;
    apiPost({ action: "post_group_message", groupId: state.activeGroup, message }).then((res) => {
      if (!res.ok && !res.queued) { alert(res.error || "Couldn't send."); return; }
      $("groupInput").value = "";
      markGroupSeen_(state.activeGroup);
      loadGroupChat();
    });
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
  $("accountChangePin").addEventListener("click", changeMyPin);
  $("accountSignOut").addEventListener("click", signOutFromAccount);

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
  $("cgSearch").addEventListener("input", renderCareersGuideContent_);
  $("cgZoneChips").addEventListener("click", handleCareersGuideZoneChipClick_);
  $("cgDownloadGuideBtn").addEventListener("click", downloadCareerGuidePdf_);
  $("cgDownloadAddendumBtn").addEventListener("click", downloadCareerBriefsAddendumPdf_);

  // ---- Team Access (Lead/Assistant Lead only) ----
  $("addMemberForm").addEventListener("submit", submitAddMember);
  $("teamAccessList").addEventListener("click", handleAccessRowClick);

  // ---- Mentor Applications (Lead/Assistant Lead only) ----
  $("mentorApplicationsList").addEventListener("click", handleMentorApplicationsClick);
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
      refresh(true).then(buildChoiceSelects);
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

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("service-worker.js").catch((e) => console.warn("SW failed", e));
    });
  }
})();
