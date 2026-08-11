const dependencyCatalog = {
    tailwind: { globalName: 'tailwind', label: 'Tailwind Play CDN' },
    lucide: { globalName: 'lucide', label: 'Lucide Icons', fallback: 'https://unpkg.com/lucide@1.25.0' },
    XLSX: { globalName: 'XLSX', label: 'SheetJS XLSX', fallback: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js' },
    jsPDF: { globalName: 'jspdf', label: 'jsPDF 2.5.1', fallback: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js' },
    jsPDFAutoTable: { globalName: 'jspdf', label: 'jsPDF AutoTable', fallback: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.4/jspdf.plugin.autotable.min.js', test: () => Boolean(window.jspdf?.jsPDF?.API?.autoTable) },
    html2canvas: { globalName: 'html2canvas', label: 'html2canvas', fallback: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js' },
    QRCode: { globalName: 'QRCode', label: 'QRCode.js', fallback: 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js' }
};

const loadedFallbacks = new Map();
const LOAD_TIMEOUT_MS = 5000;
const hasDependency = (spec) => spec.test ? spec.test() : Boolean(window[spec.globalName]);

function loadFallback(src) {
    if(loadedFallbacks.has(src)) return loadedFallbacks.get(src);
    const promise = new Promise((resolve) => {
        const script = document.createElement('script');
        let settled = false;
        const finish = (ok, message) => {
            if(settled) return;
            settled = true;
            window.clearTimeout(timer);
            if(message) console.warn(message);
            resolve(ok);
        };
        const timer = window.setTimeout(() => finish(false, `Timed out loading ${src}`), LOAD_TIMEOUT_MS);
        script.src = src;
        script.async = false;
        script.onload = () => finish(true);
        script.onerror = () => finish(false, `Failed to load ${src}`);
        document.head.appendChild(script);
    });
    loadedFallbacks.set(src, promise);
    return promise;
}

function reportDependencyWarning(message) {
    console.warn(message);
    if(window.showToast) {
        window.showToast(message, 'error');
        return;
    }
    window.adminDependencyWarnings = window.adminDependencyWarnings || [];
    window.adminDependencyWarnings.push(message);
}

window.ensureAdminDependencies = async (names = Object.keys(dependencyCatalog)) => {
    const status = {};
    for(const name of names) {
        const spec = dependencyCatalog[name];
        if(!spec) continue;
        if(!hasDependency(spec) && spec.fallback) {
            await loadFallback(spec.fallback);
        }
        status[name] = hasDependency(spec);
        if(!status[name]) reportDependencyWarning(`${spec.label} failed to load. Some admin tools may be unavailable.`);
    }
    window.adminDependencyStatus = { ...(window.adminDependencyStatus || {}), ...status };
    return status;
};

window.adminDependencyCatalog = dependencyCatalog;
