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

  const COHORT_TARGETS = { F4: 450, G10A: 398, G10B: 398 };
  const REG_OPEN = new Date("2026-08-15T00:00:00");
  const REG_CLOSE = new Date("2026-08-20T23:59:59");

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
        state.feedback = data.feedback || [];
        state.chat = data.chat || [];
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
          state.feedback = cached.feedback || [];
          state.chat = cached.chat || [];
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
    const order = ["Leadership", "Zone Coordinators", "Cluster Leads", "Mentors", "Interns", "Members", "Other"];
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
      // Live mode: this button shows who's signed in and offers to sign out,
      // rather than letting anyone just type in a different name.
      if (state.session && confirm("Signed in as " + state.session.name + " (" + state.session.accessLevel + " access).\n\nSign out?")) {
        logout();
      }
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
    if (type === "mentor") buildZoneClusterSelect("mfZone", "mfCluster");
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
      zones.map((z) => `<option value="Zone ${esc(z)}">Zone ${esc(z)}</option>`).join("");
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

  function showQrResult(id, name, pending) {
    drawQr($("qrCanvas"), id);
    $("qrResultId").textContent = id;
    $("qrResultName").textContent = name;
    const note = $("qrPendingNote");
    if (note) note.classList.toggle("hidden", !pending);
    $("regQrResult").classList.remove("hidden");
    $("studentForm").classList.add("hidden");
    $("mentorForm").classList.add("hidden");
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
    const now = new Date().toISOString();
    const provisionalId = provisionalStudentId_(cohort);
    const record = { id: provisionalId, name, admissionNo: "", classStream, cohort, choices, round1: "", round2: "", round3: "", round4: "", status: "Pending", notes: "", createdAt: now, updatedAt: now, teacherEmail, teacherName: "" };
    state.students.push(record);
    showQrResult(provisionalId, name, true);
    ev.target.reset();
    renderAll();
    if (!DEMO_MODE) {
      apiPost({ action: "register_student", clientId: provisionalId, name, classStream, cohort, choices, teacherEmail })
        .then((res) => {
          if (res && res.ok && res.id) {
            record.id = res.id;
            if ($("qrResultId").textContent === provisionalId) showQrResult(res.id, name, false);
            renderAll();
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
    const zone = $("mfZone").value.trim();
    const cluster = $("mfCluster").value.trim();
    // Provisional client-side id for instant QR — reconciled with the
    // server's authoritative id (if different) once the request resolves.
    const provisionalId = "T" + String(state.team.length + 1).padStart(3, "0");
    const now = new Date().toISOString();
    const record = { id: provisionalId, name, phone, email, role, zone, cluster, status: "Unconfirmed", notes: "", updatedAt: now };
    state.team.push(record);
    showQrResult(provisionalId, name);
    ev.target.reset();
    renderAll();
    if (!DEMO_MODE) {
      apiPost({ action: "register_mentor", name, phone, email, role, zone, cluster })
        .then((res) => {
          if (res.ok && res.id && res.id !== provisionalId) {
            record.id = res.id;
            if ($("qrResultId").textContent === provisionalId) showQrResult(res.id, name);
            renderAll();
          }
          if (res && res.duplicateWarning) alert("⚠ " + res.duplicateWarning);
        })
        .catch((e) => console.error(e));
    }
  }

  function downloadQr() {
    const canvas = $("qrCanvas");
    const link = document.createElement("a");
    link.download = ($("qrResultId").textContent || "qr") + ".png";
    link.href = canvas.toDataURL("image/png");
    link.click();
  }

  // ---------------------------------------------------------------------
  // QR BATCH — print/download a whole class/cluster/zone at once, and the
  // same PNGs (base64) get reused to embed inline in a class's email.
  // ---------------------------------------------------------------------
  function qrDataUrlFor(id, size) {
    const canvas = document.createElement("canvas");
    canvas.width = size || 240;
    canvas.height = size || 240;
    drawQr(canvas, id);
    return canvas.toDataURL("image/png");
  }

  // people: [{id, name, meta}]. Used for both printing and emailing, so the
  // exact same image data goes out either way — no risk of a mismatch
  // between what's printed and what's emailed.
  function collectQrImages(people) {
    return people.map((p) => ({ id: p.id, name: p.name, dataUrl: qrDataUrlFor(p.id, 240) }));
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
    const cards = images
      .map(
        (img) => `
      <div class="qrcard">
        <img src="${img.dataUrl}" width="150" height="150">
        <div class="qname">${esc(img.name)}</div>
        <div class="qid">${esc(img.id)}</div>
      </div>`
      )
      .join("");
    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
      <style>
        * { box-sizing: border-box; }
        body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 20px; color: #1A1A1A; }
        h1 { font-size: 16px; color: #7A1319; margin: 0 0 2px 0; }
        .sub { font-size: 11px; color: #777; margin-bottom: 14px; }
        .grid { display: flex; flex-wrap: wrap; gap: 10px; }
        .qrcard { width: 170px; border: 1px solid #ddd; border-radius: 8px; padding: 10px; text-align: center; page-break-inside: avoid; }
        .qname { font-size: 11.5px; font-weight: 700; margin-top: 6px; }
        .qid { font-size: 10px; color: #888; }
        .printbar { margin-bottom: 14px; }
        button { background: #B82126; color: #fff; border: none; border-radius: 20px; padding: 8px 16px; font-size: 12px; font-weight: 700; }
        @media print { .printbar { display: none; } body { margin: 8mm; } }
      </style></head><body>
      <div class="printbar"><button onclick="window.print()">Print / Save as PDF</button></div>
      <h1>${esc(title)}</h1>
      <div class="sub">${esc(subtitle || "")} &middot; ${images.length} QR code(s) &middot; WG2 Boma Career Day 2026</div>
      <div class="grid">${cards}</div>
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

  function stopScanning() {
    if (state.scanLoopId) cancelAnimationFrame(state.scanLoopId);
    state.scanLoopId = null;
    if (state.scanStream) {
      state.scanStream.getTracks().forEach((t) => t.stop());
      state.scanStream = null;
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
      const label = cohort === "F4" ? "Form 4" : cohort === "G10A" ? "Grade 10 · A" : "Grade 10 · B";
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

  function studentRoundCards(s) {
    const rounds = [s.round1, s.round2, s.round3, s.round4];
    return rounds
      .map((cid, i) => {
        const filled = !!cid;
        const label = filled ? clusterLabel(cid) : "Not yet allocated";
        const room = filled ? "Room " + cid : "—";
        return `
        <div class="roundcard">
          <div>
            <div class="rlabel">Round ${i + 1}</div>
            <div class="rname">${esc(label)}</div>
            <div class="rroom">${esc(room)}</div>
          </div>
          <div class="rstatus ${filled ? "filled" : ""}">${filled ? "Set" : "Pending"}</div>
        </div>`;
      })
      .join("");
  }

  function renderFindResults() {
    const q = $("findSearch").value.trim().toLowerCase();
    const box = $("findResults");
    if (!q) {
      box.innerHTML = "";
      return;
    }
    const matches = state.students.filter(
      (s) => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q) || (s.admissionNo || "").toLowerCase().includes(q)
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

  function renderClassPane() {
    populateClassSelect();
    const cls = $("classSelect").value;
    const roster = state.students.filter((s) => s.classStream === cls);
    const allocated = roster.filter((s) => s.round1 && s.round2 && s.round3 && s.round4).length;
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
      $("roomWho").innerHTML = `<b>${esc(state.who)}</b> &middot; ${esc(myCluster.name)} &middot; Room ${esc(myCluster.room)}`;
    }
    const cluster = myCluster || state.clusters[0];
    if (!cluster) {
      $("roomRounds").innerHTML = '<div class="empty">No clusters loaded yet.</div>';
      return;
    }
    let html = `<div class="chiprow" id="roomClusterChips">` +
      state.clusters.map((c) => `<button class="chip ${c.id === cluster.id ? "active" : ""}" data-roomcluster="${escAttr(c.id)}">${esc(c.id)}</button>`).join("") +
      `</div>`;
    for (let r = 1; r <= 4; r++) {
      const key = "round" + r;
      const inRound = state.students.filter((s) => s[key] === cluster.id);
      html += `<div class="group-label">Round ${r} &middot; ${esc(inRound.length)} student(s)</div>`;
      html += inRound.length
        ? inRound.map((s) => `<div class="checkin-row"><div><div class="cname">${esc(s.name)}</div><div class="cmeta">${esc(s.id)} &middot; ${esc(s.cohort)}</div></div></div>`).join("")
        : '<div class="empty">No one assigned here yet for this round.</div>';
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

    let candidates = state.students.filter((s) => s.choices && (force || !(s.round1 && s.round2 && s.round3 && s.round4)));
    if (force) candidates.forEach((s) => { s.round1 = s.round2 = s.round3 = s.round4 = ""; });
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    let roundsAssigned = 0;
    for (let round = 1; round <= 4; round++) {
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
    let incomplete = 0;
    candidates.forEach((s) => {
      const full = s.round1 && s.round2 && s.round3 && s.round4;
      if (!full) incomplete++;
      else if (s.status === "Pending" || s.status === "Walk-in") s.status = "Allocated";
    });
    return { roundsAssigned, studentsProcessed: candidates.length, studentsIncomplete: incomplete };
  }

  function runAllocationClick() {
    const btn = $("runAllocationBtn");
    btn.disabled = true;
    btn.textContent = "Running…";
    const done = (result) => {
      btn.disabled = false;
      btn.textContent = "Run Allocation";
      renderAll();
      alert(`Allocation done.\n${result.roundsAssigned} round-assignments made across ${result.studentsProcessed} students.\n${result.studentsIncomplete} student(s) couldn't get all 4 rounds (ran out of matching choices with open capacity — add more choices or increase cluster capacity).`);
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
    const full = withChoices.filter((s) => s.round1 && s.round2 && s.round3 && s.round4);
    const el = $("dashAllocStatus");
    if (!withChoices.length) {
      el.innerHTML = "No students have submitted cluster choices yet — nothing to allocate.";
    } else {
      el.innerHTML = `<b>${full.length} / ${withChoices.length}</b> students with choices are fully allocated across all 4 rounds. Running allocation again only fills in what's still missing (existing assignments are kept).`;
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

    $("teamAccessSection").classList.toggle("hidden", !admin);
    $("roomAssignSection").classList.toggle("hidden", !zoneOrAbove);
    $("allocationSection").classList.toggle("hidden", !admin);
    $("sendUpdateSection").classList.toggle("hidden", !zoneOrAbove);
    $("sendUpdateHint").classList.toggle("hidden", zoneOrAbove);
    $("helpFab").classList.toggle("hidden", DEMO_MODE || !state.session);
    $("internTaskBanner").classList.toggle("hidden", !isIntern());

    if (admin) renderTeamAccessList();
    if (admin) buildZoneClusterSelect("amZone", "amCluster");
    if (zoneOrAbove) renderRoomAssignList();
  }

  // ---- Team Access panel (Lead/Assistant Lead only) ----
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
          <select data-access-select>
            <option value="cluster" ${p.accessLevel === "cluster" || !p.accessLevel ? "selected" : ""}>Cluster</option>
            <option value="zone" ${p.accessLevel === "zone" ? "selected" : ""}>Zone</option>
            <option value="intern" ${p.accessLevel === "intern" ? "selected" : ""}>Intern</option>
            <option value="all" ${p.accessLevel === "all" ? "selected" : ""}>All</option>
          </select>
          <button data-access-save>Save</button>
          <button data-access-regen>Regenerate PIN</button>
        </div>
        <div class="arpin" data-access-pinshow></div>
      </div>
    `
      )
      .join("");
  }

  function submitAddMember(e) {
    e.preventDefault();
    const body = {
      action: "add_team_member",
      name: $("amName").value.trim(),
      phone: $("amPhone").value.trim(),
      email: $("amEmail").value.trim(),
      role: $("amRole").value,
      zone: $("amZone").value.trim(),
      cluster: $("amCluster").value.trim(),
      accessLevel: $("amAccessLevel").value,
    };
    if (!body.name) return;
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
      apiPost({ action: "update_access", id, accessLevel: level }).then((res) => {
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
    }
  }

  // ---- Room Assignments panel (all / zone access) ----
  function renderRoomAssignList() {
    if (!state.clusters.length) {
      $("roomAssignList").innerHTML = '<div class="empty">No clusters loaded yet.</div>';
      return;
    }
    const myZone = zoneLetterOfClient(state.session ? state.session.zone : "");
    const visible = state.clusters
      .slice()
      .filter((c) => isAdmin() || c.zone === myZone)
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

  // ---------------------------------------------------------------------
  // FEEDBACK + TEAM CHAT
  // ---------------------------------------------------------------------
  function openHelpModal() {
    $("helpModal").classList.remove("hidden");
    renderFeedbackList();
    renderChatList();
  }
  function closeHelpModal() {
    $("helpModal").classList.add("hidden");
  }
  function setHelpTab(tab) {
    state.helpTab = tab;
    document.querySelectorAll("#helpTabChips [data-helptab]").forEach((b) => b.classList.toggle("active", b.dataset.helptab === tab));
    $("helpFeedbackPane").classList.toggle("hidden", tab !== "feedback");
    $("helpChatPane").classList.toggle("hidden", tab !== "chat");
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

  whoamiBtn.addEventListener("click", openWhoami);
  $("whoamiCancel").addEventListener("click", closeWhoami);
  $("whoamiSave").addEventListener("click", saveWhoami);

  // ---- Register ----
  $("regTypeChips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-regtype]");
    if (b) setRegType(b.dataset.regtype);
  });
  $("studentForm").addEventListener("submit", submitStudentForm);
  $("mentorForm").addEventListener("submit", submitMentorForm);
  $("qrDownloadBtn").addEventListener("click", downloadQr);
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
    downloadCSV(
      "wg2-class-" + (cls || "roster").replace(/[^a-z0-9]+/gi, "-") + "-" + todayStr() + ".csv",
      ["id", "name", "admissionNo", "classStream", "cohort", "status", "round1", "round2", "round3", "round4"],
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

  // ---- Team Access (Lead/Assistant Lead only) ----
  $("addMemberForm").addEventListener("submit", submitAddMember);
  $("teamAccessList").addEventListener("click", handleAccessRowClick);

  // ---- Room Assignments ----
  $("roomAssignList").addEventListener("click", handleRoomRowClick);

  // ---- Help: Feedback + Chat ----
  $("helpFab").addEventListener("click", openHelpModal);
  $("helpModalClose").addEventListener("click", closeHelpModal);
  $("helpTabChips").addEventListener("click", (e) => {
    const b = e.target.closest("[data-helptab]");
    if (b) setHelpTab(b.dataset.helptab);
  });
  $("feedbackForm").addEventListener("submit", submitFeedback);
  $("feedbackList").addEventListener("click", handleFeedbackListClick);
  $("chatForm").addEventListener("submit", submitChat);

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
