const API_BASE = '';

// Token management
function getToken() {
    return localStorage.getItem('gc_token');
}

function setToken(token) {
    localStorage.setItem('gc_token', token);
}

function getUser() {
    const user = localStorage.getItem('gc_user');
    return user ? JSON.parse(user) : null;
}

function setUser(user) {
    localStorage.setItem('gc_user', JSON.stringify(user));
}

function logout() {
    localStorage.removeItem('gc_token');
    localStorage.removeItem('gc_user');
    window.location.href = '/login.html';
}

function requireAuth(role) {
    const token = getToken();
    const user = getUser();
    if (!token || !user) {
        window.location.href = '/login.html';
        return { id: 0, name: 'Guest', role: 'guest', __redirecting: true };
    }
    if (role && user.role !== role) {
        window.location.href = getDashboardUrl(user.role);
        return { id: 0, name: 'Guest', role: 'guest', __redirecting: true };
    }
    return user;
}

function getDashboardUrl(role) {
    const map = {
        'client': '/client/dashboard.html',
        'driver': '/driver/dashboard.html',
        'vehicle_manager': '/vehicle_manager/dashboard.html',
        'admin': '/admin/dashboard.html',
        'production_employee': '/production_employee/dashboard.html',
        'production_manager': '/production_manager/dashboard.html',
        'packing_employee': '/packing_employee/dashboard.html',
        'packing_manager': '/packing_manager/dashboard.html',
        'sales_team': '/sales_team/dashboard.html',
        'auditor': '/auditor/dashboard.html',
        'warehouse_driver': '/warehouse_driver/dashboard.html',
        'warehouse_manager': '/warehouse_manager/dashboard.html',
        'sales_driver': '/sales_driver/dashboard.html',
        'customer': '/customer/dashboard.html'
    };
    return map[role] || '/login.html';
}

// API wrapper
async function api(endpoint, options = {}) {
    const token = getToken();
    const headers = {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...options.headers
    };

    const response = await fetch(`${API_BASE}${endpoint}`, {
        ...options,
        headers
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || 'Request failed');
    }

    return data;
}

// Toast notifications
function showToast(message, type = 'info') {
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    const icons = { success: '✅', error: '❌', info: 'ℹ️' };

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
    <span class="toast-icon">${icons[type]}</span>
    <span class="toast-message">${message}</span>
  `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'toastIn 0.3s ease reverse';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// Format date
function formatDate(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// Status badge
function statusBadge(status) {
    const labels = {
        pending: '⏳ Pending',
        assigned: '🚛 Assigned',
        in_transit: '🏃 In Transit',
        completed: '✅ Completed',
        cancelled: '❌ Cancelled'
    };
    return `<span class="badge badge-${status}">${labels[status] || status}</span>`;
}

// Waste type icon
function wasteIcon(type) {
    const icons = {
        vegetables: '🥬',
        fruits: '🍎',
        mixed: '🥗'
    };
    return icons[type] || '♻️';
}
