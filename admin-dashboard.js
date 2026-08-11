export function ensureAdminSharedState() {
    window.adminSharedState = window.adminSharedState || (() => {
        const state = {};
        return {
            update(payload = {}) {
                Object.assign(state, payload);
                window.dispatchEvent(new CustomEvent('admin-shared-state', { detail: { ...state } }));
            },
            snapshot() {
                return { ...state };
            }
        };
    })();
    return window.adminSharedState;
}
