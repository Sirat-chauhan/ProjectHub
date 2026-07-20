// =====================================================================
// Global App State
// =====================================================================
const state = {
    token: localStorage.getItem("token") || null,
    refreshToken: localStorage.getItem("refresh_token") || null,
    user: null,
    projects: [],
    currentProject: null,
    logs: [],
    activeSection: "dashboard",
    isUploading: false,
    globalProjectId: localStorage.getItem("globalProjectId") || null,  // Globally selected project — auto-fills all page dropdowns
    chatSessions: {}, // key: projectId, value: array of {role: "user"|"assistant", content: string}
    stories: [],
    activeGenerations: {}, // Track document ID -> boolean for active story generations
    activeProjectTab: "milestones"
};

function updateSidebarProjectsLink() {
    const navProjects = document.getElementById("nav-projects");
    if (!navProjects) return;
    if (state.currentProject) {
        navProjects.setAttribute("href", `#projects/${state.currentProject.id}`);
    } else {
        navProjects.setAttribute("href", "#projects");
    }
}

// API Base configuration
const API_BASE = "";

// =====================================================================
// Global Token Refresh Interceptor
// =====================================================================
const originalFetch = window.fetch;
window.fetch = async function (...args) {
    let response = await originalFetch(...args);
    if (response.status === 401 && localStorage.getItem("refresh_token")) {
        const urlStr = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
        if (!urlStr.includes('/api/auth/login') && !urlStr.includes('/api/auth/refresh') && !urlStr.includes('/api/auth/register')) {
            try {
                const refreshRes = await originalFetch(`${API_BASE}/api/auth/refresh`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ refresh_token: localStorage.getItem("refresh_token") })
                });
                if (refreshRes.ok) {
                    const data = await refreshRes.json();
                    localStorage.setItem("token", data.access_token);
                    if (data.refresh_token) {
                        localStorage.setItem("refresh_token", data.refresh_token);
                        state.refreshToken = data.refresh_token;
                    }
                    state.token = data.access_token;
                    state.user = data.user;

                    // Retry original request with the renewed access token
                    let options = args[1] ? { ...args[1] } : {};
                    options.headers = options.headers ? { ...options.headers } : {};
                    options.headers["Authorization"] = `Bearer ${data.access_token}`;
                    return await originalFetch(args[0], options);
                } else {
                    localStorage.removeItem("refresh_token");
                    state.refreshToken = null;
                }
            } catch (e) {
                console.error("[ProjectHub] Background token refresh error:", e);
            }
        }
    }
    return response;
};

// =====================================================================
// Initializer & Routing
// =====================================================================
document.addEventListener("DOMContentLoaded", () => {
    // Refresh Icons
    lucide.createIcons();

    // Bind Event Listeners
    bindAuthEvents();
    bindSidebarEvents();
    bindProjectEvents();
    bindMilestoneEvents();
    bindUploadEvents();
    bindChatEvents();
    bindLogsEvents();

    // Check Authentication
    initApp();

    // Listen to hash change for URL-based navigation
    window.addEventListener("hashchange", handleRouting);
});

async function initApp() {
    // Check if arriving from Supabase Auth password recovery email
    const hashStr = window.location.hash + "&" + window.location.search;
    if (hashStr.includes("reset-password") || hashStr.includes("type=recovery") || hashStr.includes("type=invite") || hashStr.includes("recovery=true")) {
        const cleanQuery = hashStr.replace(/^[#?]/, "").replace(/[#?]/g, "&");
        const params = new URLSearchParams(cleanQuery);
        if (params.get("access_token")) window._resetAccessToken = params.get("access_token");
        if (params.get("refresh_token")) window._resetRefreshToken = params.get("refresh_token");

        showAuthModal(true);
        setTimeout(() => {
            document.querySelectorAll(".auth-form").forEach(f => f.classList.remove("active"));
            const resetForm = document.getElementById("reset-password-form");
            if (resetForm) resetForm.classList.add("active");
        }, 100);
        return;
    }

    if (!state.token) {
        showAuthModal(true);
    } else {
        showAuthModal(false);
        const success = await fetchUserProfile();
        if (success) {
            await populateProjectDropdowns();
            handleRouting();
            loadWorkspaceData();
        } else {
            // Token expired or invalid
            signOut();
        }
    }
}

async function handleRouting() {
    const hash = window.location.hash.slice(1) || "dashboard";

    // Close any active modal overlays
    closeAllModals();

    // If navigating to main projects page, clear active project details
    if (hash === "projects") {
        state.currentProject = null;
        updateSidebarProjectsLink();
    }

    // Hide details view when navigating away from a specific project detail
    if (!hash.startsWith("projects/")) {
        document.getElementById("project-detail-view").classList.add("hidden");
        document.getElementById("project-cards-container").classList.remove("hidden");
    }

    const validSections = ["dashboard", "projects", "milestones", "uploads", "chat", "logs", "stories", "mytasks"];
    let targetSection = hash;

    // Handle nested sub-hashes if any
    if (hash.startsWith("projects/")) {
        const projId = parseInt(hash.split("/")[1]);
        openProjectDetail(projId);
        targetSection = "projects";
    }

    if (!validSections.includes(targetSection)) {
        targetSection = "dashboard";
    }

    state.activeSection = targetSection;

    // Toggle active classes in sidebar
    document.querySelectorAll(".nav-item").forEach(item => {
        item.classList.remove("active");
    });
    const navLink = document.getElementById(`nav-${targetSection}`);
    if (navLink) navLink.classList.add("active");

    // Toggle active sections in main contents
    document.querySelectorAll(".content-section").forEach(sec => {
        sec.classList.remove("active");
    });
    const section = document.getElementById(`section-${targetSection}`);
    if (section) section.classList.add("active");

    // Dynamic loads based on target section
    if (targetSection === "dashboard") loadDashboardStats();
    if (targetSection === "projects" && !hash.startsWith("projects/")) loadProjects();
    if (targetSection === "milestones") loadMilestonesRoadmap();
    if (targetSection === "uploads") populateProjectDropdowns();
    if (targetSection === "chat") populateProjectDropdowns();
    if (targetSection === "logs") loadActivityLogs();
    if (targetSection === "stories") {
        await populateProjectDropdowns();
        loadStories();
    }
    if (targetSection === "mytasks") loadMyTasks();
    applyRBACUI();
}

function closeAllModals() {
    document.querySelectorAll(".modal-overlay").forEach(modal => {
        modal.classList.remove("active");
    });
}

// =====================================================================
// Toast Notifications
// =====================================================================
function showToast(message, type = "info", linkText = null, linkHref = null, linkAction = null) {
    const toast = document.getElementById("toast");
    toast.className = `toast-card active ${type}`;

    // Backwards compatibility if 4th arg was passed as a function
    if (typeof linkHref === "function" && !linkAction) {
        linkAction = linkHref;
        linkHref = "javascript:void(0)";
    }

    window._toastLinkAction = linkAction || null;

    if (linkText && (linkHref || linkAction)) {
        const hrefAttr = linkHref && typeof linkHref === "string" ? linkHref : "javascript:void(0)";
        toast.innerHTML = `
            <span>${message}</span>
            <a class="toast-link" href="${hrefAttr}" onclick="if(window._toastLinkAction) { setTimeout(window._toastLinkAction, 50); }">${linkText} &rarr;</a>
        `;
    } else {
        toast.textContent = message;
    }

    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => {
        toast.classList.remove("active");
        window._toastLinkAction = null;
    }, 15000);
}

// =====================================================================
// Authentication Handlers
// =====================================================================
function showAuthModal(show) {
    const modal = document.getElementById("auth-modal");
    if (show) {
        modal.classList.add("active");
    } else {
        modal.classList.remove("active");
    }
}

function bindAuthEvents() {
    const goReg = document.getElementById("go-to-register");
    const goLogin = document.getElementById("go-to-login");
    const goAdminLogin = document.getElementById("go-to-admin-login");
    const goBackToUserLogin = document.getElementById("go-back-to-user-login");
    const loginForm = document.getElementById("login-form");
    const registerForm = document.getElementById("register-form");
    const adminLoginForm = document.getElementById("admin-login-form");
    const btnSignout = document.getElementById("btn-signout");

    const forgotForm = document.getElementById("forgot-password-form");
    const resetForm = document.getElementById("reset-password-form");

    function showForm(formToShow) {
        loginForm.classList.remove("active");
        registerForm.classList.remove("active");
        adminLoginForm.classList.remove("active");
        if (forgotForm) forgotForm.classList.remove("active");
        if (resetForm) resetForm.classList.remove("active");
        formToShow.classList.add("active");
    }

    goReg.addEventListener("click", () => showForm(registerForm));
    goLogin.addEventListener("click", () => showForm(loginForm));
    goAdminLogin.addEventListener("click", () => showForm(adminLoginForm));
    goBackToUserLogin.addEventListener("click", () => showForm(loginForm));

    // Regular user login
    loginForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const email = document.getElementById("login-email").value;
        const password = document.getElementById("login-password").value;
        const errorDiv = document.getElementById("login-error");

        errorDiv.style.display = "none";
        
        const submitBtn = loginForm.querySelector('button[type="submit"]');
        const originalBtnText = submitBtn.innerHTML;
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i data-lucide="loader" class="spin" style="width:16px;height:16px;margin-right:6px;"></i> Signing in...';
        lucide.createIcons();

        try {
            const response = await fetch(`${API_BASE}/api/auth/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password, full_name: "Login Attempt" })
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.detail || "Authentication failed.");
            }

            const data = await response.json();

            localStorage.setItem("token", data.access_token);
            if (data.refresh_token) {
                localStorage.setItem("refresh_token", data.refresh_token);
                state.refreshToken = data.refresh_token;
            }
            state.token = data.access_token;
            state.user = data.user;

            showToast("Successfully signed in!", "success");
            window.location.hash = "#dashboard";
            setTimeout(() => {
                initApp();
            }, 0);
        } catch (err) {
            errorDiv.textContent = err.message;
            errorDiv.style.display = "block";
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnText;
        }
    });

    // Admin login
    adminLoginForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const email = document.getElementById("admin-login-email").value;
        const password = document.getElementById("admin-login-password").value;
        const errorDiv = document.getElementById("admin-login-error");

        errorDiv.style.display = "none";

        const submitBtn = adminLoginForm.querySelector('button[type="submit"]');
        const originalBtnText = submitBtn.innerHTML;
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i data-lucide="loader" class="spin" style="width:16px;height:16px;margin-right:6px;"></i> Signing in...';
        lucide.createIcons();

        try {
            const response = await fetch(`${API_BASE}/api/auth/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password, full_name: "Admin Login Attempt" })
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.detail || "Authentication failed.");
            }

            const data = await response.json();

            if (!data.user.is_admin) {
                errorDiv.textContent = "Access Denied: This account does not have administrator privileges.";
                errorDiv.style.display = "block";
                return;
            }

            localStorage.setItem("token", data.access_token);
            if (data.refresh_token) {
                localStorage.setItem("refresh_token", data.refresh_token);
                state.refreshToken = data.refresh_token;
            }
            state.token = data.access_token;
            state.user = data.user;

            showToast("Welcome back, Admin!", "success");
            window.location.hash = "#dashboard";
            setTimeout(() => {
                initApp();
            }, 0);
        } catch (err) {
            errorDiv.textContent = err.message;
            errorDiv.style.display = "block";
        } finally {
            if (typeof submitBtn !== 'undefined') {
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalBtnText;
            }
        }
    });

    // Registration
    registerForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const full_name = document.getElementById("register-name").value;
        const email = document.getElementById("register-email").value;
        const password = document.getElementById("register-password").value;
        const errorDiv = document.getElementById("register-error");
        const submitBtn = registerForm.querySelector('button[type="submit"]');

        errorDiv.style.display = "none";

        if (password.length < 6) {
            errorDiv.textContent = "Password must be at least 6 characters.";
            errorDiv.style.display = "block";
            return;
        }

        const originalBtnText = submitBtn.innerHTML;
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i data-lucide="loader" class="spin" style="width:16px;height:16px;margin-right:6px;"></i> Signing up...';
        lucide.createIcons();

        try {
            const response = await fetch(`${API_BASE}/api/auth/register`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, password, full_name })
            });

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.detail || "Registration failed.");
            }

            showToast("Verification email sent! Please check your inbox and click the link to verify your account and log in.", "success");
            registerForm.classList.remove("active");
            loginForm.classList.add("active");
        } catch (err) {
            errorDiv.textContent = err.message;
            errorDiv.style.display = "block";
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnText;
        }
    });

    // Forgot / Reset Password Navigation
    const goForgotBtn = document.getElementById("go-to-forgot-password");
    const goBackFromForgot = document.getElementById("go-back-from-forgot");
    const goBackFromReset = document.getElementById("go-back-from-reset");

    if (goForgotBtn) goForgotBtn.addEventListener("click", (e) => { e.preventDefault(); if (forgotForm) showForm(forgotForm); });
    if (goBackFromForgot) goBackFromForgot.addEventListener("click", () => showForm(loginForm));
    if (goBackFromReset) goBackFromReset.addEventListener("click", () => showForm(loginForm));

    if (forgotForm) {
        forgotForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            const email = document.getElementById("forgot-email").value;
            const errorDiv = document.getElementById("forgot-error");
            const successDiv = document.getElementById("forgot-success");
            errorDiv.style.display = "none";
            successDiv.style.display = "none";

            const submitBtn = forgotForm.querySelector('button[type="submit"]');
            const originalBtnText = submitBtn.innerHTML;
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i data-lucide="loader" class="spin" style="width:16px;height:16px;margin-right:6px;"></i> Sending...';
            lucide.createIcons();

            try {
                const res = await fetch(`${API_BASE}/api/auth/forgot-password`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ email })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.detail || "Failed to send reset link.");
                successDiv.textContent = data.detail || "Reset link sent to your email!";
                successDiv.style.display = "block";
            } catch (err) {
                errorDiv.textContent = err.message;
                errorDiv.style.display = "block";
            } finally {
                if (typeof submitBtn !== 'undefined') {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = originalBtnText;
                }
            }
        });
    }

    if (resetForm) {
        resetForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            const newPassword = document.getElementById("reset-new-password").value;
            const confirmPassword = document.getElementById("reset-confirm-password").value;
            const errorDiv = document.getElementById("reset-error");
            const successDiv = document.getElementById("reset-success");
            errorDiv.style.display = "none";
            successDiv.style.display = "none";

            const submitBtn = resetForm.querySelector('button[type="submit"]');
            const originalBtnText = submitBtn.innerHTML;

            if (newPassword !== confirmPassword) {
                errorDiv.textContent = "Passwords do not match.";
                errorDiv.style.display = "block";
                return;
            }
            
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i data-lucide="loader" class="spin" style="width:16px;height:16px;margin-right:6px;"></i> Updating...';
            lucide.createIcons();

            try {
                let accessToken = window._resetAccessToken;
                let refreshToken = window._resetRefreshToken || "";
                if (!accessToken) {
                    const hashStr = window.location.hash + "&" + window.location.search;
                    const cleanQuery = hashStr.replace(/^[#?]/, "").replace(/[#?]/g, "&");
                    const params = new URLSearchParams(cleanQuery);
                    accessToken = params.get("access_token");
                    if (params.get("refresh_token")) refreshToken = params.get("refresh_token");
                }
                if (!accessToken) {
                    throw new Error("No password reset token found in URL. Please click the reset link in your email again.");
                }
                const res = await fetch(`${API_BASE}/api/auth/reset-password`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        access_token: accessToken,
                        refresh_token: refreshToken,
                        new_password: newPassword
                    })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.detail || "Failed to reset password.");
                successDiv.textContent = data.detail || "Password reset successfully!";
                successDiv.style.display = "block";
                showToast("Password updated successfully! Please log in with your new password.", "success");
                // Clear the URL hash and search parameters so initApp doesn't trigger the reset form again
                window.history.replaceState({}, document.title, window.location.pathname);
                setTimeout(() => {
                    showForm(loginForm);
                }, 2500);
            } catch (err) {
                errorDiv.textContent = err.message;
                errorDiv.style.display = "block";
            } finally {
                if (typeof submitBtn !== 'undefined') {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = originalBtnText;
                }
            }
        });
    }

    btnSignout.addEventListener("click", signOut);
}

async function fetchUserProfile() {
    try {
        const response = await fetch(`${API_BASE}/api/auth/me`, {
            headers: { "Authorization": `Bearer ${state.token}` }
        });
        if (!response.ok) return false;

        state.user = await response.json();

        // Update sidebar profile
        const fullNameEl = document.getElementById("user-fullname");
        fullNameEl.textContent = state.user.is_admin ? `${state.user.full_name} [ADMIN]` : state.user.full_name;
        if (state.user.is_admin) fullNameEl.style.color = "#3b82f6";
        document.getElementById("user-email").textContent = state.user.email;
        const avatarChar = document.getElementById("user-avatar-char");
        const sidebarImg = document.getElementById("sidebar-avatar-img");
        if (state.user.profile_image) {
            if (sidebarImg) { sidebarImg.src = state.user.profile_image; sidebarImg.style.display = "block"; }
            if (avatarChar) avatarChar.style.display = "none";
        } else {
            if (avatarChar) { avatarChar.textContent = state.user.full_name[0].toUpperCase(); avatarChar.style.display = "flex"; }
            if (sidebarImg) sidebarImg.style.display = "none";
        }

        // Show and start notifications
        const notifContainer = document.getElementById("notif-container");
        if (notifContainer) notifContainer.style.display = "block";
        startNotificationPolling();

        return true;
    } catch (e) {
        return false;
    }
}

function checkAdminAccess(actionName = "do that") {
    const isAdmin = !!state.user?.is_admin;

    // Actions that are strictly global admin only
    const globalAdminActions = [
        "invite users",
        "assign administrator privileges",
        "assign admin",
        "purge orphans",
        "view admin logs"
    ];
    if (globalAdminActions.includes(actionName.toLowerCase())) {
        const isAnyProjManager = state.projects?.some(p => p.user_role === 'Manager' || p.user_role === 'Admin');
        if (!isAdmin && !isAnyProjManager) {
            showToast(`Only Admin or Manager can ${actionName}`, "error");
            return false;
        }
        return true;
    }

    // Actions that are open to everyone (e.g. creating projects)
    if (actionName.toLowerCase() === "create new projects") {
        return true;
    }

    // Project-specific actions: allowed for global Admin OR project Manager/Owner
    const activeProjectId = state.currentProject?.id || state.globalProjectId;
    const activeProj = state.projects?.find(p => p.id == activeProjectId);
    const isProjManager = activeProj && (activeProj.user_role === 'Manager' || activeProj.user_role === 'Admin');
    if (isAdmin || isProjManager) {
        return true;
    }

    showToast(`Only Admin or Project Manager can ${actionName}`, "error");
    return false;
}

function applyRBACUI() {
    const isAdmin = !!state.user?.is_admin;
    const activeProjectId = state.currentProject?.id || state.globalProjectId;
    const activeProj = state.projects?.find(p => p.id == activeProjectId);
    const isProjManager = activeProj && (activeProj.user_role === 'Manager' || activeProj.user_role === 'Admin');
    const hasManagerPrivileges = isAdmin || isProjManager;
    const isAnyProjManager = state.projects?.some(p => p.user_role === 'Manager' || p.user_role === 'Admin');
    const showManagementViews = isAdmin || isAnyProjManager;
    const hasProjectSelected = !!(state.globalProjectId);

    // Show admin-only buttons (Assign Admin, Invite Others) to Admins and Managers
    document.querySelectorAll(".admin-only-btn").forEach(btn => {
        btn.style.display = showManagementViews ? "flex" : "none";
    });

    // Sidebar nav visibility:
    // - Admins: always see everything
    // - Non-admins: see only Dashboard until a project is selected,
    //   then unlock all sidebar items
    const sidebarNavItems = document.querySelectorAll(".sidebar-nav .nav-item");
    sidebarNavItems.forEach(item => {
        const id = item.id;
        const href = item.getAttribute("href") || "";
        if (href === "#dashboard") {
            // Dashboard is always visible for everyone
            item.style.display = "flex";
        } else if (id === "nav-milestones" || id === "nav-uploads") {
            // Milestones and Upload Documents are admin-only/manager management views
            item.style.display = showManagementViews ? "flex" : "none";
        } else {
            // For non-admins: show other sections (including Projects) only after a project is selected
            item.style.display = (isAdmin || hasProjectSelected) ? "flex" : "none";
        }
    });

    // Hide team management controls for non-admin/non-manager users
    const teamControls = document.getElementById("team-management-controls");
    if (teamControls) {
        teamControls.style.display = hasManagerPrivileges ? "flex" : "none";
    }

    // Hide delete project button for non-admin/non-manager users
    const deleteProjectBtn = document.getElementById("btn-delete-project");
    if (deleteProjectBtn) {
        deleteProjectBtn.style.display = hasManagerPrivileges ? "inline-flex" : "none";
    }

    // "New Project" button is visible to all logged-in users
    const newProjectBtn = document.getElementById("btn-open-create-project-modal");
    if (newProjectBtn) {
        newProjectBtn.style.display = "inline-flex";
    }

    // Hide "Add Milestone" button for non-admin/non-manager users
    const addMilestoneBtn = document.getElementById("btn-add-milestone-direct");
    if (addMilestoneBtn) {
        addMilestoneBtn.style.display = hasManagerPrivileges ? "inline-flex" : "none";
    }

    // Hide "Upload Document" button for non-admin/non-manager users
    const addDocumentBtn = document.getElementById("btn-add-document-direct");
    if (addDocumentBtn) {
        addDocumentBtn.style.display = hasManagerPrivileges ? "inline-flex" : "none";
    }

    // Hide "Add Team Member" button for non-admin/non-manager users
    const addTeamMemberBtn = document.getElementById("btn-add-team-member");
    if (addTeamMemberBtn) {
        addTeamMemberBtn.style.display = hasManagerPrivileges ? "inline-flex" : "none";
    }

    // Apply bold visual emphasis on the global project selector if a project is selected
    const globalSelect = document.getElementById("global-project-select");
    if (globalSelect) {
        if (globalSelect.value) {
            globalSelect.classList.add("selected-bold");
        } else {
            globalSelect.classList.remove("selected-bold");
        }
    }
}

function signOut() {
    localStorage.removeItem("token");
    localStorage.removeItem("refresh_token");
    state.token = null;
    state.refreshToken = null;
    state.user = null;
    state.projects = [];
    state.currentProject = null;
    state.chatSessions = {};

    // Clear display
    document.getElementById("user-fullname").textContent = "User Name";
    document.getElementById("user-email").textContent = "email@company.com";

    // Hide and stop notifications
    const notifContainer = document.getElementById("notif-container");
    if (notifContainer) notifContainer.style.display = "none";
    const notifDropdown = document.getElementById("notif-dropdown");
    if (notifDropdown) notifDropdown.style.display = "none";
    stopNotificationPolling();

    showToast("Signed out successfully.");
    window.location.hash = "#dashboard";
    showAuthModal(true);
}

// =====================================================================
// Workspace & Dashboard Handlers
// =====================================================================
function loadWorkspaceData() {
    loadDashboardStats();
    populateProjectDropdowns();
}

async function loadDashboardStats() {
    if (!state.token) return;

    try {
        // Fetch projects and logs in parallel
        const [projRes, logsRes] = await Promise.all([
            fetch(`${API_BASE}/api/projects`, { headers: { "Authorization": `Bearer ${state.token}` } }),
            fetch(`${API_BASE}/api/logs`, { headers: { "Authorization": `Bearer ${state.token}` } })
        ]);
        const [projs, allLogs] = await Promise.all([projRes.json(), logsRes.json()]);
        state.projects = projs;
        state.logs = allLogs;

        const selectedProjId = state.globalProjectId || "";

        // If a project is selected, filter logs to only show entries related to that project (keeping general auth/user logs always visible)
        let filteredLogs = allLogs;
        if (selectedProjId) {
            const selectedProj = projs.find(p => String(p.id) === String(selectedProjId));
            const projName = selectedProj ? selectedProj.name : "";
            filteredLogs = allLogs.filter(log => {
                if (["login_user", "register_user", "password_reset", "failed_login"].includes(log.action)) {
                    return true;
                }
                const d = (log.details || "").toLowerCase();
                return d.includes(`project '${projName.toLowerCase()}'`) ||
                    d.includes(`project id ${selectedProjId}`) ||
                    d.includes(`(id: ${selectedProjId})`) ||
                    d.includes(`project "${projName.toLowerCase()}"`) ||
                    d.includes(`project ${selectedProjId}`);
            });
        }

        // Render Dashboard Activity Feed
        renderDashboardTimeline(filteredLogs);

        let totalDocs = 0;
        let totalMilestones = 0;

        if (selectedProjId) {
            // Scoped: show stats only for the selected project
            document.getElementById("stat-projects").textContent = "1";

            const [mRes, docsRes] = await Promise.all([
                fetch(`${API_BASE}/api/milestones/project/${selectedProjId}`, { headers: { "Authorization": `Bearer ${state.token}` } }),
                fetch(`${API_BASE}/api/documents/project/${selectedProjId}`, { headers: { "Authorization": `Bearer ${state.token}` } })
            ]);
            if (mRes.ok) totalMilestones = (await mRes.json()).length;
            if (docsRes.ok) totalDocs = (await docsRes.json()).length;
        } else {
            // No project selected: aggregate across all projects
            document.getElementById("stat-projects").textContent = projs.length;

            const promises = [];
            for (let p of projs.slice(0, 5)) {
                promises.push(
                    fetch(`${API_BASE}/api/milestones/project/${p.id}`, { headers: { "Authorization": `Bearer ${state.token}` } })
                        .then(res => res.ok ? res.json() : [])
                );
                promises.push(
                    fetch(`${API_BASE}/api/documents/project/${p.id}`, { headers: { "Authorization": `Bearer ${state.token}` } })
                        .then(res => res.ok ? res.json() : [])
                );
            }
            const results = await Promise.all(promises);
            for (let i = 0; i < results.length; i += 2) {
                totalMilestones += results[i].length;
                totalDocs += results[i + 1].length;
            }
        }

        document.getElementById("stat-milestones").textContent = totalMilestones;
        document.getElementById("stat-documents").textContent = totalDocs;

        // Calculate estimated RAG chunks (avg 8 chunks per doc index) if element exists
        const statChunksEl = document.getElementById("stat-chunks");
        if (statChunksEl) {
            statChunksEl.textContent = totalDocs * 8;
        }
    } catch (e) {
        console.error("Stats fetching error:", e);
    }
}

function renderDashboardTimeline(logs) {
    const container = document.getElementById("dash-timeline-list");
    container.innerHTML = "";

    if (logs.length === 0) {
        container.innerHTML = '<p class="timeline-empty">No activity logged yet.</p>';
        return;
    }

    // Draw top 5 logs
    logs.slice(0, 5).forEach(log => {
        const item = document.createElement("div");
        item.className = "timeline-item";

        let markerClass = "action-update";
        if (log.action.startsWith("create") || log.action.startsWith("register")) markerClass = "action-create";
        if (log.action.startsWith("delete")) markerClass = "action-delete";

        const utcTime = log.created_at.endsWith("Z") ? log.created_at : log.created_at + "Z";
        const formattedTime = new Date(utcTime).toLocaleString();

        item.innerHTML = `
            <div class="timeline-marker">
                <div class="timeline-dot ${markerClass}"></div>
                <div class="timeline-line"></div>
            </div>
            <div class="timeline-content">
                <p>${log.details}</p>
                <div class="timeline-meta">
                    <span><i data-lucide="user" style="width:12px;height:12px;"></i> ${log.user_name}</span>
                    <span><i data-lucide="clock" style="width:12px;height:12px;"></i> ${formattedTime}</span>
                </div>
            </div>
        `;
        container.appendChild(item);
    });

    lucide.createIcons();
}

function bindSidebarEvents() {
    document.querySelectorAll(".nav-item").forEach(item => {
        item.addEventListener("click", (e) => {
            e.preventDefault();
            const href = item.getAttribute("href");
            window.location.hash = href;
        });
    });

    document.getElementById("dash-view-all-logs").addEventListener("click", (e) => {
        e.preventDefault();
        window.location.hash = "#logs";
    });

    // ChatGPT-Style Sidebar Toggle
    const btnCloseSidebar = document.getElementById("btn-sidebar-close");
    const btnOpenSidebar = document.getElementById("btn-sidebar-open");
    const appContainer = document.getElementById("app-container");

    if (btnCloseSidebar && btnOpenSidebar && appContainer) {
        if (localStorage.getItem("sidebar_collapsed") === "true") {
            appContainer.classList.add("sidebar-collapsed");
        }

        btnCloseSidebar.addEventListener("click", () => {
            appContainer.classList.add("sidebar-collapsed");
            localStorage.setItem("sidebar_collapsed", "true");
        });

        btnOpenSidebar.addEventListener("click", () => {
            appContainer.classList.remove("sidebar-collapsed");
            localStorage.setItem("sidebar_collapsed", "false");
        });
    }
}

// =====================================================================
// Project Management Handlers
// =====================================================================
function bindProjectEvents() {
    const btnOpen = document.getElementById("btn-open-create-project-modal");
    const btnClose = document.getElementById("btn-close-project-modal");
    const btnCancel = document.getElementById("btn-cancel-project-modal");
    const modal = document.getElementById("create-project-modal");
    const form = document.getElementById("create-project-form");

    // Detail Panel Back Button
    const btnBack = document.getElementById("btn-back-to-projects");

    btnOpen.addEventListener("click", () => {
        if (!checkAdminAccess("create new projects")) return;
        modal.classList.add("active");
    });
    btnClose.addEventListener("click", () => modal.classList.remove("active"));
    btnCancel.addEventListener("click", () => modal.classList.remove("active"));

    btnBack.addEventListener("click", () => {
        state.currentProject = null;
        window.location.hash = "#projects";
    });

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!checkAdminAccess("create new projects")) return;
        const submitBtn = form.querySelector('button[type="submit"]');
        if (submitBtn && submitBtn.disabled) return;

        const name = document.getElementById("project-name").value;
        const description = document.getElementById("project-desc").value;

        const origBtnText = submitBtn ? submitBtn.innerHTML : "Create Project";
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i data-lucide="loader" style="width: 14px; height: 14px;"></i> Creating...';
            if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons();
        }

        try {
            const response = await fetch(`${API_BASE}/api/projects`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${state.token}`
                },
                body: JSON.stringify({ name, description })
            });

            if (!response.ok) throw new Error("Could not create project.");

            showToast("Project created successfully!", "success");
            form.reset();
            modal.classList.remove("active");
            loadProjects();
            loadWorkspaceData(); // Refresh counts
        } catch (e) {
            showToast(e.message, "error");
        } finally {
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = origBtnText;
            }
        }
    });

    // Detail Tab Buttons (Milestones, Documents, Team) handled below
    const tabMilestones = document.getElementById("tab-milestones-btn");
    const tabDocs = document.getElementById("tab-documents-btn");

    tabDocs.addEventListener("click", () => {
        state.activeProjectTab = "documents";
        tabDocs.classList.add("active");
        tabMilestones.classList.remove("active");
        tabTeam.classList.remove("active");
        document.getElementById("detail-tab-documents").classList.add("active");
        document.getElementById("detail-tab-milestones").classList.remove("active");
        document.getElementById("detail-tab-team").classList.remove("active");
    });

    const tabTeam = document.getElementById("tab-team-btn");
    tabTeam.addEventListener("click", () => {
        state.activeProjectTab = "team";
        tabTeam.classList.add("active");
        tabMilestones.classList.remove("active");
        tabDocs.classList.remove("active");
        document.getElementById("detail-tab-team").classList.add("active");
        document.getElementById("detail-tab-milestones").classList.remove("active");
        document.getElementById("detail-tab-documents").classList.remove("active");
        if (state.currentProject) loadTeamMembers(state.currentProject.id);
    });

    // Also update milestones tab click to reset team tab
    tabMilestones.addEventListener("click", () => {
        state.activeProjectTab = "milestones";
        tabMilestones.classList.add("active");
        tabDocs.classList.remove("active");
        tabTeam.classList.remove("active");
        document.getElementById("detail-tab-milestones").classList.add("active");
        document.getElementById("detail-tab-documents").classList.remove("active");
        document.getElementById("detail-tab-team").classList.remove("active");
    });

    // Add Direct shortcuts
    document.getElementById("btn-add-milestone-direct").addEventListener("click", async () => {
        if (!checkAdminAccess("add milestones")) return;
        await populateProjectDropdowns();
        document.getElementById("milestone-project-id").value = state.currentProject.id;
        window.location.hash = "#milestones";
        document.getElementById("create-milestone-modal").classList.add("active");
    });

    document.getElementById("btn-add-document-direct").addEventListener("click", () => {
        if (!checkAdminAccess("upload documents")) return;
        document.getElementById("upload-project-id").value = state.currentProject.id;
        triggerProjectChangeInUpload();
        window.location.hash = "#uploads";
    });

    document.getElementById("btn-delete-project").addEventListener("click", async () => {
        if (!checkAdminAccess("delete projects")) return;
        if (!state.currentProject) return;
        const confirmDelete = confirm(`Are you absolutely sure you want to delete project '${state.currentProject.name}'? All files, milestones, and vector store indices will be permanently removed!`);
        if (!confirmDelete) return;

        try {
            const res = await fetch(`${API_BASE}/api/projects/${state.currentProject.id}`, {
                method: "DELETE",
                headers: { "Authorization": `Bearer ${state.token}` }
            });

            if (!res.ok) throw new Error("Failed to delete project.");

            showToast("Project and all associated file vectors deleted successfully.");
            state.currentProject = null;
            window.location.hash = "#projects";
            loadProjects();
            loadWorkspaceData();
        } catch (e) {
            showToast(e.message, "error");
        }
    });
}

async function loadProjects() {
    if (!state.token) return;

    const container = document.getElementById("project-cards-container");
    container.innerHTML = '<p class="timeline-empty">Loading projects...</p>';

    try {
        const response = await fetch(`${API_BASE}/api/projects`, {
            headers: { "Authorization": `Bearer ${state.token}` }
        });
        const projects = await response.json();
        state.projects = projects;

        container.innerHTML = "";
        let projectsToRender = projects;
        if (state.globalProjectId) {
            projectsToRender = projects.filter(p => p.id === parseInt(state.globalProjectId));
        }

        if (projectsToRender.length === 0) {
            container.innerHTML = '<p class="timeline-empty">No projects found.</p>';
            return;
        }

        projectsToRender.forEach(project => {
            const card = document.createElement("div");
            card.className = "project-card glass-panel";
            card.setAttribute("data-id", project.id);

            const desc = project.description || "No description provided.";
            const created = new Date(project.created_at).toLocaleDateString();

            card.innerHTML = `
                <div class="project-card-header">
                    <h3>${project.name}</h3>
                    <p>${desc}</p>
                </div>
                <div class="project-card-footer">
                    <span><i data-lucide="calendar" style="width:12px;height:12px;"></i> Created: ${created}</span>
                    <span><i data-lucide="chevron-right" style="width:14px;height:14px;color:var(--color-primary);"></i></span>
                </div>
            `;

            card.addEventListener("click", () => {
                window.location.hash = `projects/${project.id}`;
            });

            container.appendChild(card);
        });

        lucide.createIcons();
    } catch (e) {
        container.innerHTML = `<p class="timeline-empty error">Failed to load projects: ${e.message}</p>`;
    }
}

async function openProjectDetail(projectId) {
    if (!state.token) return;

    try {
        const res = await fetch(`${API_BASE}/api/projects/${projectId}`, {
            headers: { "Authorization": `Bearer ${state.token}` }
        });
        if (!res.ok) throw new Error("Project not found");
        const project = await res.json();
        state.currentProject = project;
        updateSidebarProjectsLink();

        // Populate detail panels
        document.getElementById("detail-project-title").textContent = project.name;
        document.getElementById("detail-project-desc").textContent = project.description || "No description provided.";

        // Hide grid, show detail panel
        document.getElementById("project-cards-container").classList.add("hidden");
        document.getElementById("project-detail-view").classList.remove("hidden");

        // Switch to the last active sub-tab
        const activeTab = state.activeProjectTab || "milestones";
        document.getElementById(`tab-${activeTab}-btn`)?.click();

        // Fetch detail lists
        loadProjectDetailMilestones(projectId);
        loadProjectDetailDocuments(projectId);
        loadTeamMembers(projectId);

        const teamControls = document.getElementById("team-management-controls");
        if (teamControls) {
            teamControls.style.display = "flex";
        }

        const deleteProjectBtn = document.getElementById("btn-delete-project");
        if (deleteProjectBtn) {
            deleteProjectBtn.style.display = "inline-flex";
        }
        applyRBACUI();
    } catch (e) {
        showToast(e.message, "error");
        window.location.hash = "#projects";
    }
}

async function loadProjectDetailMilestones(projectId) {
    const container = document.getElementById("project-detail-milestones-list");
    container.innerHTML = '<p class="timeline-empty">Loading milestones...</p>';

    try {
        const res = await fetch(`${API_BASE}/api/milestones/project/${projectId}`, {
            headers: { "Authorization": `Bearer ${state.token}` }
        });
        const milestones = await res.json();

        container.innerHTML = "";
        if (milestones.length === 0) {
            container.innerHTML = `
                <div class="timeline-empty-state" style="padding: 30px 0;">
                    <p>No milestones created for this project yet.</p>
                </div>
            `;
            return;
        }

        milestones.forEach(milestone => {
            const card = document.createElement("div");
            card.className = "timeline-card";

            const isDone = milestone.status === "completed";
            const nodeClass = isDone ? "completed" : "";
            const formattedDate = milestone.due_date ? new Date(milestone.due_date).toLocaleDateString() : "No due date";

            card.innerHTML = `
                <div class="timeline-card-node ${nodeClass}"></div>
                <div class="timeline-card-header">
                    <h4>${milestone.title}</h4>
                    <span class="status-badge ${milestone.status}">${milestone.status}</span>
                </div>
                <p class="timeline-card-body">${milestone.description || "No details provided."}</p>
                <div class="timeline-card-header">
                    <p><i data-lucide="calendar" style="width:12px;height:12px;display:inline;"></i> Due: ${formattedDate}</p>
                    <div class="timeline-card-actions" style="display: ${(state.user?.is_admin || state.currentProject?.user_role === 'Manager' || state.currentProject?.user_role === 'Admin') ? 'flex' : 'none'};">
                        <button class="btn btn-secondary btn-sm" onclick="uploadToMilestone(${projectId}, ${milestone.id})" title="Upload Document"><i data-lucide="upload"></i> Upload</button>
                        ${!isDone ? `<button class="btn btn-secondary btn-sm" onclick="toggleMilestoneStatus(${milestone.id}, 'completed', this)" title="Mark Completed"><i data-lucide="check"></i> Complete</button>` : `<button class="btn btn-secondary btn-sm" onclick="toggleMilestoneStatus(${milestone.id}, 'pending', this)" title="Reopen Milestone"><i data-lucide="rotate-ccw"></i> Reopen</button>`}
                        <button class="btn btn-text btn-icon-danger" onclick="deleteMilestoneDirect(${milestone.id}, this)" title="Delete Milestone"><i data-lucide="trash"></i></button>
                    </div>
                </div>
            `;
            container.appendChild(card);
        });

        lucide.createIcons();
    } catch (e) {
        container.innerHTML = `<p>Error loading milestones: ${e.message}</p>`;
    }
}

async function loadProjectDetailDocuments(projectId) {
    const container = document.getElementById("project-detail-documents-list");
    container.innerHTML = '<tr><td colspan="7" style="text-align:center;">Loading documents...</td></tr>';

    try {
        const [res, mRes] = await Promise.all([
            fetch(`${API_BASE}/api/documents/project/${projectId}`, { headers: { "Authorization": `Bearer ${state.token}` } }),
            fetch(`${API_BASE}/api/milestones/project/${projectId}`, { headers: { "Authorization": `Bearer ${state.token}` } })
        ]);
        const docs = await res.json();
        const milestones = await mRes.json();
        const milestoneMap = {};
        milestones.forEach(m => milestoneMap[m.id] = m.title);

        container.innerHTML = "";
        if (docs.length === 0) {
            container.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--color-text-muted);">No documents uploaded yet. Go to Uploads to add workspace items.</td></tr>';
            return;
        }

        docs.forEach(doc => {
            const sizeKB = (doc.file_size / 1024).toFixed(1);
            const mName = doc.milestone_id ? milestoneMap[doc.milestone_id] || "Global" : "Global Project File";
            const dateStr = new Date(doc.created_at).toLocaleDateString();

            const categoryLabel = doc.category === 'client' ? "Client's Document" :
                doc.category === 'global' ? "Global Document" : "Team Document";

            const row = document.createElement("tr");
            row.innerHTML = `
                <td><strong style="color:var(--color-primary); cursor:pointer; text-decoration: underline;" onclick="downloadDocumentSecurely(${doc.id}, '${doc.name}')">${doc.name}</strong></td>
                <td><span class="text-muted">${mName}</span></td>
                <td><span class="text-muted">${categoryLabel}</span></td>
                <td>${sizeKB} KB</td>
                <td><span class="file-type-badge ${doc.file_type}">${doc.file_type}</span></td>
                <td>${dateStr}</td>
                <td>
                    ${(state.user?.is_admin || state.currentProject?.user_role === 'Manager' || state.currentProject?.user_role === 'Admin') ? `
                    <div style="display: flex; gap: 6px; align-items: center;">
                        <button class="btn btn-secondary btn-sm" id="btn-gen-stories-${doc.id}"
                            ${state.activeGenerations && state.activeGenerations[doc.id] ? 'disabled' : ''}
                            onclick="generateStoriesFromDocument(${projectId}, ${doc.id}, '${doc.name.replace(/'/g, "\\'")}')"
                            style="font-size: 0.75rem; padding: 4px 10px; display: inline-flex; align-items: center; gap: 4px;" title="Generate User Stories from this document">
                            ${state.activeGenerations && state.activeGenerations[doc.id] ? '<i data-lucide="loader" class="spin" style="width:14px;height:14px;"></i> Generating...' : '<i data-lucide="sparkles" style="width: 14px; height: 14px;"></i> Stories'}
                        </button>
                        <button class="btn-icon-danger" onclick="deleteDocumentDirect(${doc.id}, this)" title="Delete Document">
                            <i data-lucide="trash-2"></i>
                        </button>
                    </div>
                    ` : `<span class="text-muted">—</span>`}
                </td>
            `;
            container.appendChild(row);
        });

        lucide.createIcons();
    } catch (e) {
        container.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--color-danger);">Error: ${e.message}</td></tr>`;
    }
}

// Global scope bindings for inline calls
window.toggleMilestoneStatus = async function (milestoneId, newStatus, triggerBtn) {
    if (!checkAdminAccess("update milestone status")) return;

    // --- Optimistic UI: update the card instantly without waiting for re-fetch ---
    const card = triggerBtn ? triggerBtn.closest(".timeline-card") : null;
    if (card) {
        const isDone = newStatus === "completed";
        // Update the status badge text + class
        const badge = card.querySelector(".status-badge");
        if (badge) {
            badge.textContent = newStatus;
            badge.className = `status-badge ${newStatus}`;
        }
        // Update the node dot colour
        const node = card.querySelector(".timeline-card-node");
        if (node) {
            node.classList.toggle("completed", isDone);
        }
        // Swap the toggle button in place
        const actionsDiv = triggerBtn.parentElement;
        const newBtnHtml = isDone
            ? `<button class="btn btn-secondary btn-sm" onclick="toggleMilestoneStatus(${milestoneId}, 'pending', this)" title="Reopen Milestone"><i data-lucide="rotate-ccw"></i> Reopen</button>`
            : `<button class="btn btn-secondary btn-sm" onclick="toggleMilestoneStatus(${milestoneId}, 'completed', this)" title="Mark Completed"><i data-lucide="check"></i> Complete</button>`;
        triggerBtn.outerHTML = newBtnHtml;
        lucide.createIcons({ nodes: [actionsDiv] });
    }

    try {
        const res = await fetch(`${API_BASE}/api/milestones/${milestoneId}`, {
            method: "PUT",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${state.token}`
            },
            body: JSON.stringify({ status: newStatus })
        });
        if (!res.ok) throw new Error("Could not update milestone");
        showToast(`Milestone updated to ${newStatus}!`, "success");
        // Background sync — keeps data fresh without a visible reload flicker
        if (state.currentProject) {
            loadProjectDetailMilestones(state.currentProject.id);
        } else {
            loadMilestonesRoadmap();
        }
        loadWorkspaceData();
    } catch (e) {
        showToast(e.message, "error");
        // On failure re-render to restore true server state
        if (state.currentProject) {
            loadProjectDetailMilestones(state.currentProject.id);
        } else {
            loadMilestonesRoadmap();
        }
    }
};

window.deleteMilestoneDirect = async function (milestoneId, triggerBtn) {
    if (!checkAdminAccess("delete milestones")) return;
    const confirmDel = confirm("Delete milestone? Associated documents will not be deleted but will be detached.");
    if (!confirmDel) return;

    // --- Optimistic UI: remove the card instantly ---
    const card = triggerBtn ? triggerBtn.closest(".timeline-card") : null;
    if (card) {
        card.style.transition = "opacity 0.2s ease, transform 0.2s ease";
        card.style.opacity = "0";
        card.style.transform = "translateX(-8px)";
        setTimeout(() => card.remove(), 200);
    }

    try {
        const res = await fetch(`${API_BASE}/api/milestones/${milestoneId}`, {
            method: "DELETE",
            headers: { "Authorization": `Bearer ${state.token}` }
        });
        if (!res.ok) throw new Error("Failed to delete milestone");
        showToast("Milestone deleted.");
        if (state.currentProject) {
            loadProjectDetailMilestones(state.currentProject.id);
        } else {
            loadMilestonesRoadmap();
        }
        loadWorkspaceData();
    } catch (e) {
        showToast(e.message, "error");
        // On failure re-render to restore the card
        if (state.currentProject) {
            loadProjectDetailMilestones(state.currentProject.id);
        } else {
            loadMilestonesRoadmap();
        }
    }
};

window.deleteDocumentDirect = async function (documentId, triggerBtn) {
    if (!checkAdminAccess("delete documents")) return;
    const confirmDel = confirm("Delete document? This will remove the file from local storage and purge its semantic vectors from pgvector!");
    if (!confirmDel) return;

    // Optimistic UI: fade-out the table row immediately
    const row = triggerBtn ? triggerBtn.closest("tr") : null;
    if (row) {
        row.style.transition = "opacity 0.2s ease";
        row.style.opacity = "0";
        setTimeout(() => row.remove(), 200);
    }

    try {
        const res = await fetch(`${API_BASE}/api/documents/${documentId}`, {
            method: "DELETE",
            headers: { "Authorization": `Bearer ${state.token}` }
        });
        if (!res.ok) throw new Error("Failed to delete document.");
        showToast("File and vectors purged.");
        if (state.currentProject) {
            loadProjectDetailDocuments(state.currentProject.id);
        }
        loadWorkspaceData();
    } catch (e) {
        showToast(e.message, "error");
        // Restore by re-loading on failure
        if (state.currentProject) {
            loadProjectDetailDocuments(state.currentProject.id);
        }
    }
};

// ─── Document Action Dropdown Helpers ─────────────────────────────────────────

window.closeAllDocMenus = function () {
    document.querySelectorAll(".doc-action-dropdown.open").forEach(d => d.classList.remove("open"));
};

window.toggleDocActionMenu = function (docId, event) {
    event.stopPropagation();
    const dropdown = document.getElementById(`doc-action-dropdown-${docId}`);
    if (!dropdown) return;
    const isOpen = dropdown.classList.contains("open");
    closeAllDocMenus();
    if (!isOpen) {
        dropdown.classList.add("open");
        if (window.lucide) lucide.createIcons({ nodes: [dropdown] });
    }
};

// Close menus when clicking anywhere outside
document.addEventListener("click", function (e) {
    if (!e.target.closest(".doc-action-menu-wrapper")) {
        closeAllDocMenus();
    }
});

// ─── Story Generation from Document ──────────────────────────────────────────

window.generateStoriesFromDocument = async function (projectId, documentId, docName) {
    if (!checkAdminAccess("generate user stories")) return;

    const confirmed = confirm(`Generate User Stories from "${docName}"?\n\nAI will analyse this document and create Agile user stories. Any duplicate stories will be skipped automatically.`);
    if (!confirmed) return;

    if (!state.activeGenerations) state.activeGenerations = {};
    state.activeGenerations[documentId] = true;

    const btn = document.getElementById(`btn-gen-stories-${documentId}`);
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i data-lucide="loader" class="spin" style="width:14px;height:14px;"></i> Generating...';
        if (window.lucide) lucide.createIcons();
    }

    try {
        const res = await fetch(`${API_BASE}/api/projects/${projectId}/stories/generate-from-document`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${state.token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ document_id: documentId })
        });

        if (res.ok) {
            const data = await res.json();
            showToast(data.message || `Stories generated from "${docName}"`, "success");

            // If the user is currently on the User Stories section viewing this project, auto-reload stories list!
            const storyProjSelect = document.getElementById("story-project-select");
            if (state.activeSection === "stories" && storyProjSelect && parseInt(storyProjSelect.value) === projectId) {
                loadStories();
            }
        } else {
            const err = await res.json();
            showToast(err.detail || "Failed to generate stories", "error");
        }
    } catch (e) {
        showToast(`Network error: ${e.message}`, "error");
    } finally {
        if (state.activeGenerations) {
            delete state.activeGenerations[documentId];
        }

        // Re-render documents list if we are still viewing this project detail page, to restore/update button state
        if (state.activeSection === "projects" && state.currentProject && state.currentProject.id === projectId) {
            loadProjectDetailDocuments(projectId);
        } else if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i data-lucide="sparkles" style="width: 14px; height: 14px;"></i> Stories';
            if (window.lucide) lucide.createIcons();
        }
    }
};

window.regenerateStoriesFromDocument = async function (projectId, documentId, docName) {
    if (!checkAdminAccess("regenerate user stories")) return;
    const confirmed = confirm(`Regenerate stories from "${docName}"?\n\nNew stories will be added. Existing stories are kept but duplicates will be skipped automatically.`);
    if (!confirmed) return;

    showToast(`Regenerating stories from "${docName}"...`, "info");

    try {
        const res = await fetch(`${API_BASE}/api/projects/${projectId}/stories/generate-from-document`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${state.token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ document_id: documentId })
        });

        if (res.ok) {
            const data = await res.json();
            showToast(data.message || `Stories regenerated from "${docName}"`, "success");
        } else {
            const err = await res.json();
            showToast(err.detail || "Failed to regenerate stories", "error");
        }
    } catch (e) {
        showToast(`Network error: ${e.message}`, "error");
    }
};

window.downloadDocumentSecurely = async function (documentId, fileName) {
    showToast(`Starting secure download for ${fileName}...`);
    try {
        const res = await fetch(`${API_BASE}/api/documents/download/${documentId}`, {
            headers: { "Authorization": `Bearer ${state.token}` }
        });
        if (!res.ok) throw new Error("Could not access private file server.");

        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
        showToast(`Downloaded: ${fileName}`, "success");
    } catch (e) {
        showToast(e.message, "error");
    }
};

window.uploadToMilestone = function (projectId, milestoneId) {
    if (!checkAdminAccess("upload documents")) return;
    const projSelect = document.getElementById("upload-project-id");
    if (projSelect) {
        projSelect.value = projectId;
    }

    const milestoneSelect = document.getElementById("upload-milestone-id");
    if (milestoneSelect) {
        milestoneSelect.innerHTML = '<option value="">-- No Milestone (Global Project Doc) --</option>';

        fetch(`${API_BASE}/api/milestones/project/${projectId}`, {
            headers: { "Authorization": `Bearer ${state.token}` }
        })
            .then(res => res.json())
            .then(milestones => {
                milestones.forEach(m => {
                    const opt = document.createElement("option");
                    opt.value = m.id;
                    opt.textContent = m.title;
                    if (m.id === milestoneId) {
                        opt.selected = true;
                    }
                    milestoneSelect.appendChild(opt);
                });
            })
            .catch(err => console.error("Error loading milestones for direct upload link:", err));
    }

    window.location.hash = "#uploads";
    showToast("Pre-selected project and milestone for upload!", "success");
};

// =====================================================================
// Milestone Timeline Roadmaps
// =====================================================================
function bindMilestoneEvents() {
    const btnOpen = document.getElementById("btn-open-create-milestone-modal");
    const btnClose = document.getElementById("btn-close-milestone-modal");
    const btnCancel = document.getElementById("btn-cancel-milestone-modal");
    const modal = document.getElementById("create-milestone-modal");
    const form = document.getElementById("create-milestone-form");
    const filter = document.getElementById("milestone-project-filter");

    btnOpen.addEventListener("click", () => {
        if (!checkAdminAccess("create milestones")) return;
        populateProjectDropdowns();
        modal.classList.add("active");
    });
    btnClose.addEventListener("click", () => modal.classList.remove("active"));
    btnCancel.addEventListener("click", () => modal.classList.remove("active"));

    filter.addEventListener("change", loadMilestonesRoadmap);

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!checkAdminAccess("create milestones")) return;
        const project_id = parseInt(document.getElementById("milestone-project-id").value);
        const title = document.getElementById("milestone-title").value;
        const description = document.getElementById("milestone-desc").value;
        const due_date = document.getElementById("milestone-due").value;

        try {
            const res = await fetch(`${API_BASE}/api/milestones`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${state.token}`
                },
                body: JSON.stringify({ project_id, title, description, due_date })
            });

            if (!res.ok) throw new Error("Failed to create milestone");
            const milestoneProjectId = project_id;
            showToast(
                "Milestone created successfully!",
                "success",
                "View on Roadmap",
                "#milestones",
                () => {
                    setTimeout(() => {
                        const filter = document.getElementById("milestone-project-filter");
                        if (filter) {
                            filter.value = project_id;
                            filter.dispatchEvent(new Event("change"));
                        }
                    }, 250);
                }
            );
            form.reset();
            modal.classList.remove("active");
            loadMilestonesRoadmap();
            loadWorkspaceData();
        } catch (e) {
            showToast(e.message, "error");
        }
    });
}

async function loadMilestonesRoadmap() {
    if (!state.token) return;

    const filterVal = document.getElementById("milestone-project-filter").value;
    const container = document.getElementById("roadmap-timeline");

    if (!filterVal) {
        container.innerHTML = `
            <div class="timeline-empty-state">
                <i data-lucide="compass" class="icon-lg"></i>
                <h3>Select a project to view its roadmap timeline.</h3>
                <p>No project is selected or the selected project has no milestones yet.</p>
            </div>
        `;
        lucide.createIcons();
        return;
    }

    container.innerHTML = '<p class="timeline-empty">Loading roadmap...</p>';

    try {
        const res = await fetch(`${API_BASE}/api/milestones/project/${filterVal}`, {
            headers: { "Authorization": `Bearer ${state.token}` }
        });
        const milestones = await res.json();

        container.innerHTML = "";
        if (milestones.length === 0) {
            container.innerHTML = `
                <div class="timeline-empty-state">
                    <i data-lucide="milestone" class="icon-lg"></i>
                    <h3>No milestones found for this project</h3>
                    <p>Create a milestone above to start mapping deadlines.</p>
                </div>
            `;
            lucide.createIcons();
            return;
        }

        const selectedProj = state.projects?.find(p => p.id === parseInt(filterVal));
        const isProjManager = selectedProj && (selectedProj.user_role === 'Manager' || selectedProj.user_role === 'Admin');
        const canManage = state.user?.is_admin || isProjManager;

        // Render roadmap timeline list
        const roadmapWrapper = document.createElement("div");
        roadmapWrapper.className = "milestones-timeline";

        milestones.forEach(milestone => {
            const card = document.createElement("div");
            card.className = "timeline-card";

            const isDone = milestone.status === "completed";
            const nodeClass = isDone ? "completed" : "";
            const formattedDate = milestone.due_date ? new Date(milestone.due_date).toLocaleDateString() : "No due date";

            card.innerHTML = `
                <div class="timeline-card-node ${nodeClass}"></div>
                <div class="timeline-card-header">
                    <h4>${milestone.title}</h4>
                    <span class="status-badge ${milestone.status}">${milestone.status}</span>
                </div>
                <p class="timeline-card-body">${milestone.description || "No details provided."}</p>
                <div class="timeline-card-header">
                    <p><i data-lucide="calendar" style="width:12px;height:12px;display:inline;"></i> Due: ${formattedDate}</p>
                    <div class="timeline-card-actions" style="display: ${canManage ? 'flex' : 'none'};">
                        <button class="btn btn-secondary btn-sm" onclick="uploadToMilestone(${milestone.project_id}, ${milestone.id})" title="Upload Document"><i data-lucide="upload"></i> Upload</button>
                        ${!isDone ? `<button class="btn btn-secondary btn-sm" onclick="toggleMilestoneStatus(${milestone.id}, 'completed', this)" title="Mark Completed"><i data-lucide="check"></i> Complete</button>` : `<button class="btn btn-secondary btn-sm" onclick="toggleMilestoneStatus(${milestone.id}, 'pending', this)" title="Reopen Milestone"><i data-lucide="rotate-ccw"></i> Reopen</button>`}
                        <button class="btn btn-text btn-icon-danger" onclick="deleteMilestoneDirect(${milestone.id}, this)" title="Delete Milestone"><i data-lucide="trash"></i></button>
                    </div>
                </div>
            `;
            roadmapWrapper.appendChild(card);
        });

        container.appendChild(roadmapWrapper);
        lucide.createIcons();
    } catch (e) {
        container.innerHTML = `<p class="timeline-empty error">Error: ${e.message}</p>`;
    }
}

// =====================================================================
// Document Uploads & Dropzone
// =====================================================================
function bindUploadEvents() {
    const dropzone = document.getElementById("dropzone");
    const fileInput = document.getElementById("file-input");
    const projSelect = document.getElementById("upload-project-id");

    // Click triggers browsing
    dropzone.addEventListener("click", () => fileInput.click());

    // Drag-over styling
    dropzone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropzone.classList.add("dragover");
    });

    ["dragleave", "dragend"].forEach(type => {
        dropzone.addEventListener(type, () => {
            dropzone.classList.remove("dragover");
        });
    });

    // Drop handler
    dropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropzone.classList.remove("dragover");
        if (e.dataTransfer.files.length) {
            handleFileUpload(e.dataTransfer.files[0]);
        }
    });

    // File selected handler
    fileInput.addEventListener("change", () => {
        if (fileInput.files.length) {
            handleFileUpload(fileInput.files[0]);
        }
    });

    projSelect.addEventListener("change", triggerProjectChangeInUpload);
}

async function triggerProjectChangeInUpload() {
    const projId = document.getElementById("upload-project-id").value;
    const milestoneSelect = document.getElementById("upload-milestone-id");
    milestoneSelect.innerHTML = '<option value="">-- No Milestone (Global Project Doc) --</option>';

    if (!projId) return;

    try {
        const res = await fetch(`${API_BASE}/api/milestones/project/${projId}`, {
            headers: { "Authorization": `Bearer ${state.token}` }
        });
        const milestones = await res.json();

        milestones.forEach(m => {
            const opt = document.createElement("option");
            opt.value = m.id;
            opt.textContent = m.title;
            milestoneSelect.appendChild(opt);
        });
    } catch (e) {
        console.error("Failed to populate milestones for upload:", e);
    }
}

async function handleFileUpload(file) {
    if (!checkAdminAccess("upload documents")) return;
    const allowedExts = ["pdf", "docx", "doc", "xlsx", "xls", "csv", "html", "htm", "txt"];
    const ext = file.name.split('.').pop().toLowerCase();
    if (!allowedExts.includes(ext)) {
        showToast("Only PDF, DOCX, XLSX, CSV, HTML, and TXT files are allowed. Image files (JPEG, PNG, etc.) are not supported.", "error");
        document.getElementById("file-input").value = "";
        return;
    }

    const projectId = document.getElementById("upload-project-id").value;
    const milestoneId = document.getElementById("upload-milestone-id").value;
    const category = document.getElementById("upload-category") ? document.getElementById("upload-category").value : "team";

    if (!projectId) {
        showToast("Please choose a Target Project first!", "error");
        return;
    }

    if (state.isUploading) {
        showToast("An upload is already in progress. Please wait for it to finish!", "warning");
        return;
    }

    state.isUploading = true;
    const dropzone = document.getElementById("dropzone");
    if (dropzone) dropzone.classList.add("disabled");

    // Show Progress Indicator
    const progressContainer = document.getElementById("upload-progress-container");
    const percentLabel = document.getElementById("upload-percent");
    const fill = document.getElementById("progress-bar-fill");
    const filenameLabel = document.getElementById("upload-filename");
    const statusLabel = document.getElementById("upload-status-text");

    filenameLabel.textContent = file.name;
    percentLabel.textContent = "0%";
    fill.style.width = "0%";
    statusLabel.className = "progress-status"; // Reset class list
    statusLabel.innerHTML = '<i data-lucide="loader" class="spin"></i> Indexing text into vectors... Please wait.';
    progressContainer.classList.remove("hidden");
    lucide.createIcons();

    // Prepare Multipart Form
    const formData = new FormData();
    formData.append("project_id", projectId);
    if (milestoneId) formData.append("milestone_id", milestoneId);
    formData.append("category", category);
    formData.append("file", file);

    try {
        const abortController = new AbortController();
        state.uploadAbortController = abortController;

        // Mock progress bar while FastAPI processes backend vectors
        let fakePercent = 10;
        const interval = setInterval(() => {
            if (fakePercent < 90) {
                fakePercent += Math.floor(Math.random() * 8) + 2;
                fill.style.width = `${fakePercent}%`;
                percentLabel.textContent = `${fakePercent}%`;
            }
        }, 300);
        state.uploadProgressInterval = interval;

        const response = await fetch(`${API_BASE}/api/documents`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${state.token}` },
            body: formData,
            signal: abortController.signal
        });

        clearInterval(interval);
        state.uploadProgressInterval = null;
        state.uploadAbortController = null;

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || "Upload / processing failed.");
        }

        // Ingestion complete
        fill.style.width = "100%";
        percentLabel.textContent = "100%";
        statusLabel.className = "progress-status success";
        statusLabel.innerHTML = '<i data-lucide="check-circle"></i> Indexing complete! Document chunks stored in pgvector.';

        // Build nav link action based on whether we're inside a project
        const uploadedProjectId = parseInt(document.getElementById("upload-project-id")?.value);
        if (uploadedProjectId && state.projects) {
            const targetProject = state.projects.find(p => p.id === uploadedProjectId);
            showToast(
                "Document uploaded and indexed successfully!",
                "success",
                "View in Documents",
                `#projects/${uploadedProjectId}`,
                () => {
                    setTimeout(() => {
                        const docTab = document.getElementById("tab-documents-btn");
                        if (docTab) docTab.click();
                    }, 400);
                }
            );
        } else {
            showToast("Document indexed and vectorized successfully!", "success");
        }

        loadWorkspaceData(); // Refresh Stats

        // Reset file inputs
        document.getElementById("file-input").value = "";
    } catch (e) {
        if (e.name === "AbortError") {
            return;
        }
        fill.style.width = "0%";
        percentLabel.textContent = "0%";
        statusLabel.className = "progress-status error";
        statusLabel.innerHTML = `<i data-lucide="alert-triangle"></i> Error: ${e.message}`;
        showToast(e.message, "error");
    } finally {
        state.isUploading = false;
        const dropzone = document.getElementById("dropzone");
        if (dropzone) dropzone.classList.remove("disabled");
        lucide.createIcons();
    }
}

window.cancelDocumentUpload = function () {
    if (state.uploadAbortController) {
        state.uploadAbortController.abort();
        state.uploadAbortController = null;
    }
    if (state.uploadProgressInterval) {
        clearInterval(state.uploadProgressInterval);
        state.uploadProgressInterval = null;
    }
    state.isUploading = false;
    const dropzone = document.getElementById("dropzone");
    if (dropzone) dropzone.classList.remove("disabled");

    const progressContainer = document.getElementById("upload-progress-container");
    if (progressContainer) progressContainer.classList.add("hidden");
    const fileInput = document.getElementById("file-input");
    if (fileInput) fileInput.value = "";

    showToast("Upload cancelled.", "info");
};

// =====================================================================
// AI Chatbot & RAG Streaming Handlers
// =====================================================================
function bindChatEvents() {
    const projectSelect = document.getElementById("chat-project-id");
    const form = document.getElementById("chat-input-form");
    const input = document.getElementById("chat-message-input");
    const sendBtn = document.getElementById("btn-chat-send");

    projectSelect.addEventListener("change", () => {
        const hasProject = !!projectSelect.value;
        input.disabled = !hasProject;
        sendBtn.disabled = !hasProject;

        document.getElementById("debug-sources-list").innerHTML = `
            <p class="source-empty-state">Select a project, type a question, and sources will load here.</p>
        `;

        const milestoneGroup = document.getElementById("chat-milestone-group");
        const categoryGroup = document.getElementById("chat-category-group");
        const milestoneSelect = document.getElementById("chat-milestone-id");
        milestoneSelect.innerHTML = '<option value="">-- All Milestones (Global Project Docs) --</option>';

        if (hasProject) {
            milestoneGroup.style.display = "block";
            if (categoryGroup) categoryGroup.style.display = "block";
            const projId = parseInt(projectSelect.value);
            fetch(`${API_BASE}/api/milestones/project/${projId}`, {
                headers: { "Authorization": `Bearer ${state.token}` }
            })
                .then(res => res.json())
                .then(milestones => {
                    milestones.forEach(m => {
                        const opt = document.createElement("option");
                        opt.value = m.id;
                        opt.textContent = m.title;
                        milestoneSelect.appendChild(opt);
                    });
                })
                .catch(err => console.error("Error loading milestones for chat scope:", err));

            loadChatHistory(projId);
        } else {
            milestoneGroup.style.display = "none";
            if (categoryGroup) categoryGroup.style.display = "none";
            document.getElementById("chat-conversation-container").innerHTML = `
                <div class="chat-bubble bot-message">
                    <div class="message-header">
                        <span class="bot-tag"><i data-lucide="bot"></i> AI Assistant</span>
                    </div>
                    <div class="message-content">
                        Select a project in the dropdown to begin RAG chatbot session.
                    </div>
                </div>
            `;
            lucide.createIcons();
        }
    });

    form.addEventListener("submit", executeChatQuery);
}

function loadChatHistory(projectId) {
    const container = document.getElementById("chat-conversation-container");

    if (!state.chatSessions) {
        state.chatSessions = {};
    }
    if (!state.chatSessions[projectId]) {
        state.chatSessions[projectId] = [];
    }

    const messages = state.chatSessions[projectId];
    container.innerHTML = "";

    if (messages.length === 0) {
        const project = state.projects ? state.projects.find(p => String(p.id) === String(projectId)) : null;
        const projectName = project ? `"${project.name}"` : "selected";
        container.innerHTML = `
            <div class="chat-bubble bot-message">
                <div class="message-header">
                    <span class="bot-tag"><i data-lucide="bot"></i> AI Assistant</span>
                </div>
                <div class="message-content">
                    Ready to chat! Ask me anything about the ${projectName} project's documents.
                </div>
            </div>
        `;
    } else {
        messages.forEach(msg => {
            appendChatBubble(msg.role === "assistant" ? "bot" : "user", formatMessageContent(msg.content));
        });
    }
    lucide.createIcons();
}

async function executeChatQuery(e) {
    e.preventDefault();
    const projectId = parseInt(document.getElementById("chat-project-id").value);
    const messageInput = document.getElementById("chat-message-input");
    const message = messageInput.value.trim();

    if (!message || isNaN(projectId)) return;

    messageInput.value = "";

    if (!state.chatSessions) {
        state.chatSessions = {};
    }
    if (!state.chatSessions[projectId]) {
        state.chatSessions[projectId] = [];
    }

    // Add user message to session history
    state.chatSessions[projectId].push({ role: "user", content: message });

    // Add user bubble to UI
    appendChatBubble("user", message);

    // Disable inputs
    messageInput.disabled = true;
    document.getElementById("btn-chat-send").disabled = true;

    // Create bot placeholder bubble with loading dots
    const botBubbleId = appendChatBubble("bot", '<span class="pulse">Thinking and retrieving files...</span>');

    // Retrieve last 5 messages from session history (excluding current user message which is already pushed)
    const historyToSend = state.chatSessions[projectId].slice(0, -1).slice(-5);

    const milestoneSelect = document.getElementById("chat-milestone-id");
    const milestoneIdVal = milestoneSelect ? milestoneSelect.value : "";
    const milestoneId = milestoneIdVal ? parseInt(milestoneIdVal) : null;
    const categorySelect = document.getElementById("chat-category");
    const category = categorySelect && categorySelect.value ? categorySelect.value : null;

    try {
        const response = await fetch(`${API_BASE}/api/chat`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${state.token}`
            },
            body: JSON.stringify({
                project_id: projectId,
                message: message,
                milestone_id: milestoneId,
                category: category,
                history: historyToSend
            })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || "Failed to contact RAG engine.");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        let botMessageText = "";
        let sourcesData = [];
        let buffer = "";

        const botBubbleContent = document.getElementById(`msg-content-${botBubbleId}`);
        botBubbleContent.innerHTML = ""; // Clear loader

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");

            // Keep last element (incomplete line) in buffer
            buffer = lines.pop();

            for (const line of lines) {
                const cleanLine = line.trim();
                if (cleanLine.startsWith("data: ")) {
                    const jsonStr = cleanLine.slice(6);
                    try {
                        const payload = JSON.parse(jsonStr);
                        if (payload.type === "sources") {
                            sourcesData = payload.sources;
                            renderRAGDebugSources(sourcesData);
                        } else if (payload.type === "token") {
                            botMessageText += payload.content;
                            // Display streaming token, parse markdown and inline citations
                            botBubbleContent.innerHTML = formatMessageContent(botMessageText);
                        } else if (payload.type === "done") {
                            // Render citations tags at bottom of chat bubble if any
                            if (sourcesData.length > 0) {
                                appendCitationsToBubble(botBubbleId, sourcesData);
                            }
                        }
                    } catch (e) {
                        // Suppress JSON parse failures on empty lines or SSE labels
                    }
                }
            }
        }

        // Add assistant response to session history
        state.chatSessions[projectId].push({ role: "assistant", content: botMessageText });

    } catch (e) {
        document.getElementById(`msg-content-${botBubbleId}`).textContent = `Error: ${e.message}`;
    } finally {
        // Re-enable input
        messageInput.disabled = false;
        document.getElementById("btn-chat-send").disabled = false;
        messageInput.focus();
    }
}

let bubbleCounter = 0;
function appendChatBubble(role, htmlContent) {
    const container = document.getElementById("chat-conversation-container");
    bubbleCounter++;
    const bubbleId = `msg-${Date.now()}-${bubbleCounter}`;

    const bubble = document.createElement("div");
    bubble.className = `chat-bubble ${role}-message`;
    bubble.id = bubbleId;

    const titleStr = role === "bot" ? '<span class="bot-tag"><i data-lucide="bot"></i> AI Assistant</span>' : '<span class="user-tag">You</span>';

    bubble.innerHTML = `
        <div class="message-header">
            ${titleStr}
        </div>
        <div class="message-content" id="msg-content-${bubbleId}">
            ${htmlContent}
        </div>
    `;
    container.appendChild(bubble);

    // Auto-scroll chat window
    container.scrollTop = container.scrollHeight;

    lucide.createIcons();
    return bubbleId;
}

function formatMessageContent(text) {
    if (!text) return "";

    // Escape HTML to prevent XSS (but preserve line breaks we insert)
    let html = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    // Bullet points: lines starting with "***", "* ", or "- "
    html = html.split("\n").map(line => {
        const cleanLine = line.trim();
        if (cleanLine.startsWith("***")) {
            return `<li>**${cleanLine.slice(3)}</li>`;
        } else if (cleanLine.startsWith("* ")) {
            return `<li>${cleanLine.slice(2)}</li>`;
        } else if (cleanLine.startsWith("- ")) {
            return `<li>${cleanLine.slice(2)}</li>`;
        }
        return line;
    }).join("\n");

    // Wrap groups of <li> in <ul>
    html = html.replace(/(<li>.*?<\/li>\n?)+/g, match => `<ul>${match}</ul>`);

    // Bold: **text**
    html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");

    // Parse Inline Citations: [Filename, Page X] or [Filename, Segment Y]
    html = html.replace(/\[([^\]]+?\.(?:pdf|docx|xlsx|csv|html|txt)),\s*([^\]]+)\]/g, (match, docName, pageLabel) => {
        const shortName = docName.length > 20 ? docName.substring(0, 17) + "..." : docName;
        return `<span class="inline-citation-badge" title="${docName}, ${pageLabel}">[${shortName}, ${pageLabel}]</span>`;
    });

    // Replace remaining newlines with <br>
    html = html.replace(/\n/g, "<br>");

    return html;
}

function renderRAGDebugSources(sources) {
    const debugList = document.getElementById("debug-sources-list");
    debugList.innerHTML = "";

    const isDebugActive = document.getElementById("toggle-debug-mode").checked;
    const panel = document.getElementById("citation-explorer-panel");

    if (sources.length === 0) {
        debugList.innerHTML = '<p class="source-empty-state">No context sources were retrieved for this query.</p>';
        return;
    }

    sources.forEach((s, idx) => {
        const pageLabel = s.page ? s.page : `Segment ${s.chunk_index}`;
        const card = document.createElement("div");
        card.className = "source-card";
        card.innerHTML = `
            <div class="source-card-header">
                <span class="source-doc"><i data-lucide="file-text" style="width:12px;height:12px;"></i> ${s.document} (${pageLabel})</span>
            </div>
            <p class="source-snippet">${s.snippet}</p>
        `;
        debugList.appendChild(card);
    });

    lucide.createIcons();
}

function appendCitationsToBubble(bubbleId, sources) {
    const bubble = document.getElementById(bubbleId);
    const citContainer = document.createElement("div");
    citContainer.className = "chat-bubble-sources";

    // Deduplicate sources by filename
    const uniqueDocs = [];
    sources.forEach(s => {
        if (!uniqueDocs.includes(s.document)) {
            uniqueDocs.push(s.document);
        }
    });

    uniqueDocs.forEach(docName => {
        const tag = document.createElement("span");
        tag.className = "citation-tag";
        tag.innerHTML = `<i data-lucide="link" style="width:10px;height:10px;display:inline-block;margin-right:2px;"></i> ${docName}`;

        // Clicking citation opens RAG debugging / details
        tag.addEventListener("click", () => {
            document.getElementById("toggle-debug-mode").checked = true;
            renderRAGDebugSources(sources);
            showToast(`Referenced: ${docName}`);
        });

        citContainer.appendChild(tag);
    });

    bubble.appendChild(citContainer);
    lucide.createIcons();
}

// =====================================================================
// Activity Logs Handlers
// =====================================================================
function bindUploadDropdownEvents() {
    // Left for complex logic
}

function bindChatDropdownEvents() {
    // Left for complex logic
}

function bindSettingsEvents() {
    // Left for complex logic
}

function bindLogsEvents() {
    // Left for complex logic
}

function bindMilestonesFilterEvents() {
    // Left for complex logic
}

function bindActivityTimelineEvents() {
    // Left for complex logic
}

function bindDashboardTimelineEvents() {
    // Left for complex logic
}

function bindDashboardTimelineListEvents() {
    // Left for complex logic
}

function bindDashboardTimelineTimelineEvents() {
    // Left for complex logic
}

function bindTimelineEvents() {
    // Left for complex logic
}

function bindTimelineListEvents() {
    // Left for complex logic
}

function bindTimelineTimelineEvents() {
    // Left for complex logic
}

function bindTimelineTimelineListEvents() {
    // Left for complex logic
}

function bindUploadDropdownOptionEvents() {
    // Left for complex logic
}

function bindChatDropdownOptionEvents() {
    // Left for complex logic
}

function bindSettingsOptionEvents() {
    // Left for complex logic
}

function bindLogsOptionEvents() {
    // Left for complex logic
}

function bindMilestonesFilterOptionEvents() {
    // Left for complex logic
}

function bindActivityTimelineOptionEvents() {
    // Left for complex logic
}

function bindDashboardTimelineOptionEvents() {
    // Left for complex logic
}

function bindDashboardTimelineListOptionEvents() {
    // Left for complex logic
}

function bindDashboardTimelineTimelineOptionEvents() {
    // Left for complex logic
}

function bindTimelineOptionEvents() {
    // Left for complex logic
}

function bindTimelineListOptionEvents() {
    // Left for complex logic
}

function bindTimelineTimelineOptionEvents() {
    // Left for complex logic
}

function bindTimelineTimelineListOptionEvents() {
    // Left for complex logic
}

function bindUploadDropdownButtonEvents() {
    // Left for complex logic
}

function bindChatDropdownButtonEvents() {
    // Left for complex logic
}

function bindSettingsButtonEvents() {
    // Left for complex logic
}

function bindLogsButtonEvents() {
    // Left for complex logic
}

function bindMilestonesFilterButtonEvents() {
    // Left for complex logic
}

function bindActivityTimelineButtonEvents() {
    // Left for complex logic
}

function bindDashboardTimelineButtonEvents() {
    // Left for complex logic
}

function bindDashboardTimelineListButtonEvents() {
    // Left for complex logic
}

function bindDashboardTimelineTimelineButtonEvents() {
    // Left for complex logic
}

function bindTimelineButtonEvents() {
    // Left for complex logic
}

function bindTimelineListButtonEvents() {
    // Left for complex logic
}

function bindTimelineTimelineButtonEvents() {
    // Left for complex logic
}

function bindTimelineTimelineListButtonEvents() {
    // Left for complex logic
}

function bindUploadDropdownCheckboxEvents() {
    // Left for complex logic
}

function bindChatDropdownCheckboxEvents() {
    // Left for complex logic
}

function bindSettingsCheckboxEvents() {
    // Left for complex logic
}

function bindLogsCheckboxEvents() {
    // Left for complex logic
}

function bindMilestonesFilterCheckboxEvents() {
    // Left for complex logic
}

function bindActivityTimelineCheckboxEvents() {
    // Left for complex logic
}

function bindDashboardTimelineCheckboxEvents() {
    // Left for complex logic
}

function bindDashboardTimelineListCheckboxEvents() {
    // Left for complex logic
}

function bindDashboardTimelineTimelineCheckboxEvents() {
    // Left for complex logic
}

function bindTimelineCheckboxEvents() {
    // Left for complex logic
}

function bindTimelineListCheckboxEvents() {
    // Left for complex logic
}

function bindTimelineTimelineCheckboxEvents() {
    // Left for complex logic
}

function bindTimelineTimelineListCheckboxEvents() {
    // Left for complex logic
}

function bindLogsEvents() {
    document.getElementById("btn-refresh-logs").addEventListener("click", loadActivityLogs);
}

async function loadActivityLogs() {
    if (!state.token) return;

    const tbody = document.getElementById("logs-table-body");
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Loading audit logs...</td></tr>';

    try {
        const res = await fetch(`${API_BASE}/api/logs`, {
            headers: { "Authorization": `Bearer ${state.token}` }
        });
        let logs = await res.json();

        // If a global project is selected, filter logs to only show entries for that project (keeping general auth/user logs always visible)
        const selectedProjId = state.globalProjectId || "";
        if (selectedProjId && state.projects) {
            const selectedProj = state.projects.find(p => String(p.id) === String(selectedProjId));
            const projName = selectedProj ? selectedProj.name : "";
            logs = logs.filter(log => {
                if (["login_user", "register_user", "password_reset", "failed_login"].includes(log.action)) {
                    return true;
                }
                const d = (log.details || "").toLowerCase();
                return d.includes(`project '${projName.toLowerCase()}'`) ||
                    d.includes(`project id ${selectedProjId}`) ||
                    d.includes(`(id: ${selectedProjId})`) ||
                    d.includes(`project "${projName.toLowerCase()}"`) ||
                    d.includes(`project ${selectedProjId}`);
            });
        }

        tbody.innerHTML = "";
        if (logs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--color-text-muted);">No logs recorded for the selected scope.</td></tr>';
            return;
        }

        logs.forEach(log => {
            // Append 'Z' to ensure JS parses the timestamp as UTC, then converts to local timezone
            const utcDateStr = log.created_at.endsWith("Z") ? log.created_at : log.created_at + "Z";
            const dateStr = new Date(utcDateStr).toLocaleString();

            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td><code>#${log.id}</code></td>
                <td><strong>${log.user_name}</strong></td>
                <td><span class="action-badge ${log.action}">${log.action}</span></td>
                <td>${log.details}</td>
                <td><span class="text-muted">${dateStr}</span></td>
            `;
            tbody.appendChild(tr);
        });
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--color-danger);">Error: ${e.message}</td></tr>`;
    }
}

// =====================================================================
// Dropdowns helper
// =====================================================================
async function populateProjectDropdowns() {
    if (!state.token) return;

    const uploadProjSelect = document.getElementById("upload-project-id");
    const chatProjSelect = document.getElementById("chat-project-id");
    const filterProjSelect = document.getElementById("milestone-project-filter");
    const createMilestoneSelect = document.getElementById("milestone-project-id");
    const storyProjSelect = document.getElementById("story-project-select");
    const globalSelect = document.getElementById("global-project-select");

    try {
        const res = await fetch(`${API_BASE}/api/projects`, {
            headers: { "Authorization": `Bearer ${state.token}` }
        });
        const projects = await res.json();
        state.projects = projects;

        // Save current selections to restore after re-population
        const valUpload = uploadProjSelect.value;
        const valChat = chatProjSelect.value;
        const valFilter = filterProjSelect.value;
        const valCreate = createMilestoneSelect.value;
        const valStory = storyProjSelect ? storyProjSelect.value : "";
        const valGlobal = globalSelect ? (globalSelect.value || state.globalProjectId || "") : "";

        // Clear all dropdowns
        uploadProjSelect.innerHTML = '<option value="">-- Choose Project --</option>';
        chatProjSelect.innerHTML = '<option value="">-- Choose Project --</option>';
        filterProjSelect.innerHTML = '<option value="">-- Choose Project --</option>';
        createMilestoneSelect.innerHTML = '<option value="">-- Choose Project --</option>';
        if (storyProjSelect) storyProjSelect.innerHTML = '<option value="">-- Choose Project --</option>';
        if (globalSelect) globalSelect.innerHTML = '<option value="">— Select a project —</option>';

        projects.forEach(p => {
            const makeOpt = () => {
                const o = document.createElement("option");
                o.value = p.id;
                o.textContent = p.name;
                return o;
            };
            uploadProjSelect.appendChild(makeOpt());
            chatProjSelect.appendChild(makeOpt());
            filterProjSelect.appendChild(makeOpt());
            createMilestoneSelect.appendChild(makeOpt());
            if (storyProjSelect) storyProjSelect.appendChild(makeOpt());
            if (globalSelect) globalSelect.appendChild(makeOpt());
        });

        // Restore values — prefer global selection for all page dropdowns
        const effectiveGlobal = valGlobal || state.globalProjectId || "";
        if (globalSelect) {
            globalSelect.value = effectiveGlobal;
            // Maintain bold visual emphasis
            if (effectiveGlobal) {
                globalSelect.classList.add("selected-bold");
            } else {
                globalSelect.classList.remove("selected-bold");
            }
        }

        // If global project is set, propagate it to all page dropdowns
        if (effectiveGlobal) {
            uploadProjSelect.value = effectiveGlobal;
            chatProjSelect.value = effectiveGlobal;
            filterProjSelect.value = effectiveGlobal;
            createMilestoneSelect.value = effectiveGlobal;
            if (storyProjSelect) storyProjSelect.value = effectiveGlobal;

            // Dispatch change event to trigger dependent handlers (like chat milestones/input)
            chatProjSelect.dispatchEvent(new Event("change"));

            // Trigger dependent loads only if they are the currently active section
            if (state.activeSection === "milestones") loadMilestonesRoadmap();
            if (state.activeSection === "stories" && storyProjSelect && storyProjSelect.value) loadStories();
        } else {
            // No global — restore individual saved values, but fallback to state.currentProject.id if available
            const fallbackProjId = state.currentProject ? String(state.currentProject.id) : "";
            uploadProjSelect.value = valUpload || fallbackProjId;
            chatProjSelect.value = valChat || fallbackProjId;
            filterProjSelect.value = valFilter || fallbackProjId;
            createMilestoneSelect.value = valCreate || fallbackProjId;
            if (storyProjSelect) storyProjSelect.value = valStory || fallbackProjId;
        }

    } catch (e) {
        console.error("Failed to fetch projects list for dropdowns:", e);
    }
}

// ── Global Project Selector: propagate selection to all page dropdowns ──
document.addEventListener("DOMContentLoaded", () => {
    const globalSelect = document.getElementById("global-project-select");
    if (!globalSelect) return;

    globalSelect.addEventListener("change", () => {
        const selectedId = globalSelect.value;
        state.globalProjectId = selectedId;
        if (selectedId) {
            localStorage.setItem("globalProjectId", selectedId);
        } else {
            localStorage.removeItem("globalProjectId");
        }

        // Toggle bold visual emphasis on the selector
        if (selectedId) {
            globalSelect.classList.add("selected-bold");
        } else {
            globalSelect.classList.remove("selected-bold");
        }

        // Update sidebar visibility for non-admin users (unlocks nav on project select)
        applyRBACUI();

        // Propagate to every page-level dropdown
        const ids = [
            "upload-project-id",
            "chat-project-id",
            "milestone-project-filter",
            "milestone-project-id",
            "story-project-select"
        ];
        ids.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.value = selectedId;
                // Dispatch change event to trigger local page event listeners
                el.dispatchEvent(new Event("change"));
            }
        });

        // Reload only the active section
        if (state.activeSection === "dashboard") loadDashboardStats();
        if (state.activeSection === "logs") loadActivityLogs();
        if (state.activeSection === "projects") loadProjects();
        if (state.activeSection === "mytasks") loadMyTasks();
        if (state.activeSection === "milestones") loadMilestonesRoadmap();
        if (state.activeSection === "stories") loadStories();
        if (state.activeSection === "chat") {
            const chatEl = document.getElementById("chat-project-id");
            if (chatEl) chatEl.dispatchEvent(new Event("change"));
        }

        if (selectedId) {
            showToast(`Active project set — all fields updated`, "success");
        }
    });
});

// =====================================================================
// Jira User Stories Handlers
// =====================================================================
document.getElementById("story-project-select")?.addEventListener("change", loadStories);

// Manual Story Creation
const btnOpenStoryModal = document.getElementById("btn-open-create-story-modal");
const btnCloseStoryModal = document.getElementById("btn-close-story-modal");
const btnCancelStoryModal = document.getElementById("btn-cancel-story-modal");
const storyModal = document.getElementById("create-story-modal");
const storyForm = document.getElementById("create-story-form");

if (btnOpenStoryModal) btnOpenStoryModal.addEventListener("click", () => {
    if (!checkAdminAccess("create user stories")) return;
    const projectId = document.getElementById("story-project-select").value;
    if (!projectId) {
        showToast("Please select a project first", "error");
        return;
    }
    storyModal.classList.add("active");
});
if (btnCloseStoryModal) btnCloseStoryModal.addEventListener("click", () => storyModal.classList.remove("active"));
if (btnCancelStoryModal) btnCancelStoryModal.addEventListener("click", () => storyModal.classList.remove("active"));

if (storyForm) storyForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!checkAdminAccess("create user stories")) return;
    const submitBtn = storyForm.querySelector('button[type="submit"]');
    if (submitBtn && submitBtn.disabled) return;

    const projectId = document.getElementById("story-project-select").value;
    if (!projectId) return;

    const origBtnText = submitBtn ? submitBtn.innerHTML : "Create Story";
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i data-lucide="loader" style="width: 14px; height: 14px;"></i> Creating...';
        if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons();
    }

    const title = document.getElementById("story-title-input").value;
    const desc = document.getElementById("story-desc-input").value;
    const priority = document.getElementById("story-priority-input").value;
    const points = parseInt(document.getElementById("story-points-input").value);

    const acRaw = document.getElementById("story-ac-input")?.value || "";
    const acList = acRaw.split("\n").map(s => s.trim()).filter(s => s.length > 0);

    const subtasksRaw = document.getElementById("story-subtasks-input")?.value || "";
    const subtasksList = subtasksRaw.split("\n").map(s => s.trim()).filter(s => s.length > 0);

    try {
        const response = await fetch(`${API_BASE}/api/projects/${projectId}/stories`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${state.token}`
            },
            body: JSON.stringify({
                title: title,
                description: desc,
                acceptance_criteria: acList,
                priority: priority,
                story_points: points,
                status: "To Do",
                comments: []
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || "Could not create story.");
        }

        const createdStory = await response.json();

        // Create subtasks if any were entered
        for (const line of subtasksList) {
            let role = "Backend";
            let titleText = line;
            const match = line.match(/^(.*?)\s*\[(Frontend|Backend|AI|Manager)\]\s*$/i);
            if (match) {
                titleText = match[1].trim();
                const matchedRole = match[2].toLowerCase();
                if (matchedRole === "frontend") role = "Frontend";
                else if (matchedRole === "ai") role = "AI";
                else if (matchedRole === "manager") role = "Manager";
                else role = "Backend";
            }
            if (titleText) {
                await fetch(`${API_BASE}/api/projects/${projectId}/stories/${createdStory.id}/tasks`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${state.token}`
                    },
                    body: JSON.stringify({
                        title: titleText,
                        task_type: role,
                        status: "To Do"
                    })
                });
            }
        }

        showToast("User story created successfully!", "success");
        storyForm.reset();
        storyModal.classList.remove("active");
        loadStories(); // Refresh list
    } catch (e) {
        showToast(e.message, "error");
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = origBtnText;
        }
    }
});

// Edit Profile Modal
const editProfileModal = document.getElementById("edit-profile-modal");
const btnEditProfile = document.getElementById("btn-edit-profile");
const btnCloseEditProfileModal = document.getElementById("btn-close-edit-profile-modal");
const btnCancelEditProfileModal = document.getElementById("btn-cancel-edit-profile-modal");
const editProfileForm = document.getElementById("edit-profile-form");

if (btnEditProfile) {
    btnEditProfile.addEventListener("click", () => {
        if (!state.user) return;
        document.getElementById("edit-profile-name").value = state.user.full_name || "";
        // Pre-fill avatar preview
        const prevChar = document.getElementById("avatar-preview-char");
        const prevImg = document.getElementById("avatar-preview-img");
        if (state.user.profile_image && prevImg) {
            prevImg.src = state.user.profile_image;
            prevImg.style.display = "block";
            if (prevChar) prevChar.style.display = "none";
        } else {
            if (prevChar) { prevChar.textContent = (state.user.full_name?.[0] || "U").toUpperCase(); prevChar.style.display = "flex"; }
            if (prevImg) prevImg.style.display = "none";
        }
        if (window.lucide) window.lucide.createIcons();
        editProfileModal.classList.add("active");
    });
}

if (btnCloseEditProfileModal) {
    btnCloseEditProfileModal.addEventListener("click", () => {
        editProfileModal.classList.remove("active");
    });
}

if (btnCancelEditProfileModal) {
    btnCancelEditProfileModal.addEventListener("click", () => {
        editProfileModal.classList.remove("active");
    });
}

if (editProfileForm) {
    // Preview selected avatar
    const avatarInput = document.getElementById("edit-profile-avatar");
    if (avatarInput) {
        avatarInput.addEventListener("change", (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                const prevImg = document.getElementById("avatar-preview-img");
                const prevChar = document.getElementById("avatar-preview-char");
                if (prevImg) { prevImg.src = ev.target.result; prevImg.style.display = "block"; }
                if (prevChar) prevChar.style.display = "none";
            };
            reader.readAsDataURL(file);
        });
    }

    editProfileForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const submitBtn = editProfileForm.querySelector('button[type="submit"]');
        const origBtnText = submitBtn.innerHTML;
        submitBtn.disabled = true;
        submitBtn.innerHTML = "Saving...";

        const name = document.getElementById("edit-profile-name").value.trim();
        const avatarFile = document.getElementById("edit-profile-avatar")?.files[0];

        try {
            // 1. Upload avatar first if a new file was selected
            let newAvatarUrl = state.user.profile_image || null;
            if (avatarFile) {
                const formData = new FormData();
                formData.append("file", avatarFile);
                const avatarRes = await fetch(`${API_BASE}/api/auth/me/avatar`, {
                    method: "POST",
                    headers: { "Authorization": `Bearer ${state.token}` },
                    body: formData
                });
                if (!avatarRes.ok) {
                    const d = await avatarRes.json();
                    throw new Error(d.detail || "Failed to upload profile photo");
                }
                const avatarData = await avatarRes.json();
                newAvatarUrl = avatarData.profile_image_url;
            }

            // 2. Save name via existing PUT /me
            const body = { full_name: name };
            const res = await fetch(`${API_BASE}/api/auth/me`, {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${state.token}`
                },
                body: JSON.stringify(body)
            });

            if (!res.ok) {
                const data = await res.json();
                throw new Error(data.detail || "Failed to update profile");
            }

            const updatedUser = await res.json();
            state.user = { ...updatedUser, profile_image: newAvatarUrl };

            // Update sidebar
            const nameEl = document.getElementById("user-fullname");
            const emailEl = document.getElementById("user-email");
            const avatarCharEl = document.getElementById("user-avatar-char");
            const sidebarImg = document.getElementById("sidebar-avatar-img");
            if (nameEl) nameEl.textContent = updatedUser.full_name;
            if (emailEl) emailEl.textContent = updatedUser.email;
            if (newAvatarUrl) {
                if (sidebarImg) { sidebarImg.src = newAvatarUrl; sidebarImg.style.display = "block"; }
                if (avatarCharEl) avatarCharEl.style.display = "none";
            } else {
                if (avatarCharEl) { avatarCharEl.textContent = updatedUser.full_name ? updatedUser.full_name.charAt(0).toUpperCase() : "U"; avatarCharEl.style.display = "flex"; }
                if (sidebarImg) sidebarImg.style.display = "none";
            }

            showToast("Profile updated successfully", "success");
            editProfileModal.classList.remove("active");

            // Reload active section so name updates propagate to UI lists immediately
            if (state.activeSection === "dashboard") loadDashboardStats();
            else if (state.activeSection === "projects") loadProjects();
            else if (state.activeSection === "stories") loadStories();
            else if (state.activeSection === "mytasks") loadMyTasks();
            else if (state.activeSection === "logs") loadActivityLogs();
            else if (state.activeSection === "milestones") loadMilestonesRoadmap();
        } catch (e) {
            showToast(e.message, "error");
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = origBtnText;
        }
    });
}

// Invite User Modal
const inviteModal = document.getElementById("invite-user-modal");
const btnCloseInviteModal = document.getElementById("btn-close-invite-modal");
const btnCancelInviteModal = document.getElementById("btn-cancel-invite-modal");
const inviteForm = document.getElementById("invite-user-form");

function triggerOpenInviteModal(e) {
    if (e) e.preventDefault();
    if (!checkAdminAccess("invite users")) return;
    const projectSelect = document.getElementById("invite-project-select");
    if (projectSelect) {
        projectSelect.innerHTML = '<option value="">-- None (Just Register) --</option>';
        if (state.projects && state.projects.length > 0) {
            state.projects.forEach(p => {
                const opt = document.createElement("option");
                opt.value = p.id;
                opt.textContent = p.name;
                if (state.currentProject && state.currentProject.id === p.id) {
                    opt.selected = true;
                }
                projectSelect.appendChild(opt);
            });
        }
    }
    const modalEl = document.getElementById("invite-user-modal");
    if (modalEl) modalEl.classList.add("active");
}

document.body.addEventListener("click", (e) => {
    const btn = e.target.closest(".btn-open-invite-modal");
    if (btn) {
        triggerOpenInviteModal(e);
    }
});

if (btnCloseInviteModal) btnCloseInviteModal.addEventListener("click", () => inviteModal.classList.remove("active"));
if (btnCancelInviteModal) btnCancelInviteModal.addEventListener("click", () => inviteModal.classList.remove("active"));

if (inviteForm) inviteForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!checkAdminAccess("invite users")) return;

    const email = document.getElementById("invite-email-input").value.trim();
    const fullName = document.getElementById("invite-fullname-input").value.trim();
    const projIdVal = document.getElementById("invite-project-select").value;
    const role = document.getElementById("invite-role-select").value;

    try {
        const response = await fetch(`${API_BASE}/api/auth/invite`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${state.token}`
            },
            body: JSON.stringify({
                email: email,
                full_name: fullName,
                project_id: projIdVal ? parseInt(projIdVal) : null,
                role: role
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || "Could not invite user.");
        }

        const data = await response.json();
        showToast(data.detail, "success");
        inviteForm.reset();
        inviteModal.classList.remove("active");

        if (state.currentProject && projIdVal && parseInt(projIdVal) === state.currentProject.id) {
            loadTeamMembers(state.currentProject.id);
        }
    } catch (err) {
        showToast(err.message, "error");
    }
});


// Assign Admin Modal
const assignAdminModal = document.getElementById("assign-admin-modal");
const btnCloseAssignAdminModal = document.getElementById("btn-close-assign-admin-modal");
const btnCancelAssignAdminModal = document.getElementById("btn-cancel-assign-admin-modal");
const assignAdminForm = document.getElementById("assign-admin-form");

async function triggerOpenAssignAdminModal(e) {
    if (e) e.preventDefault();
    if (!checkAdminAccess("assign administrator privileges")) return;

    const selectEl = document.getElementById("assign-admin-select");
    if (selectEl) {
        selectEl.innerHTML = '<option value="">Loading users...</option>';
        try {
            const res = await fetch(`${API_BASE}/api/auth/users`, {
                headers: { "Authorization": `Bearer ${state.token}` }
            });
            if (!res.ok) throw new Error("Could not fetch users list");
            const users = await res.json();
            selectEl.innerHTML = '<option value="">-- Select Registered User --</option>';
            users.forEach(u => {
                const opt = document.createElement("option");
                opt.value = u.id;
                const adminTag = u.is_admin ? " [ADMIN]" : "";
                opt.textContent = `${u.full_name} (${u.email})${adminTag}`;
                selectEl.appendChild(opt);
            });
        } catch (err) {
            selectEl.innerHTML = '<option value="">Error loading users</option>';
            showToast(err.message, "error");
        }
    }

    const modalEl = document.getElementById("assign-admin-modal");
    if (modalEl) modalEl.classList.add("active");
}

document.body.addEventListener("click", (e) => {
    const btn = e.target.closest(".btn-open-assign-admin-modal");
    if (btn) {
        triggerOpenAssignAdminModal(e);
    }
});

if (btnCloseAssignAdminModal) btnCloseAssignAdminModal.addEventListener("click", () => assignAdminModal?.classList.remove("active"));
if (btnCancelAssignAdminModal) btnCancelAssignAdminModal.addEventListener("click", () => assignAdminModal?.classList.remove("active"));

if (assignAdminForm) assignAdminForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!checkAdminAccess("assign administrator privileges")) return;

    const userIdVal = document.getElementById("assign-admin-select").value;
    const isAdminVal = document.getElementById("assign-admin-action").value === "true";

    if (!userIdVal) {
        showToast("Please select a user.", "error");
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/api/auth/assign-admin`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${state.token}`
            },
            body: JSON.stringify({
                user_id: parseInt(userIdVal),
                is_admin: isAdminVal
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || "Could not update user privileges.");
        }

        const data = await response.json();
        showToast(data.detail, "success");
        assignAdminForm.reset();
        assignAdminModal?.classList.remove("active");

        // If updating current user's own privileges, update profile state
        if (state.user && state.user.id === parseInt(userIdVal)) {
            fetchUserProfile();
        }
    } catch (err) {
        showToast(err.message, "error");
    }
});


state.storyAssigneeFilter = "all";

document.getElementById("btn-toggle-backlog")?.addEventListener("click", () => {
    localStorage.setItem("stories_view_tab", "backlog");
    document.getElementById("btn-toggle-backlog").classList.add("active");
    document.getElementById("btn-toggle-backlog").style.color = "#2563eb";
    document.getElementById("btn-toggle-backlog").style.borderBottom = "2px solid #2563eb";

    document.getElementById("btn-toggle-board").classList.remove("active");
    document.getElementById("btn-toggle-board").style.color = "var(--color-text-muted)";
    document.getElementById("btn-toggle-board").style.borderBottom = "2px solid transparent";

    document.getElementById("btn-toggle-list")?.classList.remove("active");
    if (document.getElementById("btn-toggle-list")) {
        document.getElementById("btn-toggle-list").style.color = "var(--color-text-muted)";
        document.getElementById("btn-toggle-list").style.borderBottom = "2px solid transparent";
    }

    document.getElementById("stories-backlog-view").classList.remove("hidden");
    document.getElementById("stories-board-view").classList.add("hidden");
    document.getElementById("stories-list-view")?.classList.add("hidden");
});

document.getElementById("btn-toggle-board")?.addEventListener("click", () => {
    localStorage.setItem("stories_view_tab", "board");
    document.getElementById("btn-toggle-board").classList.add("active");
    document.getElementById("btn-toggle-board").style.color = "#2563eb";
    document.getElementById("btn-toggle-board").style.borderBottom = "2px solid #2563eb";

    document.getElementById("btn-toggle-backlog").classList.remove("active");
    document.getElementById("btn-toggle-backlog").style.color = "var(--color-text-muted)";
    document.getElementById("btn-toggle-backlog").style.borderBottom = "2px solid transparent";

    document.getElementById("btn-toggle-list")?.classList.remove("active");
    if (document.getElementById("btn-toggle-list")) {
        document.getElementById("btn-toggle-list").style.color = "var(--color-text-muted)";
        document.getElementById("btn-toggle-list").style.borderBottom = "2px solid transparent";
    }

    document.getElementById("stories-backlog-view").classList.add("hidden");
    document.getElementById("stories-board-view").classList.remove("hidden");
    document.getElementById("stories-list-view")?.classList.add("hidden");

    applyStoriesFilters();
});

document.getElementById("btn-toggle-list")?.addEventListener("click", () => {
    localStorage.setItem("stories_view_tab", "list");
    document.getElementById("btn-toggle-list").classList.add("active");
    document.getElementById("btn-toggle-list").style.color = "#2563eb";
    document.getElementById("btn-toggle-list").style.borderBottom = "2px solid #2563eb";

    document.getElementById("btn-toggle-backlog").classList.remove("active");
    document.getElementById("btn-toggle-backlog").style.color = "var(--color-text-muted)";
    document.getElementById("btn-toggle-backlog").style.borderBottom = "2px solid transparent";

    document.getElementById("btn-toggle-board").classList.remove("active");
    document.getElementById("btn-toggle-board").style.color = "var(--color-text-muted)";
    document.getElementById("btn-toggle-board").style.borderBottom = "2px solid transparent";

    document.getElementById("stories-backlog-view").classList.add("hidden");
    document.getElementById("stories-board-view").classList.add("hidden");
    document.getElementById("stories-list-view")?.classList.remove("hidden");

    applyStoriesFilters();
});

document.getElementById("filter-all-work")?.addEventListener("click", () => {
    state.storyAssigneeFilter = "all";
    document.getElementById("filter-all-work").style.background = "#2563eb";
    document.getElementById("filter-all-work").style.color = "#fff";
    document.getElementById("filter-my-work").style.background = "transparent";
    document.getElementById("filter-my-work").style.color = "var(--color-text-main)";
    applyStoriesFilters();
});

document.getElementById("filter-my-work")?.addEventListener("click", () => {
    state.storyAssigneeFilter = "mine";
    document.getElementById("filter-my-work").style.background = "#2563eb";
    document.getElementById("filter-my-work").style.color = "#fff";
    document.getElementById("filter-all-work").style.background = "transparent";
    document.getElementById("filter-all-work").style.color = "var(--color-text-main)";
    applyStoriesFilters();
});

document.getElementById("story-search")?.addEventListener("input", applyStoriesFilters);
document.getElementById("story-filter-priority")?.addEventListener("change", applyStoriesFilters);

document.getElementById("btn-generate-stories")?.addEventListener("click", async () => {
    if (!checkAdminAccess("generate user stories")) return;
    const projectId = document.getElementById("story-project-select").value;
    if (!projectId) {
        showToast("Please select a project first", "error");
        return;
    }

    if (state.stories && state.stories.length > 0) {
        if (!confirm("User stories have already been generated/created for this project. Are you sure you want to generate stories again? This will query the AI and may incur duplicate API costs.")) {
            return;
        }
    } else {
        if (!confirm("Are you sure you want to generate user stories from this project's documents using AI? This will query the AI and incur API usage costs.")) {
            return;
        }
    }

    const btn = document.getElementById("btn-generate-stories");
    btn.innerHTML = `<i class="lucide-loader animate-spin"></i> Generating...`;
    btn.disabled = true;

    try {
        const res = await fetch(`${API_BASE}/api/projects/${projectId}/stories/generate`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${state.token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({})
        });

        if (res.ok) {
            const data = await res.json();
            showToast(data.message || "Successfully generated stories", "success");
            loadStories();
        } else {
            const err = await res.json();
            showToast(err.detail || "Failed to generate stories", "error");
        }
    } catch (e) {
        showToast("Network error generating stories", "error");
    } finally {
        btn.innerHTML = `<i data-lucide="sparkles"></i> Generate Stories with AI`;
        btn.disabled = false;
        if (window.lucide) lucide.createIcons();
    }
});

function getProjectKeyPrefix(projectId) {
    const pId = projectId || document.getElementById("story-project-select")?.value || state.currentProject?.id || state.globalProjectId || 1;
    let proj = null;
    if (state.currentProject && String(state.currentProject.id) === String(pId)) {
        proj = state.currentProject;
    } else if (state.projects && state.projects.length > 0) {
        proj = state.projects.find(p => String(p.id) === String(pId));
    }
    if (proj && proj.name) {
        const cleanName = proj.name.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (cleanName.length >= 3) {
            return cleanName.slice(0, 3);
        } else if (cleanName.length > 0) {
            return cleanName;
        }
    }
    return "PH0" + pId;
}

function formatStoryKey(story, projectId) {
    const projKey = getProjectKeyPrefix(projectId);
    let seq = story.seqNumber;
    if (!seq && state.stories && state.stories.length > 0) {
        const idx = state.stories.findIndex(s => String(s.id) === String(story.id));
        if (idx !== -1) seq = idx + 1;
    }
    return `${projKey}-${seq || story.id}`;
}

async function loadStories() {
    const projectId = document.getElementById("story-project-select")?.value;
    const listContainer = document.getElementById("stories-backlog-list");
    const detailPanel = document.getElementById("story-detail-panel");

    if (!listContainer) return;

    if (!projectId) {
        listContainer.innerHTML = `<div class="empty-state" style="padding: 40px; text-align: center; color: var(--color-text-muted); background: #F1F5F9; border-radius: 8px;">Please select a project to view or generate its user stories.</div>`;
        showStoryDetailPlaceholder(detailPanel);
        state.stories = [];
        state.selectedStoryId = null;
        applyStoriesFilters();
        return;
    }

    listContainer.innerHTML = `<div style="text-align: center; padding: 20px;">Loading stories...</div>`;

    try {
        const [storiesRes, teamRes] = await Promise.all([
            fetch(`${API_BASE}/api/projects/${projectId}/stories`, {
                headers: { "Authorization": `Bearer ${state.token}` }
            }),
            fetch(`${API_BASE}/api/projects/${projectId}/team`, {
                headers: { "Authorization": `Bearer ${state.token}` }
            }).catch(e => null)
        ]);

        if (!storiesRes.ok) throw new Error("Failed to load stories");

        const stories = await storiesRes.json();
        stories.sort((a, b) => (a.id || 0) - (b.id || 0));
        stories.forEach((s, idx) => {
            s.seqNumber = idx + 1;
        });
        state.stories = stories;

        if (teamRes && teamRes.ok) {
            state.projectMembers = await teamRes.json();
        } else {
            state.projectMembers = [];
        }

        applyStoriesFilters();
        const savedTab = localStorage.getItem("stories_view_tab");
        if (savedTab === "list") {
            document.getElementById("btn-toggle-list")?.click();
        } else if (savedTab === "board") {
            document.getElementById("btn-toggle-board")?.click();
        }

    } catch (e) {
        listContainer.innerHTML = `<div style="color: var(--color-danger); text-align: center;">Error loading stories: ${e.message}<br><small style="font-size:0.8em;opacity:0.7;">${e.stack || ""}</small></div>`;
        console.error("Story load error:", e);
    }
}
function applyStoriesFilters() {
    window.applyStoriesFilters = applyStoriesFilters;
    const projectId = document.getElementById("story-project-select")?.value;
    const listContainer = document.getElementById("stories-backlog-list");
    const detailPanel = document.getElementById("story-detail-panel");
    if (!listContainer) return;

    const query = document.getElementById("story-search")?.value?.toLowerCase() || "";
    const priority = document.getElementById("story-filter-priority")?.value || "";

    const priorityWeights = { 'Critical': 1, 'High': 2, 'Medium': 3, 'Low': 4 };
    const filtered = (state.stories || []).filter(story => {
        const matchesQuery = !query ||
            story.title.toLowerCase().includes(query) ||
            (story.description && story.description.toLowerCase().includes(query));
        const matchesPriority = !priority || story.priority === priority;
        let matchesAssignee = true;
        if (state.storyAssigneeFilter === "mine") {
            const hasMyTask = (story.tasks || []).some(t => t.assigned_to === state.user?.id);
            matchesAssignee = hasMyTask;
        }
        return matchesQuery && matchesPriority && matchesAssignee;
    }).sort((a, b) => {
        return (a.id || 0) - (b.id || 0);
    });

    const tabCount = document.getElementById("tab-backlog-count");
    if (tabCount) tabCount.textContent = filtered.length;
    const panelCount = document.getElementById("panel-backlog-count");
    if (panelCount) panelCount.textContent = filtered.length;
    const listTabCount = document.getElementById("tab-list-count");
    if (listTabCount) listTabCount.textContent = filtered.length;

    if (filtered.length === 0) {
        if (!projectId) {
            listContainer.innerHTML = `<div class="empty-state" style="padding: 40px; text-align: center; color: var(--color-text-muted); background: #F1F5F9; border-radius: 8px;">Please select a project to view or generate its user stories.</div>`;
        } else {
            listContainer.innerHTML = `<div class="empty-state" style="padding: 40px; text-align: center; color: var(--color-text-muted); background: #F1F5F9; border-radius: 8px;">No matching stories found.</div>`;
        }
        showStoryDetailPlaceholder(detailPanel);
        renderBoardList([]);
        renderStoriesListView([], projectId);
        return;
    }

    const currentlySelectedStory = state.selectedStoryId ? (state.stories || []).find(s => s.id === state.selectedStoryId) : null;
    if (!currentlySelectedStory) {
        showStoryDetailPlaceholder(detailPanel);
    } else {
        renderStoryDetail(projectId, currentlySelectedStory);
    }
    listContainer.innerHTML = "";

    // Render Jira Layout via inline CSS for layout if not in CSS
    const jiraLayout = document.querySelector(".jira-layout");
    if (jiraLayout) {
        jiraLayout.style.display = "grid";
        jiraLayout.style.gridTemplateColumns = "1fr 1fr";
        jiraLayout.style.gap = "20px";
        jiraLayout.style.alignItems = "start";
    }

    filtered.forEach(story => {
        const itemHTML = document.createElement("div");
        itemHTML.style.cssText = "padding: 12px 16px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 8px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; transition: background 0.2s;";
        itemHTML.onmouseover = () => itemHTML.style.background = "#F1F5F9";
        itemHTML.onmouseout = () => itemHTML.style.background = "var(--bg-card)";

        const storyKey = formatStoryKey(story, projectId);
        const isOnHold = story.is_on_hold || story.status === 'On Hold';
        itemHTML.innerHTML = `
            <div style="display: flex; align-items: flex-start; gap: 12px; margin-right: 15px; flex-grow: 1; flex-direction: column;">
                <div style="display: flex; align-items: flex-start; gap: 8px;">
                    <div style="margin-top: 2px;"><i data-lucide="${isOnHold ? 'pause-circle' : 'bookmark'}" style="color: ${isOnHold ? '#d97706' : '#2563eb'}; width: 18px; height: 18px; flex-shrink: 0;"></i></div>
                    <span style="font-weight: 700; font-family: monospace; color: #2563EB; font-size: 0.85rem; text-decoration: underline; flex-shrink: 0; margin-top: 1px;">${storyKey}</span>
                    <span style="font-weight: 500; font-size: 0.95rem; color: var(--color-text-main); line-height: 1.4;">${story.title}</span>
                </div>
                <div style="display: flex; gap: 10px; align-items: center; margin-left: 26px; margin-top: 4px; flex-wrap: wrap;">
                    <span style="font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; font-weight: 600; background: rgba(107, 114, 128, 0.1); color: var(--color-text-muted);">${story.story_points || 1} SP</span>
                    <span style="font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; font-weight: 600; background: ${story.priority === 'Critical' || story.priority === 'High' ? 'rgba(239, 68, 68, 0.1)' : 'rgba(59, 130, 246, 0.1)'}; color: ${story.priority === 'Critical' || story.priority === 'High' ? '#ef4444' : '#2563eb'};">${story.priority || 'Medium'}</span>
                    ${isOnHold ? `<span style="font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; font-weight: 700; background: #FEF3C7; color: #D97706; display: inline-flex; align-items: center; gap: 3px;"><i data-lucide="pause-circle" style="width:11px;height:11px;"></i> ON HOLD</span>` : ''}
                </div>
            </div>
            <span style="font-size: 0.75rem; background: ${isOnHold ? '#FEF3C7' : 'rgba(59, 130, 246, 0.15)'}; color: ${isOnHold ? '#D97706' : '#2563eb'}; padding: 4px 8px; border-radius: 4px; font-weight: 600; white-space: nowrap; flex-shrink: 0;">${isOnHold ? 'On Hold' : story.status}</span>
        `;

        if (story.id === state.selectedStoryId) {
            itemHTML.style.borderLeft = "4px solid #2563eb";
            itemHTML.style.background = "#F1F5F9";
            itemHTML.onmouseout = null;
        }

        itemHTML.addEventListener("click", () => {
            // Highlight active item
            Array.from(listContainer.children).forEach(c => {
                c.style.borderLeft = "1px solid var(--border-color)";
                c.style.background = "var(--bg-card)";
                c.onmouseout = () => c.style.background = "var(--bg-card)";
            });
            itemHTML.style.borderLeft = "4px solid #2563eb";
            itemHTML.style.background = "#F1F5F9";
            itemHTML.onmouseout = null; // keep highlight

            renderStoryDetail(projectId, story);
        });

        listContainer.appendChild(itemHTML);
    });

    if (window.lucide) lucide.createIcons();

    renderBoardList(filtered);
    renderStoriesListView(filtered, projectId);
};

async function updateStoryField(projectId, storyId, field, value) {
    try {
        const body = {};
        body[field] = value;
        const res = await fetch(`${API_BASE}/api/projects/${projectId}/stories/${storyId}`, {
            method: "PUT",
            headers: {
                "Authorization": `Bearer ${state.token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error("Failed to update story");
        showToast("Story updated", "success");
        loadStories(); // Refresh backlog list and potentially panel
    } catch (e) {
        showToast(e.message, "error");
    }
}

async function updateTaskField(projectId, storyId, taskId, field, value) {
    const isGlobalAdmin = state.user?.is_admin;
    const selectedProj = state.projects?.find(p => p.id === parseInt(projectId));
    const isProjManager = selectedProj && (selectedProj.user_role === 'Manager' || selectedProj.user_role === 'Admin');
    const isAdmin = isGlobalAdmin || isProjManager;
    const story = (state.stories || []).find(s => s.id === storyId);
    const task = story?.tasks?.find(t => t.id === taskId);

    if (!isAdmin) {
        if (field !== "status") {
            showToast("Only administrators can edit task details.", "error");
            return;
        }
        if (task && task.assigned_to !== state.user?.id) {
            showToast("You can only update the status of tasks assigned to you.", "error");
            return;
        }
    }

    try {
        const body = {};
        body[field] = value;
        const res = await fetch(`${API_BASE}/api/projects/${projectId}/stories/${storyId}/tasks/${taskId}`, {
            method: "PUT",
            headers: {
                "Authorization": `Bearer ${state.token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error("Failed to update task");

        const updatedTask = await res.json();

        // Update local state
        const story = state.stories.find(s => s.id === storyId);
        if (story) {
            const task = story.tasks.find(t => t.id === taskId);
            if (task) {
                Object.assign(task, updatedTask);
            }
            // Re-render the detail panel to reflect changes
            renderStoryDetail(projectId, story);
        }

        showToast("Task updated", "success");
        applyStoriesFilters();
    } catch (e) {
        showToast(e.message, "error");
    }
}

function showStoryDetailPlaceholder(panel) {
    state.selectedStoryId = null;
    if (!panel) return;
    panel.innerHTML = `
        <div class="empty-state" style="padding: 40px; text-align: center; color: var(--color-text-muted); display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; min-height: 300px;">
            <div style="opacity: 0.5; margin-bottom: 16px;"><i data-lucide="book-open" style="width: 48px; height: 48px;"></i></div>
            <h3 style="font-weight: 600; font-size: 1.1rem; margin: 0; color: var(--color-text-main);">No story selected</h3>
            <p style="margin-top: 8px; font-size: 0.9rem; max-width: 250px; margin-left: auto; margin-right: auto; line-height: 1.4;">Select a user story from the backlog to view and edit its details.</p>
        </div>
    `;
    if (window.lucide) lucide.createIcons();
}

function closeStoryDetail() {
    window.closeStoryDetail = closeStoryDetail;
    const panel = document.getElementById("story-detail-panel");
    showStoryDetailPlaceholder(panel);

    // Clear active backlog item highlights
    const listContainer = document.getElementById("stories-backlog-list");
    if (listContainer) {
        Array.from(listContainer.children).forEach(c => {
            c.style.borderLeft = "1px solid var(--border-color)";
            c.style.background = "var(--bg-card)";
            c.onmouseout = () => c.style.background = "var(--bg-card)";
        });
    }

    // Restore backlog view layout if it was maximized
    const view = document.getElementById("stories-backlog-view");
    const backlog = document.getElementById("backlog-list-container");
    if (view && backlog) {
        view.classList.remove("detail-maximized");
        backlog.style.removeProperty("display");
        view.style.gridTemplateColumns = "1fr 1fr";
    }
}

window.toggleStoryDetailMaximize = function () {
    const view = document.getElementById("stories-backlog-view");
    const backlog = document.getElementById("backlog-list-container");
    const detail = document.getElementById("story-detail-panel");
    const maxBtn = document.getElementById("btn-story-maximize");
    if (!view || !backlog || !detail) return;

    const isMaximized = view.classList.toggle("detail-maximized");

    if (isMaximized) {
        backlog.style.setProperty("display", "none", "important");
        view.style.gridTemplateColumns = "1fr";
        if (maxBtn) {
            maxBtn.title = "Minimize Details";
            maxBtn.innerHTML = '<i data-lucide="minimize-2" style="width: 16px; height: 16px;"></i>';
        }
    } else {
        backlog.style.removeProperty("display");
        view.style.gridTemplateColumns = "1fr 1fr";
        if (maxBtn) {
            maxBtn.title = "Maximize Details";
            maxBtn.innerHTML = '<i data-lucide="maximize-2" style="width: 16px; height: 16px;"></i>';
        }
    }
    if (window.lucide) lucide.createIcons();
};

window.toggleStoryOnHold = async function (projectId, storyId, isOnHold) {
    try {
        const res = await fetch(`${API_BASE}/api/projects/${projectId}/stories/${storyId}`, {
            method: "PUT",
            headers: {
                "Authorization": `Bearer ${state.token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ is_on_hold: isOnHold })
        });
        if (!res.ok) throw new Error("Failed to update story hold status");
        const updatedStory = await res.json();
        if (state.stories) {
            const idx = state.stories.findIndex(s => s.id === storyId);
            if (idx !== -1) {
                state.stories[idx].is_on_hold = isOnHold;
            }
        }
        showToast(isOnHold ? "Story put ON HOLD" : "Story resumed ACTIVE status", "success");
        applyStoriesFilters();
    } catch (err) {
        console.error(err);
        showToast("Error toggling on hold status", "error");
    }
};

function renderStoryDetail(projectId, story) {
    state.selectedStoryId = story?.id || null;
    const panel = document.getElementById("story-detail-panel");
    panel.classList.remove("hidden");

    const isMax = document.getElementById("stories-backlog-view")?.classList.contains("detail-maximized");
    const maxIcon = isMax ? "minimize-2" : "maximize-2";
    const maxTitle = isMax ? "Minimize Details" : "Maximize Details";
    const isGlobalAdmin = state.user?.is_admin;
    const selectedProj = state.projects?.find(p => p.id === parseInt(projectId));
    const isProjManager = selectedProj && (selectedProj.user_role === 'Manager' || selectedProj.user_role === 'Admin');
    const isAdmin = isGlobalAdmin || isProjManager;
    const isOnHold = story.is_on_hold || story.status === 'On Hold';

    const acList = (story.acceptance_criteria || []).map((ac, idx) => `
        <div style="display: flex; align-items: center; gap: 10px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 6px; padding: 8px 12px; margin-bottom: 8px;">
            <span style="color: var(--color-primary); font-weight: 700; font-size: 0.85rem; min-width: 20px;">${idx + 1}.</span>
            <input type="text" class="editable-input" data-idx="${idx}" value="${(ac || '').replace(/"/g, '&quot;')}" style="flex-grow: 1; background: transparent; border: none; color: var(--color-text-main); font-size: 0.95rem; outline: none; font-family: inherit;" ${isAdmin ? '' : 'readonly'}>
            ${isAdmin ? `
            <button type="button" onclick="removeAcceptanceCriterion(${projectId}, ${story.id}, ${idx})" style="cursor: pointer; width: 26px; height: 26px; border-radius: 4px; display: flex; align-items: center; justify-content: center; background: transparent; border: none; color: #EF4444; flex-shrink: 0; transition: background 0.15s;" onmouseover="this.style.background='rgba(239, 68, 68, 0.1)'" onmouseout="this.style.background='transparent'" title="Delete Criterion">
                <i data-lucide="x" style="width: 16px; height: 16px;"></i>
            </button>
            ` : ''}
        </div>`).join("");

    const tasksList = (story.tasks || []).map(t => {
        let badgeBg = "#E0F2FE"; let badgeColor = "#0284C7";
        if (t.task_type === "Frontend") { badgeBg = "#FFEDD5"; badgeColor = "#C2410C"; }
        else if (t.task_type === "AI") { badgeBg = "#DCFCE7"; badgeColor = "#15803D"; }
        else if (t.task_type === "Manager") { badgeBg = "#F3E8FF"; badgeColor = "#7E22CE"; }

        const membersOptions = (state.projectMembers || []).map(m => `
            <option value="${m.user_id}" ${t.assigned_to === m.user_id ? 'selected' : ''}>${m.user_name}</option>
        `).join("");

        return `
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 6px; padding: 10px 14px; margin-bottom: 8px;">
            <!-- Left: Subtask Type Badge + Title -->
            <div style="display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0;">
                <span style="font-size: 0.7rem; font-weight: 700; padding: 3px 8px; border-radius: 4px; background: ${badgeBg}; color: ${badgeColor}; text-transform: uppercase; white-space: nowrap; flex-shrink: 0;">
                    ${t.task_type || 'Task'}
                </span>
                <input type="text" value="${(t.title || '').replace(/"/g, '&quot;')}" onchange="updateTaskField(${projectId}, ${story.id}, ${t.id}, 'title', this.value)" style="flex: 1; background: transparent; border: none; font-size: 0.95rem; font-weight: 500; color: var(--color-text-main); outline: none; text-overflow: ellipsis;" ${isAdmin ? '' : 'readonly'}>
            </div>
            <!-- Right: Assignee, Status, Delete -->
            <div style="display: flex; align-items: center; gap: 8px; flex-shrink: 0;">
                <select onchange="updateTaskField(${projectId}, ${story.id}, ${t.id}, 'assigned_to', this.value ? parseInt(this.value) : null)" style="background: var(--bg-body); border: 1px solid var(--border-color); padding: 5px 10px; border-radius: 6px; font-size: 0.8rem; color: var(--color-text-main); cursor: pointer;" ${isAdmin ? '' : 'disabled'}>
                    <option value="">Unassigned</option>
                    ${membersOptions}
                </select>
                <select onchange="updateTaskField(${projectId}, ${story.id}, ${t.id}, 'status', this.value)" style="background: rgba(14, 165, 233, 0.12); color: #0284C7; border: 1px solid rgba(14, 165, 233, 0.3); padding: 5px 10px; border-radius: 6px; font-size: 0.8rem; font-weight: 600; cursor: pointer;">
                    <option value="To Do" ${t.status === 'To Do' ? 'selected' : ''}>To Do</option>
                    <option value="In Progress" ${t.status === 'In Progress' ? 'selected' : ''}>In Progress</option>
                    <option value="Dev Done" ${t.status === 'Dev Done' ? 'selected' : ''}>Dev Done</option>
                    <option value="Ready for QA" ${t.status === 'Ready for QA' ? 'selected' : ''}>Ready for QA</option>
                    <option value="QA Done" ${t.status === 'QA Done' ? 'selected' : ''}>QA Done</option>
                    <option value="Complete" ${t.status === 'Complete' || t.status === 'Done' ? 'selected' : ''}>Complete</option>
                </select>
                ${isAdmin ? `
                <button type="button" onclick="deleteTask(${projectId}, ${story.id}, ${t.id})" style="width: 26px; height: 26px; border-radius: 4px; border: none; background: transparent; color: #EF4444; display: flex; align-items: center; justify-content: center; cursor: pointer;" title="Delete Subtask">
                    <i data-lucide="trash-2" style="width: 15px; height: 15px;"></i>
                </button>
                ` : ''}
            </div>
        </div>
        `;
    }).join("");

    const commentsList = (story.comments || []).map(c => `
        <div style="background: var(--bg-body); border: 1px solid var(--border-color); padding: 10px 14px; border-radius: 8px; font-size: 0.9rem; margin-bottom: 8px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 4px; align-items: center;">
                <strong style="color: var(--color-text-main); font-size: 0.85rem;">${c.author || 'Anonymous'}</strong>
                <span style="font-size: 0.75rem; color: var(--color-text-muted);">${c.timestamp || ''}</span>
            </div>
            <div style="color: var(--color-text-main); line-height: 1.4; margin-top: 4px;">${c.text}</div>
        </div>
    `).join("");

    panel.innerHTML = `
        <!-- Jira Header Bar -->
        <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border-color); padding-bottom: 14px; margin-bottom: 24px;">
            <!-- Left: Jira Issue Type Icon + Key -->
            <div style="display: flex; align-items: center; gap: 10px;">
                <span style="display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; background: #E0F2FE; color: #0284C7; border-radius: 6px;" title="User Story">
                    <i data-lucide="bookmark" style="width: 16px; height: 16px; fill: currentColor;"></i>
                </span>
                <span style="font-size: 0.95rem; font-weight: 700; color: #2563EB; font-family: monospace; letter-spacing: 0.4px;">
                    ${formatStoryKey(story, projectId)}
                </span>
                ${isOnHold ? '<span style="background: #FEF3C7; color: #D97706; font-size: 0.75rem; font-weight: 700; padding: 3px 10px; border-radius: 12px; border: 1px solid #FCD34D;">ON HOLD</span>' : ''}
            </div>
            <!-- Right: Action Buttons -->
            <div style="display: flex; align-items: center; gap: 8px;">
                ${isAdmin ? `
                <button onclick="deleteStory(${projectId}, ${story.id})" class="btn btn-secondary btn-sm" style="color: #EF4444; border-color: rgba(239, 68, 68, 0.2); background: rgba(239, 68, 68, 0.05); display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 6px;" title="Delete Story">
                    <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i> Delete
                </button>
                ` : ''}
                <button id="btn-story-maximize" onclick="toggleStoryDetailMaximize()" class="btn btn-secondary btn-sm" style="padding: 6px 10px; border-radius: 6px; display: flex; align-items: center;" title="${maxTitle}">
                    <i data-lucide="${maxIcon}" style="width: 16px; height: 16px;"></i>
                </button>
                <button onclick="closeStoryDetail()" class="btn btn-secondary btn-sm" style="padding: 6px 10px; border-radius: 6px; display: flex; align-items: center;" title="Close Details">
                    <i data-lucide="x" style="width: 16px; height: 16px;"></i>
                </button>
            </div>
        </div>

        <!-- Jira Two-Column Layout -->
        <div style="display: flex; flex-wrap: wrap; gap: 28px; align-items: flex-start;">
            <!-- Left Column: Main Issue Content -->
            <div style="flex: 1 1 440px; min-width: 0;">
                <!-- Summary / Title -->
                <div style="position: relative; margin-bottom: 24px;">
                    <textarea id="title-input-${story.id}" ${isAdmin ? '' : 'readonly'} oninput="document.getElementById('title-save-btn-${story.id}').style.display = 'flex';" rows="1" style="font-size: 1.4rem; font-weight: 700; color: var(--color-text-main); background: transparent; border: 1px solid transparent; width: 100%; padding: 6px 8px; border-radius: 6px; resize: none; overflow: hidden; line-height: 1.35; font-family: inherit; transition: border-color 0.15s, background 0.15s;" onfocus="this.style.border='1px solid var(--border-color)'; this.style.background='var(--bg-card)';" onblur="this.style.border='1px solid transparent'; this.style.background='transparent';">${story.title}</textarea>
                    <div id="title-save-btn-${story.id}" style="display: none; margin-top: 8px; gap: 8px; justify-content: flex-end;">
                        <button type="button" onclick="updateStoryField(${projectId}, ${story.id}, 'title', document.getElementById('title-input-${story.id}').value); this.parentElement.style.display='none';" class="btn btn-primary" style="padding: 4px 12px; font-size: 0.85rem; font-weight: 600;">Save</button>
                        <button type="button" onclick="document.getElementById('title-input-${story.id}').value = \`${(story.title || '').replace(/`/g, '\\`')}\`; this.parentElement.style.display='none';" class="btn btn-secondary" style="padding: 4px 12px; font-size: 0.85rem; font-weight: 600;">Cancel</button>
                    </div>
                </div>

                <!-- Description Section -->
                <div style="margin-bottom: 28px;">
                    <h4 style="font-size: 0.8rem; font-weight: 700; color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin: 0 0 10px 0; display: flex; align-items: center; gap: 8px;">
                        <i data-lucide="align-left" style="width: 16px; height: 16px; color: var(--color-primary);"></i> Description
                    </h4>
                    <div style="position: relative;">
                        <textarea id="desc-input-${story.id}" ${isAdmin ? '' : 'readonly'} oninput="document.getElementById('desc-save-btn-${story.id}').style.display = 'flex';" placeholder="Add a description..." style="width: 100%; min-height: 90px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 8px; padding: 12px; color: var(--color-text-main); font-size: 0.95rem; line-height: 1.5; resize: vertical; font-family: inherit;">${story.description || ''}</textarea>
                        <div id="desc-save-btn-${story.id}" style="display: none; margin-top: 8px; gap: 8px; justify-content: flex-end;">
                            <button type="button" onclick="updateStoryField(${projectId}, ${story.id}, 'description', document.getElementById('desc-input-${story.id}').value); this.parentElement.style.display='none';" class="btn btn-primary" style="padding: 4px 12px; font-size: 0.85rem; font-weight: 600;">Save</button>
                            <button type="button" onclick="document.getElementById('desc-input-${story.id}').value = \`${(story.description || '').replace(/`/g, '\\`')}\`; this.parentElement.style.display='none';" class="btn btn-secondary" style="padding: 4px 12px; font-size: 0.85rem; font-weight: 600;">Cancel</button>
                        </div>
                    </div>
                </div>

                <!-- Acceptance Criteria Section -->
                <div style="margin-bottom: 28px;">
                    <h4 style="font-size: 0.8rem; font-weight: 700; color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin: 0 0 12px 0; display: flex; align-items: center; gap: 8px;">
                        <i data-lucide="check-square" style="width: 16px; height: 16px; color: var(--color-primary);"></i> Acceptance Criteria
                    </h4>
                    <div id="ac-list-${story.id}">
                        ${acList || '<div style="color: var(--color-text-muted); font-size: 0.9rem; font-style: italic; margin-bottom: 10px;">No acceptance criteria yet.</div>'}
                    </div>
                    ${isAdmin ? `
                    <div style="display: flex; gap: 8px; margin-top: 12px;">
                        <input type="text" id="new-ac-input-${story.id}" placeholder="Add acceptance criterion..." style="flex-grow: 1; padding: 8px 12px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-card); color: var(--color-text-main); font-size: 0.9rem;">
                        <button type="button" onclick="addAcceptanceCriterion(${projectId}, ${story.id})" class="btn btn-secondary btn-sm" style="display: flex; align-items: center; gap: 6px; font-weight: 600; padding: 0 14px; height: 38px;">
                            <i data-lucide="plus" style="width: 14px; height: 14px;"></i> Add
                        </button>
                    </div>
                    ` : ''}
                </div>

                <!-- Subtasks Section -->
                <div style="margin-bottom: 28px;">
                    <h4 style="font-size: 0.8rem; font-weight: 700; color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin: 0 0 12px 0; display: flex; align-items: center; gap: 8px;">
                        <i data-lucide="layers" style="width: 16px; height: 16px; color: var(--color-primary);"></i> Subtasks
                    </h4>
                    <div id="tasks-list-${story.id}">
                        ${tasksList || '<div style="color: var(--color-text-muted); font-size: 0.9rem; font-style: italic; margin-bottom: 10px;">No subtasks yet. Create a subtask below.</div>'}
                    </div>
                    ${isAdmin ? `
                    <div style="display: flex; gap: 8px; margin-top: 12px; align-items: center; background: var(--bg-body); border: 1px dashed var(--border-color); padding: 10px 14px; border-radius: 8px; flex-wrap: wrap;">
                        <input type="text" id="new-task-title-${story.id}" placeholder="What needs to be done?" style="flex-grow: 1; min-width: 180px; padding: 8px 12px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-card); color: var(--color-text-main); font-size: 0.9rem;">
                        <select id="new-task-type-${story.id}" style="padding: 8px 12px; border: 1px solid var(--border-color); border-radius: 6px; background: var(--bg-card); color: var(--color-text-main); font-size: 0.85rem; font-weight: 600; cursor: pointer;">
                            <option value="Frontend">Frontend</option>
                            <option value="Backend" selected>Backend</option>
                            <option value="AI">AI</option>
                            <option value="Manager">Manager</option>
                        </select>
                        <button type="button" onclick="addStoryTask(${projectId}, ${story.id})" class="btn btn-primary btn-sm" style="display: flex; align-items: center; gap: 6px; height: 38px; padding: 0 16px; cursor: pointer; white-space: nowrap; font-weight: 600;">
                            <i data-lucide="plus" style="width: 14px; height: 14px;"></i> Create Subtask
                        </button>
                    </div>
                    ` : ''}
                </div>

                <!-- Comments Section -->
                <div style="border-top: 1px solid var(--border-color); padding-top: 24px;">
                    <h4 style="font-size: 0.8rem; font-weight: 700; color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin: 0 0 14px 0; display: flex; align-items: center; gap: 8px;">
                        <i data-lucide="message-square" style="width: 16px; height: 16px; color: var(--color-primary);"></i> Comments
                    </h4>
                    <div id="story-comments-list" style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 15px; max-height: 240px; overflow-y: auto;">
                        ${commentsList || '<div style="color: var(--color-text-muted); font-size: 0.9rem; font-style: italic;">No comments yet.</div>'}
                    </div>
                    <div style="display: flex; gap: 10px;">
                        <input type="text" id="new-comment-text" placeholder="Add a comment..." style="flex-grow: 1; padding: 8px 12px; border: 1px solid var(--border-color); border-radius: 8px; background: var(--bg-card); color: var(--color-text-main); font-size: 0.9rem;">
                        <button type="button" onclick="addStoryComment(${projectId}, ${story.id})" class="btn btn-primary" style="padding: 8px 16px; font-size: 0.9rem; display: flex; align-items: center; gap: 6px; font-weight: 600;">
                            <i data-lucide="send" style="width: 14px; height: 14px;"></i> Send
                        </button>
                    </div>
                </div>
            </div>

            <!-- Right Column: Jira Details Sidebar -->
            <div style="width: 280px; flex-shrink: 0; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 8px; padding: 18px;">
                <!-- Status Dropdown Pill -->
                <div style="margin-bottom: 20px;">
                    <label style="font-size: 0.72rem; font-weight: 700; color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.5px; display: block; margin-bottom: 6px;">
                        Status
                    </label>
                    <select onchange="updateStoryField(${projectId}, ${story.id}, 'status', this.value)" style="width: 100%; background: #E0F2FE; color: #0284C7; border: 1px solid #BAE6FD; padding: 8px 12px; border-radius: 6px; font-weight: 700; font-size: 0.9rem; cursor: pointer;">
                        <option value="To Do" ${story.status === 'To Do' ? 'selected' : ''}>TO DO</option>
                        <option value="In Progress" ${story.status === 'In Progress' ? 'selected' : ''}>IN PROGRESS</option>
                        <option value="Dev Done" ${story.status === 'Dev Done' ? 'selected' : ''}>DEV DONE</option>
                        <option value="Ready for QA" ${story.status === 'Ready for QA' ? 'selected' : ''}>READY FOR QA</option>
                        <option value="QA Done" ${story.status === 'QA Done' ? 'selected' : ''}>QA DONE</option>
                        <option value="Complete" ${story.status === 'Complete' || story.status === 'Done' ? 'selected' : ''}>COMPLETE</option>
                        <option value="On Hold" ${story.status === 'On Hold' ? 'selected' : ''}>ON HOLD</option>
                    </select>
                </div>

                <!-- Details List -->
                <div style="border-top: 1px solid var(--border-color); padding-top: 16px;">
                    <h4 style="font-size: 0.78rem; font-weight: 700; color: var(--color-text-main); text-transform: uppercase; letter-spacing: 0.5px; margin: 0 0 14px 0;">
                        Details
                    </h4>

                    <!-- Priority -->
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;">
                        <span style="font-size: 0.85rem; color: var(--color-text-muted); font-weight: 600;">Priority</span>
                        <select ${isAdmin ? '' : 'disabled'} onchange="updateStoryField(${projectId}, ${story.id}, 'priority', this.value)" style="background: var(--bg-body); border: 1px solid var(--border-color); padding: 5px 10px; border-radius: 6px; color: var(--color-text-main); font-size: 0.85rem; font-weight: 600; cursor: pointer;">
                            <option value="Low" ${story.priority === 'Low' ? 'selected' : ''}>Low</option>
                            <option value="Medium" ${story.priority === 'Medium' ? 'selected' : ''}>Medium</option>
                            <option value="High" ${story.priority === 'High' ? 'selected' : ''}>High</option>
                            <option value="Critical" ${story.priority === 'Critical' ? 'selected' : ''}>Critical</option>
                        </select>
                    </div>

                    <!-- Story Points -->
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;">
                        <span style="font-size: 0.85rem; color: var(--color-text-muted); font-weight: 600;">Story Points</span>
                        <select ${isAdmin ? '' : 'disabled'} onchange="updateStoryField(${projectId}, ${story.id}, 'story_points', parseInt(this.value))" style="background: var(--bg-body); border: 1px solid var(--border-color); padding: 5px 10px; border-radius: 6px; color: var(--color-text-main); font-size: 0.85rem; font-weight: 600; cursor: pointer;">
                            <option value="1" ${story.story_points === 1 ? 'selected' : ''}>1 SP</option>
                            <option value="2" ${story.story_points === 2 ? 'selected' : ''}>2 SP</option>
                            <option value="3" ${story.story_points === 3 ? 'selected' : ''}>3 SP</option>
                            <option value="5" ${story.story_points === 5 ? 'selected' : ''}>5 SP</option>
                            <option value="8" ${story.story_points === 8 ? 'selected' : ''}>8 SP</option>
                        </select>
                    </div>

                    <!-- On Hold Toggle -->
                    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px;">
                        <span style="font-size: 0.85rem; color: var(--color-text-muted); font-weight: 600;">On Hold</span>
                        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                            <span style="background: ${isOnHold ? '#F59E0B' : 'var(--border-color)'}; color: #fff; padding: 2px 8px; border-radius: 12px; font-size: 0.72rem; font-weight: 700;">
                                ${isOnHold ? 'ON HOLD' : 'ACTIVE'}
                            </span>
                            <input type="checkbox" ${isOnHold ? 'checked' : ''} onchange="toggleStoryOnHold(${projectId}, ${story.id}, this.checked)" style="width: 16px; height: 16px; accent-color: #F59E0B; cursor: pointer;">
                        </label>
                    </div>
                </div>
            </div>
        </div>
    `;

    // Add event listeners for Acceptance Criteria changes
    const inputs = panel.querySelectorAll('.editable-input');
    inputs.forEach(input => {
        input.addEventListener('change', () => {
            const newACs = Array.from(inputs).map(inp => inp.value);
            updateStoryField(projectId, story.id, 'acceptance_criteria', newACs);
        });
    });

    panel.querySelector("#new-comment-text")?.addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
            addStoryComment(projectId, story.id);
        }
    });

    panel.querySelector(`#new-ac-input-${story.id}`)?.addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            addAcceptanceCriterion(projectId, story.id);
        }
    });

    panel.querySelector(`#new-task-title-${story.id}`)?.addEventListener("keypress", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            addStoryTask(projectId, story.id);
        }
    });

    if (window.lucide) lucide.createIcons();

    setTimeout(() => {
        panel.querySelectorAll("textarea").forEach(ta => {
            ta.style.height = 'auto';
            ta.style.height = (ta.scrollHeight) + 'px';
        });
    }, 10);
}

window.addStoryComment = async function (projectId, storyId) {
    const input = document.getElementById("new-comment-text");
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;

    // Create new comment object
    const newComment = {
        id: Math.random().toString(36).substr(2, 9),
        author: state.user ? state.user.full_name : "Anonymous",
        text: text,
        timestamp: new Date().toLocaleString()
    };

    // Find story in state to get existing comments
    const story = (state.stories || []).find(s => s.id === storyId);
    if (!story) return;

    const existingComments = story.comments || [];
    const updatedComments = [...existingComments, newComment];

    try {
        const body = { comments: updatedComments };
        const res = await fetch(`${API_BASE}/api/projects/${projectId}/stories/${storyId}`, {
            method: "PUT",
            headers: {
                "Authorization": `Bearer ${state.token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        });

        if (!res.ok) throw new Error("Failed to add comment");

        showToast("Comment added", "success");
        input.value = "";

        // Reload all stories and render story detail
        await loadStories();

        const refreshedStory = (state.stories || []).find(s => s.id === storyId);
        if (refreshedStory) {
            renderStoryDetail(projectId, refreshedStory);
        }
    } catch (e) {
        showToast(e.message, "error");
    }
};

window.deleteStory = async function (projectId, storyId, skipConfirm = false, skipReload = false) {
    if (!checkAdminAccess("delete user stories")) return;
    if (!skipConfirm && !confirm("Are you sure you want to delete this user story? This will also delete all of its tasks.")) return;
    try {
        const res = await fetch(`${API_BASE}/api/projects/${projectId}/stories/${storyId}`, {
            method: "DELETE",
            headers: { "Authorization": `Bearer ${state.token}` }
        });
        if (res.ok) {
            if (!skipConfirm) showToast("User story deleted", "success");
            closeStoryDetail();
            if (!skipReload) loadStories();
        } else {
            const err = await res.json();
            showToast(err.detail || "Failed to delete story", "error");
        }
    } catch (e) {
        showToast(e.message, "error");
    }
};

window.deleteTask = async function (projectId, storyId, taskId) {
    if (!checkAdminAccess("delete tasks")) return;
    if (!confirm("Are you sure you want to delete this task?")) return;
    try {
        const res = await fetch(`${API_BASE}/api/projects/${projectId}/stories/${storyId}/tasks/${taskId}`, {
            method: "DELETE",
            headers: { "Authorization": `Bearer ${state.token}` }
        });
        if (res.ok) {
            showToast("Task deleted", "success");
            await loadStories();

            // Reload story details panel
            const sRes = await fetch(`${API_BASE}/api/projects/${projectId}/stories`, {
                headers: { "Authorization": `Bearer ${state.token}` }
            });
            if (sRes.ok) {
                const stories = await sRes.json();
                const currentStory = stories.find(s => s.id === storyId);
                if (currentStory) {
                    renderStoryDetail(projectId, currentStory);
                } else {
                    document.getElementById("story-detail-panel").classList.add("hidden");
                }
            }
        } else {
            const err = await res.json();
            showToast(err.detail || "Failed to delete task", "error");
        }
    } catch (e) {
        showToast(e.message, "error");
    }
};

window.addAcceptanceCriterion = async function (projectId, storyId) {
    if (!checkAdminAccess("edit story details")) return;
    const input = document.getElementById(`new-ac-input-${storyId}`);
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;

    const story = (state.stories || []).find(s => s.id === storyId);
    if (!story) return;

    const existingACs = story.acceptance_criteria || [];
    const updatedACs = [...existingACs, text];

    try {
        await updateStoryField(projectId, storyId, 'acceptance_criteria', updatedACs);
        input.value = "";

        await loadStories();
        const refreshedStory = (state.stories || []).find(s => s.id === storyId);
        if (refreshedStory) {
            renderStoryDetail(projectId, refreshedStory);
        }
    } catch (e) {
        showToast(e.message, "error");
    }
};

window.removeAcceptanceCriterion = async function (projectId, storyId, idx) {
    if (!checkAdminAccess("edit story details")) return;
    if (!confirm("Are you sure you want to delete this acceptance criterion?")) return;
    const story = (state.stories || []).find(s => s.id === storyId);
    if (!story) return;
    const updatedACs = (story.acceptance_criteria || []).filter((_, i) => i !== idx);
    try {
        await updateStoryField(projectId, storyId, 'acceptance_criteria', updatedACs);
        await loadStories();
        const refreshedStory = (state.stories || []).find(s => s.id === storyId);
        if (refreshedStory) {
            renderStoryDetail(projectId, refreshedStory);
        }
    } catch (e) {
        showToast(e.message, "error");
    }
};

window.addStoryTask = async function (projectId, storyId) {
    if (!checkAdminAccess("create tasks")) return;
    const titleInput = document.getElementById(`new-task-title-${storyId}`);
    const typeSelect = document.getElementById(`new-task-type-${storyId}`);
    if (!titleInput || !typeSelect) return;

    const title = titleInput.value.trim();
    if (!title) {
        showToast("Please enter a subtask title", "error");
        return;
    }

    const taskType = typeSelect.value;

    try {
        const res = await fetch(`${API_BASE}/api/projects/${projectId}/stories/${storyId}/tasks`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${state.token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                title: title,
                task_type: taskType,
                status: "To Do"
            })
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || "Failed to create subtask");
        }

        showToast("Subtask created", "success");
        titleInput.value = "";

        await loadStories();
        const refreshedStory = (state.stories || []).find(s => s.id === storyId);
        if (refreshedStory) {
            renderStoryDetail(projectId, refreshedStory);
        }
    } catch (e) {
        showToast(e.message, "error");
    }
};

window.renderBoard = function () {
    applyStoriesFilters();
};

function renderBoardList(storiesList) {
    window.renderBoardList = renderBoardList;
    const projectId = document.getElementById("story-project-select")?.value;
    const todoContainer = document.getElementById("cards-todo");
    const inprogressContainer = document.getElementById("cards-inprogress");
    const devdoneContainer = document.getElementById("cards-devdone");
    const readyforqaContainer = document.getElementById("cards-readyforqa");
    const qadoneContainer = document.getElementById("cards-qadone");
    const completeContainer = document.getElementById("cards-complete");

    if (!todoContainer || !inprogressContainer || !devdoneContainer || !readyforqaContainer || !qadoneContainer || !completeContainer) return;

    todoContainer.innerHTML = "";
    inprogressContainer.innerHTML = "";
    devdoneContainer.innerHTML = "";
    readyforqaContainer.innerHTML = "";
    qadoneContainer.innerHTML = "";
    completeContainer.innerHTML = "";

    if (!projectId || !storiesList || storiesList.length === 0) {
        document.getElementById("badge-todo-count").textContent = "0";
        document.getElementById("badge-inprogress-count").textContent = "0";
        document.getElementById("badge-devdone-count").textContent = "0";
        document.getElementById("badge-readyforqa-count").textContent = "0";
        document.getElementById("badge-qadone-count").textContent = "0";
        document.getElementById("badge-complete-count").textContent = "0";
        return;
    }

    let todoCount = 0;
    let inprogressCount = 0;
    let devdoneCount = 0;
    let readyforqaCount = 0;
    let qadoneCount = 0;
    let completeCount = 0;

    const priorityWeights = { 'Critical': 1, 'High': 2, 'Medium': 3, 'Low': 4 };
    const sortedStories = [...storiesList].sort((a, b) => {
        const wA = priorityWeights[a.priority] || 5;
        const wB = priorityWeights[b.priority] || 5;
        if (wA !== wB) return wA - wB;
        return (b.id || 0) - (a.id || 0);
    });

    sortedStories.forEach(story => {
        const card = document.createElement("div");
        card.className = "board-card";
        card.draggable = true;
        card.dataset.storyId = story.id;
        card.dataset.projectId = projectId;

        card.style.cssText = "background: var(--bg-body); border: 1px solid var(--border-color); padding: 12px; border-radius: 8px; cursor: grab; display: flex; flex-direction: column; gap: 8px; transition: transform 0.15s, box-shadow 0.15s;";
        card.onmouseover = () => { card.style.transform = 'translateY(-2px)'; card.style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)'; };
        card.onmouseout = () => { card.style.transform = 'none'; card.style.boxShadow = 'none'; };

        card.addEventListener("dragstart", (e) => {
            e.dataTransfer.setData("text/plain", story.id);
            card.style.opacity = "0.5";
        });
        card.addEventListener("dragend", () => {
            card.style.opacity = "1";
        });

        // Count subtasks completed vs total
        const totalTasks = story.tasks ? story.tasks.length : 0;
        const completedTasks = story.tasks ? story.tasks.filter(t => t.status === "Complete" || t.status === "Done").length : 0;
        const progressPercent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

        // Priority color style
        let priorityColor = "#2563eb";
        let priorityBg = "rgba(59, 130, 246, 0.1)";
        if (story.priority === "Critical" || story.priority === "High") {
            priorityColor = "#ef4444";
            priorityBg = "rgba(239, 68, 68, 0.1)";
        } else if (story.priority === "Low") {
            priorityColor = "#6b7280";
            priorityBg = "rgba(107, 114, 128, 0.1)";
        }

        const bStoryKey = formatStoryKey(story, projectId);
        card.innerHTML = `
            <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px;">
                <span style="font-weight: 700; font-family: monospace; color: #2563EB; font-size: 0.78rem; text-decoration: underline;">${bStoryKey}</span>
            </div>
            <div style="font-weight: 600; font-size: 0.9rem; color: var(--color-text-main); line-height: 1.4;">${story.title}</div>
            
            <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 4px;">
                <div style="display: flex; gap: 6px; align-items: center;">
                    <span style="font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; font-weight: 600; background: ${priorityBg}; color: ${priorityColor};">${story.priority || 'Medium'}</span>
                    <span style="font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; font-weight: 600; background: rgba(139, 92, 246, 0.15); color: #8b5cf6; display: flex; align-items: center; gap: 3px;"><i data-lucide="layers" style="width: 10px; height: 10px;"></i> ${completedTasks}/${totalTasks} Tasks</span>
                </div>
                <span style="font-size: 0.75rem; padding: 2px 6px; border-radius: 12px; background: rgba(107, 114, 128, 0.15); color: var(--color-text-muted); font-weight: 700;">${story.story_points || 1} SP</span>
            </div>
            
            ${totalTasks > 0 ? `
            <div style="width: 100%; height: 4px; background: var(--border-color); border-radius: 2px; margin-top: 4px; overflow: hidden;">
                <div style="width: ${progressPercent}%; height: 100%; background: #10b981; border-radius: 2px;"></div>
            </div>
            ` : ''}
        `;

        if (story.status === "In Progress") {
            inprogressContainer.appendChild(card);
            inprogressCount++;
        } else if (story.status === "Dev Done") {
            devdoneContainer.appendChild(card);
            devdoneCount++;
        } else if (story.status === "Ready for QA") {
            readyforqaContainer.appendChild(card);
            readyforqaCount++;
        } else if (story.status === "QA Done") {
            qadoneContainer.appendChild(card);
            qadoneCount++;
        } else if (story.status === "Complete" || story.status === "Done") {
            completeContainer.appendChild(card);
            completeCount++;
        } else {
            todoContainer.appendChild(card);
            todoCount++;
        }
    });

    document.getElementById("badge-todo-count").textContent = todoCount;
    document.getElementById("badge-inprogress-count").textContent = inprogressCount;
    document.getElementById("badge-devdone-count").textContent = devdoneCount;
    document.getElementById("badge-readyforqa-count").textContent = readyforqaCount;
    document.getElementById("badge-qadone-count").textContent = qadoneCount;
    document.getElementById("badge-complete-count").textContent = completeCount;

    if (window.lucide) lucide.createIcons();
};

window.toggleJiraListHierarchy = function (storyId, projectId) {
    state.jiraListCollapsed = state.jiraListCollapsed || new Set();
    const strId = String(storyId);
    if (state.jiraListCollapsed.has(strId)) {
        state.jiraListCollapsed.delete(strId);
    } else {
        state.jiraListCollapsed.add(strId);
    }
    const resolvedProjectId = projectId || state.globalProjectId || document.getElementById("story-project-select")?.value || "";
    renderStoriesListView(state.storiesList || state.stories || [], resolvedProjectId);
};

function renderStoriesListView(storiesList, projectId) {
    const tableBody = document.getElementById("stories-list-table-body");
    if (!tableBody) return;

    storiesList = storiesList || state.storiesList || state.stories || [];
    state.storiesList = storiesList;

    if (!projectId) {
        projectId = state.globalProjectId || document.getElementById("story-project-select")?.value || "";
    }

    if (!storiesList || storiesList.length === 0) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="8" style="padding: 30px; text-align: center; color: var(--color-text-muted); font-style: italic;">
                    No work items to display in List View.
                </td>
            </tr>
        `;
        const footerCount = document.getElementById("jira-list-footer-count");
        if (footerCount) footerCount.textContent = "0 of 0";
        return;
    }

    if (!state.jiraListCollapsed || String(state.jiraListInitializedProject) !== String(projectId)) {
        state.jiraListCollapsed = new Set(storiesList.map(s => String(s.id)));
        state.jiraListInitializedProject = projectId;
    }
    const projKey = "PH0" + (projectId || "1");
    let seqNumber = 1;
    let html = "";
    let totalRowsDisplayed = 0;

    const isGlobalAdmin = state.user?.is_admin;
    const selectedProj = state.projects?.find(p => p.id === parseInt(projectId));
    const isProjManager = selectedProj && (selectedProj.user_role === 'Manager' || selectedProj.user_role === 'Admin');
    const isAdmin = isGlobalAdmin || isProjManager;
    const members = state.projectMembers || [];
    const currentUserName = state.user?.full_name || "Unassigned";

    storiesList.forEach(story => {
        const storyKey = formatStoryKey(story, projectId);
        const createdDate = story.created_at ? new Date(story.created_at).toLocaleString('en-US', { month: 'short', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : "Jul 09, 2026, 3:26 PM";
        const isCollapsed = state.jiraListCollapsed.has(String(story.id));
        const tasks = story.tasks || [];
        const hasChildren = tasks.length > 0;

        // Status pill styling
        const statusVal = story.status || "To Do";
        let statusBg = "#E2E8F0"; let statusText = "#475569";
        if (statusVal === "In Progress") { statusBg = "#DBEAFE"; statusText = "#1E40AF"; }
        else if (statusVal === "Dev Done") { statusBg = "#CCFBF1"; statusText = "#0F766E"; }
        else if (statusVal === "Ready for QA") { statusBg = "#E0E7FF"; statusText = "#3730A3"; }
        else if (statusVal === "QA Done") { statusBg = "#F3E8FF"; statusText = "#6B21A8"; }
        else if (statusVal === "Complete" || statusVal === "Done") { statusBg = "#DCFCE7"; statusText = "#15803D"; }
        else if (statusVal === "On Hold") { statusBg = "#FEF3C7"; statusText = "#9A3412"; }

        // Priority icon & color
        let priorityIconHtml = `<span style="color: #F59E0B; font-weight: 800; margin-right: 4px;">=</span>`;
        if (story.priority === "High" || story.priority === "Critical") {
            priorityIconHtml = `<span style="color: #EF4444; font-weight: 800; margin-right: 4px;">▲</span>`;
        } else if (story.priority === "Low") {
            priorityIconHtml = `<span style="color: #6B7280; font-weight: 800; margin-right: 4px;">▼</span>`;
        }

        const resolutionVal = (statusVal === "Complete" || statusVal === "Done") ? "Done" : "Unresolved";

        // Reporter: auto-match to team member whose role matches the story's primary task_type
        const storyTasks = story.tasks || [];
        const taskTypeCounts = {};
        storyTasks.forEach(t => { taskTypeCounts[t.task_type] = (taskTypeCounts[t.task_type] || 0) + 1; });
        const primaryTaskType = Object.keys(taskTypeCounts).sort((a, b) => taskTypeCounts[b] - taskTypeCounts[a])[0] || null;
        const matchedReporter = primaryTaskType ? members.find(m => m.role === primaryTaskType) : null;
        const autoReporter = matchedReporter ? matchedReporter.user_name : "Unassigned";
        const reporterName = story.reporter || autoReporter;
        const reporterInitial = reporterName && reporterName !== "Unassigned" ? reporterName.charAt(0).toUpperCase() : "";
        const reporterOptionsHtml = members.length > 0
            ? `<option value="Unassigned" ${reporterName === 'Unassigned' ? 'selected' : ''}>Unassigned</option>` + members.map(m => `<option value="${m.user_name}" ${reporterName === m.user_name ? 'selected' : ''}>${m.user_name}</option>`).join("")
            : `<option value="Unassigned" selected>Unassigned</option>`;

        // Assignee: default to the Project Manager (admin who created the project)
        const projectManager = members.find(m => m.role === "Manager");
        const defaultAssignee = projectManager ? projectManager.user_name : "Unassigned";
        const assigneeName = story.assignee !== undefined ? story.assignee : defaultAssignee;
        if (story.assignee === undefined) story.assignee = defaultAssignee;
        const assigneeInitial = assigneeName && assigneeName !== "Unassigned" ? assigneeName.charAt(0).toUpperCase() : "";
        const isAssigneeInMembers = members.some(m => m.user_name === assigneeName);
        let assigneeOptionsHtml = members.map(m => `<option value="${m.user_name}" ${assigneeName === m.user_name ? 'selected' : ''}>${m.user_name}</option>`).join("");
        if (assigneeName && assigneeName !== "Unassigned" && !isAssigneeInMembers) {
            assigneeOptionsHtml = `<option value="${assigneeName}" selected>${assigneeName}</option>` + assigneeOptionsHtml;
        }

        html += `
            <tr data-story-id="${story.id}" style="border-bottom: 1px solid var(--border-color); background: var(--bg-card); transition: background 0.15s;" onmouseover="this.style.background='#F8FAFC'" onmouseout="this.style.background='var(--bg-card)'">
                <!-- Checkbox -->
                <td style="padding: 10px 12px; text-align: center;">
                    <input type="checkbox" class="jira-row-checkbox" data-type="story" data-id="${story.id}" onchange="jiraListUpdateSelection()" style="cursor: pointer; width: 14px; height: 14px; accent-color: var(--color-primary);">
                </td>

                <!-- Work (Expand Hierarchy + Key + Title) -->
                <td style="padding: 10px 14px; min-width: 280px;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        ${hasChildren ? `
                        <button type="button" onclick="toggleJiraListHierarchy('${story.id}', '${projectId}')" title="${isCollapsed ? 'Expand hierarchy' : 'Collapse hierarchy'}" style="width: 20px; height: 20px; border-radius: 4px; border: none; background: transparent; color: var(--color-text-muted); display: inline-flex; align-items: center; justify-content: center; cursor: pointer;">
                            <i data-lucide="${isCollapsed ? 'chevron-right' : 'chevron-down'}" style="width: 14px; height: 14px;"></i>
                        </button>
                        ` : `<div style="width: 20px; height: 20px; display: inline-flex;"></div>`}
                        <span style="display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; background: #EDE9FE; color: #7C3AED; border-radius: 3px;" title="Epic / Story">
                            <i data-lucide="zap" style="width: 12px; height: 12px; fill: currentColor;"></i>
                        </span>
                        <span onclick="openStoryDetailModal(${projectId}, ${story.id})" style="color: #2563EB; font-weight: 700; font-family: monospace; text-decoration: underline; cursor: pointer; font-size: 0.82rem;">
                            ${storyKey}
                        </span>
                        <span onclick="openStoryDetailModal(${projectId}, ${story.id})" style="font-weight: 600; color: var(--color-text-main); cursor: pointer; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; max-width: 220px;">
                            ${story.title}
                        </span>
                        <button type="button" onclick="openStoryDetailModal(${projectId}, ${story.id})" title="Open detail view" style="border: none; background: transparent; color: var(--color-text-muted); cursor: pointer; padding: 2px;">
                            <i data-lucide="external-link" style="width: 13px; height: 13px;"></i>
                        </button>
                    </div>
                </td>

                <!-- Assignee -->
                <td style="padding: 10px 14px;">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <span style="width: 20px; height: 20px; border-radius: 50%; background: ${assigneeName ? '#10B981' : '#E2E8F0'}; color: ${assigneeName ? '#fff' : '#475569'}; display: inline-flex; align-items: center; justify-content: center; font-size: 0.65rem; font-weight: 700;">
                            ${assigneeName ? assigneeInitial : '<i data-lucide="user" style="width: 12px; height: 12px;"></i>'}
                        </span>
                        <select ${isAdmin ? '' : 'disabled'} onchange="const s = state.storiesList.find(x => x.id === ${story.id}); if (s) s.assignee = this.value; showToast('Assignee updated to ' + (this.value || 'Unassigned'), 'success'); renderStoriesListView(state.storiesList, ${projectId})" style="background: transparent; border: none; font-size: 0.85rem; color: var(--color-text-main); font-weight: 500; cursor: pointer; outline: none;">
                            <option value="" ${!assigneeName ? 'selected' : ''}>Unassigned</option>
                            ${assigneeOptionsHtml}
                        </select>
                    </div>
                </td>

                <!-- Reporter -->
                <td style="padding: 10px 14px;">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <span style="width: 20px; height: 20px; border-radius: 50%; background: #2563EB; color: #fff; display: inline-flex; align-items: center; justify-content: center; font-size: 0.68rem; font-weight: 700;">
                            ${reporterInitial}
                        </span>
                        <select ${isAdmin ? '' : 'disabled'} onchange="const s = state.storiesList.find(x => x.id === ${story.id}); if (s) s.reporter = this.value; showToast('Reporter updated to ' + this.value, 'success'); renderStoriesListView(state.storiesList, ${projectId})" style="background: transparent; border: none; font-size: 0.85rem; color: var(--color-text-main); font-weight: 500; cursor: pointer; outline: none;">
                            ${reporterOptionsHtml}
                        </select>
                    </div>
                </td>

                <!-- Due date -->
                <td style="padding: 10px 14px;">
                    <input type="date"
                        value="${story.due_date ? story.due_date.split('T')[0] : ''}"
                        ${isAdmin ? '' : 'disabled'}
                        onchange="updateStoryField(${projectId}, ${story.id}, 'due_date', this.value || null)"
                        style="border: 1px solid var(--border-color); border-radius: 6px; padding: 4px 8px; font-size: 0.82rem; color: var(--color-text-main); background: var(--bg-card); cursor: pointer; outline: none; width: 130px; ${story.due_date && new Date(story.due_date) < new Date() && statusVal !== 'Complete' ? 'border-color: #EF4444; color: #EF4444;' : ''}"
                        onfocus="this.style.borderColor='var(--color-primary)'"
                        onblur="this.style.borderColor='${story.due_date && new Date(story.due_date) < new Date() && statusVal !== 'Complete' ? '#EF4444' : 'var(--border-color)'}'"
                    >
                </td>

                <!-- Priority Dropdown -->
                <td style="padding: 10px 14px;">
                    <div style="display: flex; align-items: center;">
                        ${priorityIconHtml}
                        <select ${isAdmin ? '' : 'disabled'} onchange="updateStoryField(${projectId}, ${story.id}, 'priority', this.value)" style="background: transparent; border: none; font-size: 0.84rem; color: var(--color-text-main); font-weight: 600; cursor: pointer; outline: none;">
                            <option value="Low" ${story.priority === 'Low' ? 'selected' : ''}>Low</option>
                            <option value="Medium" ${story.priority === 'Medium' || !story.priority ? 'selected' : ''}>Medium</option>
                            <option value="High" ${story.priority === 'High' ? 'selected' : ''}>High</option>
                            <option value="Critical" ${story.priority === 'Critical' ? 'selected' : ''}>Critical</option>
                        </select>
                    </div>
                </td>

                <!-- Status Dropdown Pill -->
                <td style="padding: 10px 14px;">
                    <select onchange="updateStoryField(${projectId}, ${story.id}, 'status', this.value)" style="background: ${statusBg}; color: ${statusText}; border: none; padding: 4px 8px; border-radius: 4px; font-size: 0.72rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.4px; cursor: pointer; outline: none;">
                        <option value="To Do" ${statusVal === 'To Do' ? 'selected' : ''}>TO DO</option>
                        <option value="In Progress" ${statusVal === 'In Progress' ? 'selected' : ''}>IN PROGRESS</option>
                        <option value="Dev Done" ${statusVal === 'Dev Done' ? 'selected' : ''}>DEV DONE</option>
                        <option value="Ready for QA" ${statusVal === 'Ready for QA' ? 'selected' : ''}>READY FOR QA</option>
                        <option value="QA Done" ${statusVal === 'QA Done' ? 'selected' : ''}>QA DONE</option>
                        <option value="Complete" ${statusVal === 'Complete' || statusVal === 'Done' ? 'selected' : ''}>COMPLETE</option>
                        <option value="On Hold" ${statusVal === 'On Hold' ? 'selected' : ''}>ON HOLD</option>
                    </select>
                </td>
                <!-- Created -->
                <td style="padding: 10px 14px; color: var(--color-text-muted); font-size: 0.82rem; white-space: nowrap;">
                    ${createdDate}
                </td>
            </tr>
        `;
        totalRowsDisplayed++;

        // Child subtasks (if parent not collapsed)
        if (!isCollapsed && tasks.length > 0) {
            tasks.forEach(t => {
                if (state.storyAssigneeFilter === "mine" && t.assigned_to !== state.user?.id) {
                    return;
                }
                const taskKey = `${projKey}-${seqNumber++}`;
                // Subtask Assignee: default to story creator / logged-in user
                const defaultAssigneeUser = members.find(m => m.user_name === currentUserName);
                const explicitAssignee = t.assigned_to ? members.find(m => m.user_id === t.assigned_to) : null;
                const isAutoRoleAssignee = explicitAssignee && explicitAssignee.role === t.task_type && explicitAssignee.user_name !== currentUserName;
                const effectiveAssigneeMember = (explicitAssignee && !isAutoRoleAssignee) ? explicitAssignee : defaultAssigneeUser;
                const effectiveAssigneeId = effectiveAssigneeMember ? effectiveAssigneeMember.user_id : (state.user?.id || "");
                const assigneeName = effectiveAssigneeMember ? effectiveAssigneeMember.user_name : currentUserName;
                const initial = assigneeName ? assigneeName.charAt(0).toUpperCase() : "";

                const taskStatusVal = t.status || "To Do";
                let tStatusBg = "#E2E8F0"; let tStatusText = "#475569";
                if (taskStatusVal === "In Progress") { tStatusBg = "#DBEAFE"; tStatusText = "#1E40AF"; }
                else if (taskStatusVal === "Dev Done") { tStatusBg = "#CCFBF1"; tStatusText = "#0F766E"; }
                else if (taskStatusVal === "Ready for QA") { tStatusBg = "#E0E7FF"; tStatusText = "#3730A3"; }
                else if (taskStatusVal === "QA Done") { tStatusBg = "#F3E8FF"; tStatusText = "#6B21A8"; }
                else if (taskStatusVal === "Complete" || taskStatusVal === "Done") { tStatusBg = "#DCFCE7"; tStatusText = "#15803D"; }

                const tResolutionVal = (taskStatusVal === "Complete" || taskStatusVal === "Done") ? "Done" : "Unresolved";

                const membersOptions = members.map(m => `
                    <option value="${m.user_id}" ${effectiveAssigneeId === m.user_id ? 'selected' : ''}>${m.user_name}</option>
                `).join("");

                // Subtask Reporter: auto-match task_type to team member role
                const tMatchedReporter = t.task_type ? members.find(m => m.role === t.task_type) : null;
                const tAutoReporter = tMatchedReporter ? tMatchedReporter.user_name : "Unassigned";
                const tReporterName = t.reporter || tAutoReporter;
                const tReporterInitial = tReporterName && tReporterName !== "Unassigned" ? tReporterName.charAt(0).toUpperCase() : "";
                const tReporterOptionsHtml = members.length > 0
                    ? `<option value="Unassigned" ${tReporterName === 'Unassigned' ? 'selected' : ''}>Unassigned</option>` + members.map(m => `<option value="${m.user_name}" ${tReporterName === m.user_name ? 'selected' : ''}>${m.user_name}</option>`).join("")
                    : `<option value="Unassigned" selected>Unassigned</option>`;

                html += `
                    <tr data-task-id="${t.id}" data-parent-story-id="${story.id}" style="border-bottom: 1px solid var(--border-color); background: #FAFAFB; transition: background 0.15s;" onmouseover="this.style.background='#F1F5F9'" onmouseout="this.style.background='#FAFAFB'">
                        <!-- Checkbox -->
                        <td style="padding: 8px 12px; text-align: center;">
                            <input type="checkbox" class="jira-row-checkbox" data-type="task" data-id="${t.id}" data-story-id="${story.id}" onchange="jiraListUpdateSelection()" style="cursor: pointer; width: 14px; height: 14px; accent-color: var(--color-primary);">
                        </td>

                        <!-- Work (Indented Child Key + Title) -->
                        <td style="padding: 8px 14px; padding-left: 36px; min-width: 280px;">
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <span style="display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; background: #E0F2FE; color: #0284C7; border-radius: 3px;" title="Subtask">
                                    <i data-lucide="check-square" style="width: 11px; height: 11px;"></i>
                                </span>
                                <span onclick="openStoryDetailModal(${projectId}, ${story.id})" style="color: #2563EB; font-weight: 700; font-family: monospace; text-decoration: underline; cursor: pointer; font-size: 0.8rem;">
                                    ${taskKey}
                                </span>
                                <span onclick="openStoryDetailModal(${projectId}, ${story.id})" style="font-weight: 500; color: var(--color-text-main); cursor: pointer; font-size: 0.88rem;">
                                    ${t.title}
                                </span>
                            </div>
                        </td>

                        <!-- Assignee Dropdown -->
                        <td style="padding: 8px 14px;">
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <span style="width: 20px; height: 20px; border-radius: 50%; background: ${effectiveAssigneeMember ? '#10B981' : '#E2E8F0'}; color: ${effectiveAssigneeMember ? '#fff' : '#475569'}; display: inline-flex; align-items: center; justify-content: center; font-size: 0.65rem; font-weight: 700;">
                                    ${effectiveAssigneeMember ? initial : '<i data-lucide="user" style="width: 11px; height: 11px;"></i>'}
                                </span>
                                <select ${isAdmin ? '' : 'disabled'} onchange="updateTaskField(${projectId}, ${story.id}, ${t.id}, 'assigned_to', this.value ? parseInt(this.value) : null)" style="background: transparent; border: none; font-size: 0.84rem; color: var(--color-text-main); cursor: pointer; outline: none;">
                                    <option value="">Unassigned</option>
                                    ${membersOptions}
                                </select>
                            </div>
                        </td>

                        <!-- Reporter -->
                        <td style="padding: 8px 14px;">
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <span style="width: 20px; height: 20px; border-radius: 50%; background: #2563EB; color: #fff; display: inline-flex; align-items: center; justify-content: center; font-size: 0.68rem; font-weight: 700;">
                                    ${tReporterInitial}
                                </span>
                                <select ${isAdmin ? '' : 'disabled'} onchange="t.reporter = this.value; showToast('Reporter updated to ' + this.value, 'success'); renderStoriesListView(state.storiesList, ${projectId})" style="background: transparent; border: none; font-size: 0.85rem; color: var(--color-text-main); font-weight: 500; cursor: pointer; outline: none;">
                                    ${tReporterOptionsHtml}
                                </select>
                            </div>
                        </td>

                        <!-- Due date -->
                        <td style="padding: 8px 14px;">
                            <input type="date"
                                value="${t.due_date ? t.due_date.split('T')[0] : ''}"
                                ${isAdmin ? '' : 'disabled'}
                                onchange="updateTaskField(${projectId}, ${story.id}, ${t.id}, 'due_date', this.value || null)"
                                style="border: 1px solid var(--border-color); border-radius: 6px; padding: 4px 8px; font-size: 0.82rem; color: var(--color-text-main); background: var(--bg-card); cursor: pointer; outline: none; width: 130px; ${t.due_date && new Date(t.due_date) < new Date() && taskStatusVal !== 'Complete' ? 'border-color: #EF4444; color: #EF4444;' : ''}"
                                onfocus="this.style.borderColor='var(--color-primary)'"
                                onblur="this.style.borderColor='${t.due_date && new Date(t.due_date) < new Date() && taskStatusVal !== 'Complete' ? '#EF4444' : 'var(--border-color)'}'"
                            >
                        </td>

                        <!-- Priority -->
                        <td style="padding: 8px 14px;">
                            <span style="color: #F59E0B; font-weight: 800; margin-right: 4px;">=</span>
                            <span style="font-size: 0.84rem; color: var(--color-text-main);">Medium</span>
                        </td>

                        <!-- Status Dropdown Pill -->
                        <td style="padding: 8px 14px;">
                            <select onchange="updateTaskField(${projectId}, ${story.id}, ${t.id}, 'status', this.value)" style="background: ${tStatusBg}; color: ${tStatusText}; border: none; padding: 4px 8px; border-radius: 4px; font-size: 0.72rem; font-weight: 800; text-transform: uppercase; letter-spacing: 0.4px; cursor: pointer; outline: none;">
                                <option value="To Do" ${taskStatusVal === 'To Do' ? 'selected' : ''}>TO DO</option>
                                <option value="In Progress" ${taskStatusVal === 'In Progress' ? 'selected' : ''}>IN PROGRESS</option>
                                <option value="Dev Done" ${taskStatusVal === 'Dev Done' ? 'selected' : ''}>DEV DONE</option>
                                <option value="Ready for QA" ${taskStatusVal === 'Ready for QA' ? 'selected' : ''}>READY FOR QA</option>
                                <option value="QA Done" ${taskStatusVal === 'QA Done' ? 'selected' : ''}>QA DONE</option>
                                <option value="Complete" ${taskStatusVal === 'Complete' || taskStatusVal === 'Done' ? 'selected' : ''}>COMPLETE</option>
                            </select>
                        </td>
                        <!-- Created -->
                        <td style="padding: 8px 14px; color: var(--color-text-muted); font-size: 0.82rem; white-space: nowrap;">
                            ${createdDate}
                        </td>
                    </tr>
                `;
                totalRowsDisplayed++;
            });
        }
    });

    tableBody.innerHTML = html;
    const footerCount = document.getElementById("jira-list-footer-count");
    if (footerCount) footerCount.textContent = `${totalRowsDisplayed} of ${totalRowsDisplayed}`;
    if (window.lucide) lucide.createIcons();
}

function openStoryDetailModal(projectId, storyId) {
    const story = (state.storiesList || state.stories || []).find(s => String(s.id) === String(storyId));
    if (!story) {
        showToast("Story details not found", "error");
        return;
    }
    // Switch to Backlog view where full details can be edited and viewed
    const btnBacklog = document.getElementById("btn-toggle-backlog");
    if (btnBacklog) btnBacklog.click();

    renderStoryDetail(projectId, story);

    setTimeout(() => {
        const panel = document.getElementById("story-detail-panel");
        if (panel) {
            panel.scrollIntoView({ behavior: "smooth", block: "start" });
        }
    }, 50);
}
window.openStoryDetailModal = openStoryDetailModal;

// ===== Jira List View Selection Logic =====
window.jiraListUpdateSelection = function () {
    const checkboxes = document.querySelectorAll('.jira-row-checkbox');
    const checked = document.querySelectorAll('.jira-row-checkbox:checked');
    const bar = document.getElementById('jira-selection-bar');
    const countEl = document.getElementById('jira-selection-count');
    const selectAllCb = document.getElementById('jira-list-select-all');

    if (checked.length > 0) {
        bar.style.display = 'flex';
        countEl.textContent = checked.length;
    } else {
        bar.style.display = 'none';
    }

    // Update header checkbox state
    if (selectAllCb) {
        selectAllCb.checked = checkboxes.length > 0 && checked.length === checkboxes.length;
        selectAllCb.indeterminate = checked.length > 0 && checked.length < checkboxes.length;
    }

    // Highlight selected rows
    checkboxes.forEach(cb => {
        const row = cb.closest('tr');
        if (row) {
            if (cb.checked) {
                row.style.background = '#EFF6FF';
                row.onmouseover = () => row.style.background = '#DBEAFE';
                row.onmouseout = () => row.style.background = '#EFF6FF';
            } else {
                const isChild = cb.dataset.type === 'task';
                const defaultBg = isChild ? '#FAFAFB' : 'var(--bg-card)';
                row.style.background = defaultBg;
                row.onmouseover = () => row.style.background = isChild ? '#F1F5F9' : '#F8FAFC';
                row.onmouseout = () => row.style.background = defaultBg;
            }
        }
    });

    if (window.lucide) lucide.createIcons();
};

window.jiraListToggleSelectAll = function (isChecked) {
    const checkboxes = document.querySelectorAll('.jira-row-checkbox');
    checkboxes.forEach(cb => { cb.checked = isChecked; });
    jiraListUpdateSelection();
};

window.jiraListSelectAll = function () {
    const checkboxes = document.querySelectorAll('.jira-row-checkbox');
    checkboxes.forEach(cb => { cb.checked = true; });
    const selectAllCb = document.getElementById('jira-list-select-all');
    if (selectAllCb) selectAllCb.checked = true;
    jiraListUpdateSelection();
};

window.jiraListClearSelection = function () {
    const checkboxes = document.querySelectorAll('.jira-row-checkbox');
    checkboxes.forEach(cb => { cb.checked = false; });
    const selectAllCb = document.getElementById('jira-list-select-all');
    if (selectAllCb) { selectAllCb.checked = false; selectAllCb.indeterminate = false; }
    jiraListUpdateSelection();
};

window.jiraListBulkChangeStatus = function () {
    const checked = document.querySelectorAll('.jira-row-checkbox:checked');
    if (checked.length === 0) return;

    // Create a floating status picker
    const existing = document.getElementById('jira-bulk-status-picker');
    if (existing) existing.remove();

    const statuses = ['To Do', 'In Progress', 'Dev Done', 'Ready for QA', 'QA Done', 'Complete', 'On Hold'];
    const statusColors = {
        'To Do': { bg: '#E2E8F0', text: '#475569' },
        'In Progress': { bg: '#DBEAFE', text: '#1E40AF' },
        'Dev Done': { bg: '#CCFBF1', text: '#0F766E' },
        'Ready for QA': { bg: '#E0E7FF', text: '#3730A3' },
        'QA Done': { bg: '#F3E8FF', text: '#6B21A8' },
        'Complete': { bg: '#DCFCE7', text: '#15803D' },
        'On Hold': { bg: '#FEF3C7', text: '#9A3412' }
    };

    const picker = document.createElement('div');
    picker.id = 'jira-bulk-status-picker';
    picker.style.cssText = 'position: fixed; bottom: 56px; left: 50%; transform: translateX(-50%); background: #fff; border: 1px solid var(--border-color); border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,0.18); padding: 8px; z-index: 1000; display: flex; flex-direction: column; gap: 2px; min-width: 180px; animation: jiraBarSlideUp 0.15s ease-out;';

    statuses.forEach(s => {
        const colors = statusColors[s];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = s.toUpperCase();
        btn.style.cssText = `background: ${colors.bg}; color: ${colors.text}; border: none; padding: 8px 14px; border-radius: 6px; font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; cursor: pointer; text-align: left; transition: filter 0.15s;`;
        btn.onmouseover = () => btn.style.filter = 'brightness(0.95)';
        btn.onmouseout = () => btn.style.filter = 'none';
        btn.onclick = async () => {
            picker.remove();
            const projectId = document.getElementById('story-project-select')?.value;
            if (!projectId) return;

            let updatedCount = 0;
            for (const cb of checked) {
                try {
                    if (cb.dataset.type === 'story') {
                        await updateStoryField(projectId, parseInt(cb.dataset.id), 'status', s);
                        updatedCount++;
                    } else if (cb.dataset.type === 'task') {
                        await updateTaskField(projectId, parseInt(cb.dataset.storyId), parseInt(cb.dataset.id), 'status', s);
                        updatedCount++;
                    }
                } catch (err) { console.error('Bulk status error:', err); }
            }
            showToast(`Updated ${updatedCount} items to "${s}"`, 'success');
            jiraListClearSelection();
        };
        picker.appendChild(btn);
    });

    document.body.appendChild(picker);

    // Close on outside click
    const closeHandler = (e) => {
        if (!picker.contains(e.target)) {
            picker.remove();
            document.removeEventListener('click', closeHandler);
        }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 100);
};

window.jiraListBulkDelete = async function () {
    const checked = document.querySelectorAll('.jira-row-checkbox:checked');
    if (checked.length === 0) return;

    const storyChecked = Array.from(checked).filter(cb => cb.dataset.type === 'story');
    const taskChecked = Array.from(checked).filter(cb => cb.dataset.type === 'task');

    // Count cascaded and independent tasks
    const selectedStoryIds = new Set(storyChecked.map(cb => String(cb.dataset.id)));
    const storiesList = state.storiesList || state.stories || [];
    let cascadedTasksCount = 0;
    storiesList.forEach(s => {
        if (selectedStoryIds.has(String(s.id))) {
            cascadedTasksCount += (s.tasks || []).length;
        }
    });

    const independentTasks = taskChecked.filter(cb => !selectedStoryIds.has(String(cb.dataset.storyId)));
    const totalSubtasksToDelete = cascadedTasksCount + independentTasks.length;

    if (!confirm(`Are you sure you want to delete ${storyChecked.length} stories and ${totalSubtasksToDelete} subtasks? This cannot be undone.`)) return;

    const projectId = document.getElementById('story-project-select')?.value;
    if (!projectId) return;

    let deletedStoriesCount = 0;
    let deletedTasksCount = 0;

    // Delete stories (this deletes their child tasks too)
    for (const cb of storyChecked) {
        try {
            await deleteStory(projectId, parseInt(cb.dataset.id), true, true);
            deletedStoriesCount++;
        } catch (err) { console.error('Bulk delete story error:', err); }
    }

    // Delete individual tasks (only if their parent story wasn't already deleted)
    for (const cb of independentTasks) {
        try {
            const res = await fetch(`${API_BASE}/api/projects/${projectId}/stories/${cb.dataset.storyId}/tasks/${cb.dataset.id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${state.token}` }
            });
            if (res.ok) deletedTasksCount++;
        } catch (err) { console.error('Bulk delete task error:', err); }
    }

    const toastMsg = `Deleted ${deletedStoriesCount} stories (including ${cascadedTasksCount} subtasks)` +
        (deletedTasksCount > 0 ? ` and ${deletedTasksCount} other subtasks` : '');
    showToast(toastMsg, 'success');
    jiraListClearSelection();

    // Refresh the stories list
    const btn = document.getElementById('btn-load-stories');
    if (btn) btn.click();
};

window.handleBoardDrop = async function (e, newStatus) {
    e.preventDefault();
    const storyId = e.dataTransfer.getData("text/plain");
    const projectId = document.getElementById("story-project-select")?.value;
    if (!storyId || !projectId) return;

    // 1. Optimistic UI update: Move card and update counts immediately
    const card = document.querySelector(`.board-card[data-story-id="${storyId}"]`);
    const containerId = "cards-" + newStatus.toLowerCase().replace(/\s+/g, '');
    const targetContainer = document.getElementById(containerId);
    let oldContainer = null;

    if (card && targetContainer) {
        oldContainer = card.parentElement;
        if (oldContainer && oldContainer !== targetContainer) {
            targetContainer.appendChild(card);

            // Helper to update column counts
            const updateCount = (container) => {
                const suffix = container.id.replace("cards-", "");
                const badge = document.getElementById(`badge-${suffix}-count`);
                if (badge) {
                    badge.textContent = container.querySelectorAll(".board-card").length;
                }
            };
            updateCount(oldContainer);
            updateCount(targetContainer);
        }
    }

    // 2. Perform API call in the background without blocking the UI
    try {
        const body = { status: newStatus };
        const res = await fetch(`${API_BASE}/api/projects/${projectId}/stories/${storyId}`, {
            method: "PUT",
            headers: {
                "Authorization": `Bearer ${state.token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error("Failed to update story status");

        showToast(`Story moved to ${newStatus}`, "success");
        // Sync full state in background
        loadStories();
    } catch (err) {
        showToast(err.message, "error");
        // Revert UI on failure
        if (card && oldContainer) {
            oldContainer.appendChild(card);
            const updateCount = (container) => {
                const suffix = container.id.replace("cards-", "");
                const badge = document.getElementById(`badge-${suffix}-count`);
                if (badge) {
                    badge.textContent = container.querySelectorAll(".board-card").length;
                }
            };
            updateCount(oldContainer);
            if (targetContainer) updateCount(targetContainer);
        }
        loadStories();
    }
};

// =====================================================================
// Team Management Handlers
// =====================================================================
async function loadTeamMembers(projectId) {
    const tbody = document.getElementById("team-members-list");
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Loading team...</td></tr>';

    try {
        const res = await fetch(`${API_BASE}/api/projects/${projectId}/team`, {
            headers: { "Authorization": `Bearer ${state.token}` }
        });
        const members = await res.json();

        tbody.innerHTML = "";
        if (members.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color: var(--color-text-muted);">No team members added yet. Add members above to enable auto-assignment.</td></tr>';
            return;
        }

        const isGlobalAdmin = state.user?.is_admin;
        const selectedProj = state.projects?.find(p => p.id === parseInt(projectId));
        const isProjManager = selectedProj && (selectedProj.user_role === 'Manager' || selectedProj.user_role === 'Admin');
        const isAdmin = isGlobalAdmin || isProjManager;

        members.forEach(m => {
            let roleColor = '#2563eb';
            if (m.role === 'Frontend') roleColor = '#f59e0b';
            else if (m.role === 'AI') roleColor = '#10b981';
            else if (m.role === 'Manager') roleColor = '#8b5cf6';

            const dateStr = new Date(m.created_at).toLocaleDateString();
            const tr = document.createElement("tr");

            const removeBtnHTML = `
                <button class="btn-icon-danger" onclick="removeTeamMember(${projectId}, ${m.id})">
                    <i data-lucide="user-minus"></i>
                </button>
            `;

            let roleHTML = "";
            if (isAdmin) {
                roleHTML = `
                    <select onchange="updateMemberRole(${projectId}, ${m.id}, '${m.user_email}', this.value)" style="background: ${roleColor}15; color: ${roleColor}; border: 1px solid ${roleColor}40; padding: 4px 10px; border-radius: 12px; font-size: 0.8rem; font-weight: 600; outline: none; cursor: pointer;">
                        <option value="Frontend" ${m.role === 'Frontend' ? 'selected' : ''}>Frontend</option>
                        <option value="Backend" ${m.role === 'Backend' ? 'selected' : ''}>Backend</option>
                        <option value="AI" ${m.role === 'AI' ? 'selected' : ''}>AI</option>
                        <option value="Manager" ${m.role === 'Manager' ? 'selected' : ''}>Manager</option>
                    </select>
                `;
            } else {
                roleHTML = `
                    <span style="background: ${roleColor}22; color: ${roleColor}; padding: 4px 10px; border-radius: 12px; font-size: 0.8rem; font-weight: 600;">
                        ${m.role}
                    </span>
                `;
            }

            tr.innerHTML = `
                <td><strong>${m.user_name}</strong></td>
                <td><span class="text-muted">${m.user_email}</span></td>
                <td>${roleHTML}</td>
                <td><span class="text-muted">${dateStr}</span></td>
                <td>
                    ${removeBtnHTML}
                </td>
            `;
            tbody.appendChild(tr);
        });

        lucide.createIcons();
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="5" style="color: var(--color-danger);">Error: ${e.message}</td></tr>`;
    }
}


document.getElementById("btn-add-team-member")?.addEventListener("click", async () => {
    if (!checkAdminAccess("add team members")) return;
    if (!state.currentProject) {
        showToast("Open a project first", "error");
        return;
    }

    const emailInput = document.getElementById("team-member-email");
    const roleSelect = document.getElementById("team-member-role");
    const email = emailInput.value.trim();
    const role = roleSelect.value;

    if (!email) {
        showToast("Please enter a member email", "error");
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/api/projects/${state.currentProject.id}/team`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${state.token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ user_email: email, role: role })
        });

        if (res.ok) {
            const data = await res.json();
            showToast(`Added ${data.user_name} as ${role} developer`, "success");
            emailInput.value = "";
            loadTeamMembers(state.currentProject.id);
        } else {
            const err = await res.json();
            showToast(err.detail || "Failed to add member", "error");
        }
    } catch (e) {
        showToast(`Network error: ${e.message}`, "error");
    }
});

document.getElementById("btn-auto-assign")?.addEventListener("click", async (e) => {
    if (!checkAdminAccess("auto-assign tasks")) return;
    if (!state.currentProject) {
        showToast("Open a project first", "error");
        return;
    }

    const btn = e.currentTarget;
    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader" class="spin" style="width:16px;height:16px;margin-right:6px;"></i> Assigning...';
    lucide.createIcons();

    try {
        const res = await fetch(`${API_BASE}/api/projects/${state.currentProject.id}/team/auto-assign`, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${state.token}`
            }
        });

        if (res.ok) {
            const data = await res.json();
            showToast(data.detail || "Tasks successfully assigned!", "success");
            await loadStories();
        } else {
            const err = await res.json();
            showToast(err.detail || "Failed to auto-assign tasks", "error");
        }
    } catch (e) {
        showToast(`Network error: ${e.message}`, "error");
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
        lucide.createIcons();
    }
});

window.removeTeamMember = async function (projectId, memberId) {
    if (!checkAdminAccess("remove team members")) return;
    if (!confirm("Remove this team member? Their tasks will be unassigned.")) return;

    try {
        const res = await fetch(`${API_BASE}/api/projects/${projectId}/team/${memberId}`, {
            method: "DELETE",
            headers: { "Authorization": `Bearer ${state.token}` }
        });
        if (res.ok) {
            showToast("Member removed", "success");
            loadTeamMembers(projectId);
        } else {
            const err = await res.json();
            showToast(err.detail || "Failed to remove member", "error");
        }
    } catch (e) {
        showToast(e.message, "error");
    }
};

window.updateMemberRole = async function (projectId, memberId, email, newRole) {
    if (!checkAdminAccess("update team member role")) return;

    try {
        const res = await fetch(`${API_BASE}/api/projects/${projectId}/team/${memberId}`, {
            method: "PUT",
            headers: {
                "Authorization": `Bearer ${state.token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                user_email: email,
                role: newRole
            })
        });
        if (res.ok) {
            showToast("Member role updated successfully", "success");
            loadTeamMembers(projectId);
            loadStories(); // Refresh stories list & details to show new task assignments
        } else {
            const err = await res.json();
            showToast(err.detail || "Failed to update member role", "error");
            loadTeamMembers(projectId);
        }
    } catch (e) {
        showToast(e.message, "error");
        loadTeamMembers(projectId);
    }
};

// =====================================================================
// My Tasks Board Handlers
// =====================================================================
document.getElementById("btn-refresh-mytasks")?.addEventListener("click", loadMyTasks);

async function loadMyTasks() {
    if (!state.token) return;

    const todoCol = document.getElementById("mytasks-todo");
    const inprogCol = document.getElementById("mytasks-inprogress");
    const devdoneCol = document.getElementById("mytasks-devdone");
    const readyforqaCol = document.getElementById("mytasks-readyforqa");
    const qadoneCol = document.getElementById("mytasks-qadone");
    const completeCol = document.getElementById("mytasks-complete");

    if (!todoCol || !inprogCol || !devdoneCol || !readyforqaCol || !qadoneCol || !completeCol) return;

    todoCol.innerHTML = '<p style="color: var(--color-text-muted); text-align: center;">Loading...</p>';
    inprogCol.innerHTML = '';
    devdoneCol.innerHTML = '';
    readyforqaCol.innerHTML = '';
    qadoneCol.innerHTML = '';
    completeCol.innerHTML = '';

    try {
        const res = await fetch(`${API_BASE}/api/my-tasks`, {
            headers: { "Authorization": `Bearer ${state.token}` }
        });

        if (!res.ok) throw new Error("Failed to load tasks");
        const tasks = await res.json();

        todoCol.innerHTML = '';
        inprogCol.innerHTML = '';
        devdoneCol.innerHTML = '';
        readyforqaCol.innerHTML = '';
        qadoneCol.innerHTML = '';
        completeCol.innerHTML = '';

        let tasksToRender = tasks;
        if (state.globalProjectId) {
            tasksToRender = tasks.filter(t => t.project_id === parseInt(state.globalProjectId));
        }

        if (tasksToRender.length === 0) {
            todoCol.innerHTML = '<p style="color: var(--color-text-muted); text-align: center; padding: 20px;">No tasks assigned to you for this project.</p>';
            return;
        }

        tasksToRender.forEach(task => {
            const card = createMyTaskCard(task);
            if (task.status === 'In Progress') {
                inprogCol.appendChild(card);
            } else if (task.status === 'Dev Done') {
                devdoneCol.appendChild(card);
            } else if (task.status === 'Ready for QA') {
                readyforqaCol.appendChild(card);
            } else if (task.status === 'QA Done') {
                qadoneCol.appendChild(card);
            } else if (task.status === 'Complete' || task.status === 'Done') {
                completeCol.appendChild(card);
            } else {
                todoCol.appendChild(card);
            }
        });

        if (todoCol.children.length === 0) todoCol.innerHTML = '<p style="color: var(--color-text-muted); text-align: center; padding: 10px; font-size: 0.85rem;">None</p>';
        if (inprogCol.children.length === 0) inprogCol.innerHTML = '<p style="color: var(--color-text-muted); text-align: center; padding: 10px; font-size: 0.85rem;">None</p>';
        if (devdoneCol.children.length === 0) devdoneCol.innerHTML = '<p style="color: var(--color-text-muted); text-align: center; padding: 10px; font-size: 0.85rem;">None</p>';
        if (readyforqaCol.children.length === 0) readyforqaCol.innerHTML = '<p style="color: var(--color-text-muted); text-align: center; padding: 10px; font-size: 0.85rem;">None</p>';
        if (qadoneCol.children.length === 0) qadoneCol.innerHTML = '<p style="color: var(--color-text-muted); text-align: center; padding: 10px; font-size: 0.85rem;">None</p>';
        if (completeCol.children.length === 0) completeCol.innerHTML = '<p style="color: var(--color-text-muted); text-align: center; padding: 10px; font-size: 0.85rem;">None</p>';

        if (window.lucide) lucide.createIcons();

    } catch (e) {
        todoCol.innerHTML = `<p style="color: var(--color-danger);">Error: ${e.message}</p>`;
    }
}

function createMyTaskCard(task) {
    let typeColor = '#2563eb';
    if (task.task_type === 'Frontend') typeColor = '#f59e0b';
    else if (task.task_type === 'AI') typeColor = '#10b981';
    else if (task.task_type === 'Manager') typeColor = '#8b5cf6';

    const card = document.createElement('div');
    card.id = `mytask-card-${task.id}`;
    card.style.cssText = `
        background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 10px;
        padding: 14px; display: flex; flex-direction: column; gap: 8px;
        border-left: 4px solid ${typeColor}; transition: transform 0.15s, box-shadow 0.15s;
        cursor: grab;
    `;
    card.onmouseover = () => {
        card.style.transform = 'translateY(-2px)';
        card.style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)';
    };
    card.onmouseout = () => {
        card.style.transform = 'translateY(0)';
        card.style.boxShadow = 'none';
    };

    card.draggable = true;
    card.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", JSON.stringify({
            projectId: task.project_id,
            storyId: task.story_id,
            taskId: task.id
        }));
        card.style.opacity = "0.5";
    });
    card.addEventListener("dragend", () => {
        card.style.opacity = "1";
    });

    card.innerHTML = `
        <div style="font-weight: 600; font-size: 0.95rem; color: var(--color-text-main);">${task.title}</div>
        <div style="font-size: 0.8rem; color: var(--color-text-muted); display: flex; align-items: center; gap: 6px;">
            <i data-lucide="bookmark" style="width: 12px; height: 12px;"></i>
            ${task.story_title.length > 50 ? task.story_title.substring(0, 47) + '...' : task.story_title}
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px;">
            <span style="font-size: 0.7rem; padding: 3px 8px; border-radius: 8px; font-weight: 600; background: ${typeColor}22; color: ${typeColor}; text-transform: uppercase;">${task.task_type}</span>
            <span style="font-size: 0.75rem; color: var(--color-text-muted);">${task.project_name}</span>
        </div>
        <div style="margin-top: 4px;">
            <select onchange="updateMyTaskStatus(${task.project_id}, ${task.story_id}, ${task.id}, this.value)" 
                style="width: 100%; background: var(--bg-body); border: 1px solid var(--border-color); padding: 6px 8px; border-radius: 6px; color: var(--color-text-main); font-size: 0.8rem; cursor: pointer;">
                <option value="To Do" ${task.status === 'To Do' ? 'selected' : ''}>To Do</option>
                <option value="In Progress" ${task.status === 'In Progress' ? 'selected' : ''}>In Progress</option>
                <option value="Dev Done" ${task.status === 'Dev Done' ? 'selected' : ''}>Dev Done</option>
                <option value="Ready for QA" ${task.status === 'Ready for QA' ? 'selected' : ''}>Ready for QA</option>
                <option value="QA Done" ${task.status === 'QA Done' ? 'selected' : ''}>QA Done</option>
                <option value="Complete" ${task.status === 'Complete' || task.status === 'Done' ? 'selected' : ''}>Complete</option>
            </select>
        </div>
    `;

    return card;
}

function getMyTaskColumnId(status) {
    if (status === 'In Progress') return 'mytasks-inprogress';
    if (status === 'Dev Done') return 'mytasks-devdone';
    if (status === 'Ready for QA') return 'mytasks-readyforqa';
    if (status === 'QA Done') return 'mytasks-qadone';
    if (status === 'Complete' || status === 'Done') return 'mytasks-complete';
    return 'mytasks-todo';
}

window.updateMyTaskStatus = async function (projectId, storyId, taskId, newStatus) {
    const cardEl = document.getElementById(`mytask-card-${taskId}`);
    const newColId = getMyTaskColumnId(newStatus);
    const newColEl = document.getElementById(newColId);

    let oldParent = null;
    let oldStatusSelectVal = null;
    let selectEl = null;

    // 1. Optimistic Update: Move card in DOM instantly
    if (cardEl && newColEl && cardEl.parentNode !== newColEl) {
        oldParent = cardEl.parentNode;
        newColEl.appendChild(cardEl);

        selectEl = cardEl.querySelector("select");
        if (selectEl) {
            oldStatusSelectVal = selectEl.value;
            selectEl.value = newStatus;
        }

        // Remove empty placeholder from target column if present
        const placeholder = newColEl.querySelector("p");
        if (placeholder && (placeholder.textContent === "None" || placeholder.textContent.includes("No tasks assigned"))) {
            placeholder.remove();
        }

        // Add empty placeholder to source column if it's now empty
        if (oldParent && oldParent.children.length === 0) {
            oldParent.innerHTML = '<p style="color: var(--color-text-muted); text-align: center; padding: 10px; font-size: 0.85rem;">None</p>';
        }
    }

    try {
        const res = await fetch(`${API_BASE}/api/projects/${projectId}/stories/${storyId}/tasks/${taskId}`, {
            method: "PUT",
            headers: {
                "Authorization": `Bearer ${state.token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ status: newStatus })
        });
        if (!res.ok) throw new Error("Failed to update task");
        showToast(`Task moved to ${newStatus}`, "success");
    } catch (e) {
        showToast(e.message, "error");
        // Rollback UI to original state on failure
        if (cardEl && oldParent) {
            oldParent.appendChild(cardEl);
            if (selectEl) selectEl.value = oldStatusSelectVal;
            // Clean up placeholders
            const placeholder = oldParent.querySelector("p");
            if (placeholder && (placeholder.textContent === "None" || placeholder.textContent.includes("No tasks assigned"))) {
                placeholder.remove();
            }
            if (newColEl && newColEl.children.length === 0) {
                newColEl.innerHTML = '<p style="color: var(--color-text-muted); text-align: center; padding: 10px; font-size: 0.85rem;">None</p>';
            }
        }
    }
};

window.handleMyTaskBoardDrop = async function (e, newStatus) {
    e.preventDefault();
    try {
        const dragData = JSON.parse(e.dataTransfer.getData("text/plain"));
        if (!dragData || !dragData.projectId || !dragData.storyId || !dragData.taskId) return;

        await window.updateMyTaskStatus(dragData.projectId, dragData.storyId, dragData.taskId, newStatus);
    } catch (err) {
        console.error("Failed to handle My Task drop:", err);
    }
};

// =====================================================================
// Custom Sleek Global Tooltip Controller
// =====================================================================
const customTooltipEl = document.createElement("div");
customTooltipEl.id = "app-custom-global-tooltip";
customTooltipEl.style.cssText = "position: fixed; background: rgba(15, 23, 42, 0.95); color: #f8fafc; font-size: 0.72rem; font-weight: 500; padding: 4px 8px; border-radius: 6px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25); border: 1px solid rgba(255, 255, 255, 0.12); z-index: 100000; pointer-events: none; opacity: 0; transition: opacity 0.15s ease, transform 0.15s ease; transform: translateY(4px); white-space: nowrap; line-height: 1.3;";

document.addEventListener("mouseover", (e) => {
    const target = e.target.closest("[title], [data-tooltip]");
    if (!target) return;
    if (target.hasAttribute("title")) {
        const titleText = target.getAttribute("title");
        if (titleText) {
            target.setAttribute("data-tooltip", titleText);
            target.removeAttribute("title");
        }
    }
    const text = target.getAttribute("data-tooltip");
    if (!text) return;

    if (!customTooltipEl.parentNode) document.body.appendChild(customTooltipEl);
    customTooltipEl.textContent = text;
    customTooltipEl.style.opacity = "1";
    customTooltipEl.style.transform = "translateY(0)";

    const rect = target.getBoundingClientRect();
    const tooltipRect = customTooltipEl.getBoundingClientRect();

    let top = rect.top - tooltipRect.height - 6;
    if (top < 8) {
        top = rect.bottom + 6;
    }
    let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
    if (left < 8) left = 8;
    if (left + tooltipRect.width > window.innerWidth - 8) {
        left = window.innerWidth - tooltipRect.width - 8;
    }

    customTooltipEl.style.top = `${top}px`;
    customTooltipEl.style.left = `${left}px`;
});

document.addEventListener("mouseout", (e) => {
    const target = e.target.closest("[data-tooltip]");
    if (target) {
        customTooltipEl.style.opacity = "0";
        customTooltipEl.style.transform = "translateY(4px)";
    }
});

document.addEventListener("mousedown", () => {
    customTooltipEl.style.opacity = "0";
});

// Enable horizontal click-and-drag (swipe) scrolling on Kanban grids
function enableDragScroll(selector) {
    const el = document.querySelector(selector);
    if (!el) return;
    let isDown = false;
    let startX;
    let scrollLeft;

    el.addEventListener('mousedown', (e) => {
        // Ignore dragging if clicking a card or button inside
        if (e.target.closest('.board-card') || e.target.closest('button') || e.target.closest('select')) return;
        isDown = true;
        el.style.cursor = 'grabbing';
        startX = e.pageX - el.offsetLeft;
        scrollLeft = el.scrollLeft;
    });
    el.addEventListener('mouseleave', () => {
        isDown = false;
        el.style.cursor = '';
    });
    el.addEventListener('mouseup', () => {
        isDown = false;
        el.style.cursor = '';
    });
    el.addEventListener('mousemove', (e) => {
        if (!isDown) return;
        e.preventDefault();
        const x = e.pageX - el.offsetLeft;
        const walk = (x - startX) * 1.5;
        el.scrollLeft = scrollLeft - walk;
    });
}

function setupKanbanScrollbars() {
    document.querySelectorAll('.kanban-scroll-range').forEach(slider => {
        const targetId = slider.getAttribute('data-target');
        const grid = document.getElementById(targetId);
        if (!grid) return;

        slider.addEventListener('input', () => {
            const maxScroll = grid.scrollWidth - grid.clientWidth;
            if (maxScroll > 0) {
                grid.scrollLeft = (slider.value / 1000) * maxScroll;
            }
        });

        grid.addEventListener('scroll', () => {
            const maxScroll = grid.scrollWidth - grid.clientWidth;
            if (maxScroll > 0) {
                slider.value = Math.round((grid.scrollLeft / maxScroll) * 1000);
            }
        });
    });
}

document.addEventListener('DOMContentLoaded', () => {
    enableDragScroll('#stories-board-grid');
    enableDragScroll('#mytasks-board-grid');
    enableDragScroll('#stories-list-scroll-wrapper');
    setupKanbanScrollbars();
    bindNotificationEvents();
});


// =====================================================================
// Team & Task Notifications Handlers
// =====================================================================
let notificationPollInterval = null;

function startNotificationPolling() {
    stopNotificationPolling();
    loadNotifications();
    notificationPollInterval = setInterval(loadNotifications, 15000); // Check every 15 seconds
}

function stopNotificationPolling() {
    if (notificationPollInterval) {
        clearInterval(notificationPollInterval);
        notificationPollInterval = null;
    }
}

async function loadNotifications() {
    if (!state.token) return;

    try {
        const res = await fetch(`${API_BASE}/api/notifications`, {
            headers: { "Authorization": `Bearer ${state.token}` }
        });
        if (!res.ok) return;

        const notifs = await res.json();

        // Count unread notifications
        const unreadCount = notifs.filter(n => !n.is_read).length;

        // Update badge
        const badge = document.getElementById("notif-badge");
        if (unreadCount > 0) {
            badge.textContent = unreadCount;
            badge.style.display = "flex";
        } else {
            badge.style.display = "none";
        }

        // Render in dropdown list
        const notifList = document.getElementById("notif-list");
        notifList.innerHTML = "";

        if (notifs.length === 0) {
            notifList.innerHTML = '<div class="notif-empty">No notifications yet.</div>';
            return;
        }

        notifs.forEach(n => {
            const utcNotifTime = n.created_at.endsWith("Z") ? n.created_at : n.created_at + "Z";
            const dateStr = new Date(utcNotifTime).toLocaleString();
            const div = document.createElement("div");
            div.className = `notif-item ${n.is_read ? 'read' : 'unread'}`;

            const titleEl = document.createElement("div");
            titleEl.className = "notif-title";
            titleEl.textContent = n.title;

            const messageEl = document.createElement("div");
            messageEl.className = "notif-message";
            messageEl.textContent = n.message;

            const timeEl = document.createElement("div");
            timeEl.className = "notif-time";
            timeEl.textContent = dateStr;

            div.appendChild(titleEl);
            div.appendChild(messageEl);
            div.appendChild(timeEl);

            // Mark as read when clicked
            div.addEventListener("click", async () => {
                if (!n.is_read) {
                    await fetch(`${API_BASE}/api/notifications/${n.id}/read`, {
                        method: "PUT",
                        headers: { "Authorization": `Bearer ${state.token}` }
                    });
                    loadNotifications();
                }
            });

            notifList.appendChild(div);
        });

    } catch (e) {
        console.error("Error loading notifications:", e);
    }
}

function bindNotificationEvents() {
    const bellBtn = document.getElementById("notif-bell-btn");
    const dropdown = document.getElementById("notif-dropdown");
    const readAllBtn = document.getElementById("btn-read-all-notifs");

    if (!bellBtn || !dropdown || !readAllBtn) return;

    // Toggle dropdown
    bellBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const show = dropdown.style.display === "none";
        dropdown.style.display = show ? "flex" : "none";
        if (show) {
            loadNotifications();
        }
    });

    // Close dropdown on click outside
    document.addEventListener("click", (e) => {
        if (!e.target.closest("#notif-container")) {
            dropdown.style.display = "none";
        }
    });

    // Mark all as read
    readAllBtn.addEventListener("click", async () => {
        try {
            await fetch(`${API_BASE}/api/notifications/read-all`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${state.token}` }
            });
            loadNotifications();
        } catch (e) {
            console.error("Error marking all notifications as read:", e);
        }
    });
}



