export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export const jsAttr = (value) => escapeHtml(JSON.stringify(String(value ?? '')));

export const normalizeStageValue = (value) => String(value || '').trim().replace(/^stage\s*/i, '').replace(/\s+/g, ' ').toLowerCase();

export const normalizeStageForSchedule = normalizeStageValue;

export function showToastAdapter(message, type = 'success') {
    if(window.showToast) {
        window.showToast(message, type);
        return true;
    }
    return false;
}

export function normalizeResultData(raw = {}, { events = [], students = [] } = {}) {
    const eventId = raw.eventId || raw.id || '';
    const event = events.find(e => e.id === eventId);
    const eventName = raw.eventName || event?.name || '';
    const resolveWinner = (winner) => {
        if(!winner) return null;
        if(typeof winner === 'object') return { name: winner.name || 'Unknown', team: winner.team || '-', chestNo: winner.chestNo || winner.id || '' };
        const student = students.find(s => s.id === winner || String(s.chestNo) === String(winner) || s.name === winner);
        return student ? { name: student.name, team: student.team, chestNo: student.chestNo } : { name: String(winner), team: '-', chestNo: String(winner) };
    };
    const legacyPlaces = raw.winners ? ['first', 'second', 'third'].flatMap(place => {
        const winners = Array.isArray(raw.winners[place]) ? raw.winners[place] : [raw.winners[place]].filter(Boolean);
        return winners.map(resolveWinner).filter(Boolean);
    }) : [];
    const normalizeAward = (award = {}, index = 0) => ({
        ...award,
        key: award.key || `place${index + 1}`,
        label: award.label || `Place ${index + 1}`,
        value: Number(award.value || 0),
        earnedValue: Number(award.earnedValue ?? award.value ?? 0),
        winners: (Array.isArray(award.winners) ? award.winners : [award.winners]).map(resolveWinner).filter(Boolean)
    });
    const places = Array.isArray(raw.places) && raw.places.length ? raw.places.map(normalizeAward).filter(p => p.winners.length) : legacyPlaces;
    const gradeAwards = Array.isArray(raw.gradeAwards) ? raw.gradeAwards.map((grade = {}) => ({ ...grade, value: Number(grade.value || 0), winners: (Array.isArray(grade.winners) ? grade.winners : [grade.winners]).map(resolveWinner).filter(Boolean) })) : [];
    return { ...raw, id: raw.id || eventId, eventId, eventName, places, gradeAwards, status: raw.status || 'published', publishedAt: raw.publishedAt || raw.createdAt || null, updatedAt: raw.updatedAt || raw.publishedAt || raw.createdAt || null, updatedBy: raw.updatedBy || 'admin-ui' };
}

export function exportRows(XLSX, rows, fileName, { sheetName = 'Sheet1', emptyMessage = 'No Data', toast = showToastAdapter } = {}) {
    if(!Array.isArray(rows) || !rows.length) {
        toast(emptyMessage, 'error');
        return false;
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), sheetName);
    XLSX.writeFile(wb, fileName);
    return true;
}

export function printPage(mode = '') {
    const className = mode ? `print-mode-${mode}` : '';
    const cleanup = () => {
        if(className) document.body.classList.remove(className);
        window.removeEventListener('afterprint', cleanup);
    };
    if(className) document.body.classList.add(className);
    window.addEventListener('afterprint', cleanup, { once: true });
    window.print();
    setTimeout(cleanup, 1000);
}
