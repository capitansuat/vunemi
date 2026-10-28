import type { LocalSlot } from '../../shared/native-recipes';
export function resolveNativeRecipeSlots(inputs: LocalSlot[], timeZone: string, now: number): {
    kind: 'resolved';
    ats: number[];
} | {
    kind: 'needs-offset';
    choices: {
        index: number;
        offsetMinutes: number[];
    }[];
} {
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 4 || !Number.isFinite(now))
        throw Error('Invalid slots');
    const format = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const localAt = (at: number) => { const p = Object.fromEntries(format.formatToParts(at).map(x => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; };
    const choices: {
        index: number;
        offsetMinutes: number[];
    }[] = [];
    const ats: number[] = [];
    inputs.forEach((s, index) => {
        if (!s || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s.local))
            throw Error('Invalid local time');
        const wall = Date.parse(s.local + 'Z');
        if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 16) !== s.local)
            throw Error('Invalid local time');
        const candidates: number[] = [];
        for (let offset = -14 * 60; offset <= 14 * 60; offset++) {
            if (localAt(wall - offset * 60000) === s.local)
                candidates.push(offset);
        }
        if (!candidates.length)
            throw Error('Nonexistent local time');
        if (s.offsetMinutes !== undefined && (!Number.isInteger(s.offsetMinutes) || !candidates.includes(s.offsetMinutes)))
            throw Error('Invalid offset');
        if (candidates.length > 1 && s.offsetMinutes === undefined) {
            choices.push({ index, offsetMinutes: candidates });
            return;
        }
        const at = wall - (s.offsetMinutes ?? candidates[0]!) * 60000;
        if (at < now + 120000 || at > now + 86400000)
            throw Error('Slot outside approved window');
        ats.push(at);
    });
    if (choices.length)
        return { kind: 'needs-offset', choices };
    ats.sort((a, b) => a - b);
    if (ats.some((at, i) => i > 0 && at - ats[i - 1]! < 120000))
        throw Error('Duplicate or too-close slots');
    return { kind: 'resolved', ats };
}
