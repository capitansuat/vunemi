// Calendar and Reminders, through EventKit.
//
// This is the local answer to Muse's cloud channels: the user's calendar is
// already on this Mac, synced by macOS itself, so Vunemi reads it where it lies
// instead of asking for an account password and talking to a server. Nothing
// here holds a credential, because there is none to hold.
//
// Like the rest of the helper, this file decides nothing. It does not judge
// which events may be read or created; it reports what EventKit says and lets
// the TypeScript side and the Sentinel do the deciding.
//
// One thing EventKit will not do is add attendees to an event — EKParticipant
// is read-only. That suits us: inviting someone is sending them a message,
// and messages are not something the agent does on its own.

import EventKit
import Foundation

/// One store for the process. EventKit is not Sendable and this executable is
/// single-threaded; the same reasoning as `trees` in main.swift.
nonisolated(unsafe) let eventStore = EKEventStore()

nonisolated(unsafe) private let iso: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

// JavaScript Date.toISOString() includes milliseconds, while the default
// ISO8601DateFormatter above only accepts whole seconds.
nonisolated(unsafe) private let isoWithFractionalSeconds: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

/// Waits for one of EventKit's callback APIs without a run loop.
private final class Box<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}

// MARK: - Permission

/// True only for full access: write-only access can create an event but not
/// read one back, and an agent that can't read what it wrote is worse than an
/// agent that says it has no access.
func calendarGranted(_ entity: EKEntityType) -> Bool {
    EKEventStore.authorizationStatus(for: entity) == .fullAccess
}

/// What macOS thinks, in a word the TypeScript side can act on.
func calendarState(_ entity: EKEntityType) -> String {
    switch EKEventStore.authorizationStatus(for: entity) {
    case .fullAccess: return "granted"
    case .writeOnly: return "writeOnly"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

/// Shows the system dialog, once. After that only System Settings can change it.
func requestCalendarAccess(_ entity: EKEntityType) throws -> Bool {
    let box = Box<(ok: Bool, error: String?)>((false, nil))
    let waiter = DispatchSemaphore(value: 0)
    let done: @Sendable (Bool, Error?) -> Void = { granted, error in
        box.value = (granted, error?.localizedDescription)
        waiter.signal()
    }
    switch entity {
    case .event: eventStore.requestFullAccessToEvents(completion: done)
    case .reminder: eventStore.requestFullAccessToReminders(completion: done)
    @unknown default: throw Failure("Bilinmeyen takvim türü.")
    }
    // The dialog waits for a person; a machine should not wait forever.
    guard waiter.wait(timeout: .now() + 60) == .success else {
        throw Failure("İzin penceresi yanıtlanmadı.")
    }
    if let error = box.value.error { throw Failure(error) }
    return box.value.ok
}

private func requireAccess(_ entity: EKEntityType) throws {
    guard calendarGranted(entity) else {
        let what = entity == .event ? "Takvim" : "Anımsatıcılar"
        throw Failure(
            "\(what) izni verilmemiş. Sistem Ayarları › Gizlilik ve Güvenlik › \(what) altından izni sen vermelisin."
        )
    }
}

// MARK: - Reading

/// EventKit's source type as a word, so the caller does not carry a table
/// of integers around. Google shows up as CalDAV, not as anything Google.
private func sourceKind(_ type: EKSourceType) -> String {
    switch type {
    case .local: return "local"
    case .exchange: return "exchange"
    case .calDAV: return "caldav"
    case .mobileMe: return "icloud"
    case .subscribed: return "subscribed"
    case .birthdays: return "birthdays"
    @unknown default: return "other"
    }
}

func calendarList(_ entity: EKEntityType) throws -> [JSON] {
    try requireAccess(entity)
    return eventStore.calendars(for: entity).map { calendar in
        [
            "id": calendar.calendarIdentifier,
            "title": calendar.title,
            // Which account this calendar came from. A Google or Exchange
            // calendar added in System Settings arrives here like any
            // other, which is the whole point: macOS does the syncing and
            // the signing in, and no token ever reaches Vunemi.
            "source": calendar.source.title,
            "sourceKind": sourceKind(calendar.source.sourceType),
            "writable": calendar.allowsContentModifications,
            "default": calendar.calendarIdentifier
                == (entity == .event
                    ? eventStore.defaultCalendarForNewEvents?.calendarIdentifier
                    : eventStore.defaultCalendarForNewReminders()?.calendarIdentifier),
        ]
    }
}

func events(from start: Date, to end: Date, calendars named: [String]?) throws -> [JSON] {
    try requireAccess(.event)
    let all = eventStore.calendars(for: .event)
    let wanted = named.map { names in
        all.filter { calendar in
            names.contains { $0.caseInsensitiveCompare(calendar.title) == .orderedSame || $0 == calendar.calendarIdentifier }
        }
    }
    if let wanted, wanted.isEmpty {
        throw Failure("O adda bir takvim yok. Olanlar: \(all.map(\.title).joined(separator: ", ")).")
    }
    let predicate = eventStore.predicateForEvents(withStart: start, end: end, calendars: wanted)
    return eventStore.events(matching: predicate)
        .sorted { ($0.startDate ?? .distantPast) < ($1.startDate ?? .distantPast) }
        .map(describe)
}

private func describe(_ event: EKEvent) -> JSON {
    var json: JSON = [
        "id": event.eventIdentifier ?? "",
        "title": event.title ?? "",
        "allDay": event.isAllDay,
        "calendar": event.calendar?.title ?? "",
    ]
    if let start = event.startDate { json["start"] = iso.string(from: start) }
    if let end = event.endDate { json["end"] = iso.string(from: end) }
    if let location = event.location, !location.isEmpty { json["location"] = location }
    if let notes = event.notes, !notes.isEmpty { json["notes"] = notes }
    // Who else is coming is the difference between a reminder and a meeting.
    if let attendees = event.attendees, !attendees.isEmpty {
        json["attendees"] = attendees.map {
            $0.name ?? $0.url.absoluteString.replacingOccurrences(of: "mailto:", with: "")
        }
    }
    return json
}

func reminders(list named: String?, includeCompleted: Bool) throws -> [JSON] {
    try requireAccess(.reminder)
    let all = eventStore.calendars(for: .reminder)
    var wanted: [EKCalendar]? = nil
    if let named {
        let hit = all.filter { $0.title.caseInsensitiveCompare(named) == .orderedSame || $0.calendarIdentifier == named }
        guard !hit.isEmpty else {
            throw Failure("O adda bir liste yok. Olanlar: \(all.map(\.title).joined(separator: ", ")).")
        }
        wanted = hit
    }
    let predicate =
        includeCompleted
        ? eventStore.predicateForReminders(in: wanted)
        : eventStore.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: wanted)

    let box = Box<[EKReminder]>([])
    let waiter = DispatchSemaphore(value: 0)
    eventStore.fetchReminders(matching: predicate) { found in
        box.value = found ?? []
        waiter.signal()
    }
    guard waiter.wait(timeout: .now() + 20) == .success else { throw Failure("Anımsatıcılar okunamadı.") }

    return box.value
        .sorted { due($0) < due($1) }
        .map(describe)
}

private func due(_ reminder: EKReminder) -> Date {
    reminder.dueDateComponents?.date ?? .distantFuture
}

// MARK: - Writing

func createEvent(
    title: String, start: Date, end: Date, allDay: Bool, calendar named: String?, notes: String?, location: String?
) throws -> JSON {
    try requireAccess(.event)
    guard let calendar = try writableCalendar(named, for: .event) else {
        throw Failure("Yazılabilir bir takvim bulunamadı.")
    }
    let event = EKEvent(eventStore: eventStore)
    event.title = title
    event.startDate = start
    event.endDate = end
    event.isAllDay = allDay
    event.calendar = calendar
    if let notes, !notes.isEmpty { event.notes = notes }
    if let location, !location.isEmpty { event.location = location }
    try eventStore.save(event, span: .thisEvent, commit: true)
    return describe(event)
}

/// Undo for a created event. Kept narrow on purpose: it removes one event by
/// the identifier we just made, never an arbitrary one the model names.
func removeEvent(id: String) throws {
    try requireAccess(.event)
    guard let event = eventStore.event(withIdentifier: id) else { throw Failure("O etkinlik artık yok.") }
    try eventStore.remove(event, span: .thisEvent, commit: true)
}

/// One event by its identifier, as calendar_events shows it, and what
/// decides whether it may be deleted.
func event(id: String) throws -> JSON {
    try requireAccess(.event)
    guard let event = eventStore.event(withIdentifier: id) else { throw Failure("O etkinlik yok ya da silinmiş.") }
    var json = describe(event)
    json["recurring"] = event.hasRecurrenceRules
    json["writable"] = event.calendar?.allowsContentModifications ?? false
    return json
}

/// Deletes one event the user approved on a card, and hands back what it
/// was, so the app can put it back. Refused here as well as in the app:
/// removing a meeting sends every attendee a cancellation, and one day of a
/// repeating event could not be put back as it was.
func deleteEvent(id: String) throws -> JSON {
    try requireAccess(.event)
    guard let event = eventStore.event(withIdentifier: id) else { throw Failure("O etkinlik yok ya da silinmiş.") }
    if let attendees = event.attendees, !attendees.isEmpty {
        throw Failure("Katılımcıları olan bir toplantı; silmek herkese iptal gönderir.")
    }
    if event.hasRecurrenceRules { throw Failure("Tekrarlayan bir etkinlik; buradan silinmez.") }
    guard event.calendar?.allowsContentModifications == true else { throw Failure("Bu takvim değiştirilemiyor.") }
    let snapshot = describe(event)
    try eventStore.remove(event, span: .thisEvent, commit: true)
    return snapshot
}

/// Changes the fields the user approved on a card and hands back what the
/// event was before and after, so the app can change it back. The same
/// refusals as deleting: a meeting's attendees would all be told, and one
/// day of a repeating event is not something to edit from here.
func updateEvent(id: String, fields: JSON) throws -> JSON {
    try requireAccess(.event)
    guard let event = eventStore.event(withIdentifier: id) else { throw Failure("O etkinlik yok ya da silinmiş.") }
    if let attendees = event.attendees, !attendees.isEmpty {
        throw Failure("Katılımcıları olan bir toplantı; değiştirmek herkese bildirim gönderir.")
    }
    if event.hasRecurrenceRules { throw Failure("Tekrarlayan bir etkinlik; buradan değiştirilmez.") }
    guard event.calendar?.allowsContentModifications == true else { throw Failure("Bu takvim değiştirilemiyor.") }
    let before = describe(event)
    if let title = (fields["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) {
        guard !title.isEmpty else { throw Failure("Etkinliğin bir başlığı olmalı.") }
        event.title = title
    }
    if fields["start"] != nil { event.startDate = try date(fields["start"], "Başlangıç") }
    if fields["end"] != nil { event.endDate = try date(fields["end"], "Bitiş") }
    guard let start = event.startDate, let end = event.endDate, end > start else {
        throw Failure("Bitiş, başlangıçtan sonra olmalı.")
    }
    // An empty string clears the field; absent leaves it alone.
    if let location = fields["location"] as? String { event.location = location.isEmpty ? nil : location }
    if let notes = fields["notes"] as? String { event.notes = notes.isEmpty ? nil : notes }
    try eventStore.save(event, span: .thisEvent, commit: true)
    return ["before": before, "after": describe(event)]
}

func createReminder(title: String, due: Date?, list named: String?, notes: String?) throws -> JSON {
    try requireAccess(.reminder)
    guard let calendar = try writableCalendar(named, for: .reminder) else {
        throw Failure("Yazılabilir bir anımsatıcı listesi bulunamadı.")
    }
    let reminder = EKReminder(eventStore: eventStore)
    reminder.title = title
    reminder.calendar = calendar
    if let notes, !notes.isEmpty { reminder.notes = notes }
    if let due {
        reminder.dueDateComponents = Calendar.current.dateComponents(
            [.year, .month, .day, .hour, .minute], from: due)
    }
    try eventStore.save(reminder, commit: true)
    var json: JSON = ["id": reminder.calendarItemIdentifier, "title": title, "list": calendar.title, "completed": false]
    if let due { json["due"] = iso.string(from: due) }
    return json
}

func setReminderCompleted(id: String, completed: Bool) throws -> JSON {
    try requireAccess(.reminder)
    guard let reminder = eventStore.calendarItem(withIdentifier: id) as? EKReminder else {
        throw Failure("O anımsatıcı bulunamadı.")
    }
    reminder.isCompleted = completed
    try eventStore.save(reminder, commit: true)
    return ["id": id, "title": reminder.title ?? "", "completed": completed]
}

func removeReminder(id: String) throws {
    try requireAccess(.reminder)
    guard let reminder = eventStore.calendarItem(withIdentifier: id) as? EKReminder else {
        throw Failure("O anımsatıcı artık yok.")
    }
    try eventStore.remove(reminder, commit: true)
}

private func describe(_ reminder: EKReminder) -> JSON {
    var json: JSON = [
        "id": reminder.calendarItemIdentifier,
        "title": reminder.title ?? "",
        "completed": reminder.isCompleted,
        "list": reminder.calendar?.title ?? "",
    ]
    if let date = reminder.dueDateComponents?.date { json["due"] = iso.string(from: date) }
    if let notes = reminder.notes, !notes.isEmpty { json["notes"] = notes }
    return json
}

private func reminder(_ id: String) throws -> EKReminder {
    try requireAccess(.reminder)
    guard let reminder = eventStore.calendarItem(withIdentifier: id) as? EKReminder else {
        throw Failure("O anımsatıcı yok ya da silinmiş.")
    }
    return reminder
}

/// One reminder by its identifier, as reminders_list shows it.
func reminderDetail(id: String) throws -> JSON {
    describe(try reminder(id))
}

/// Changes a reminder and hands back what it was, so the app can change it back.
func updateReminder(id: String, fields: JSON) throws -> JSON {
    let item = try reminder(id)
    guard item.calendar?.allowsContentModifications == true else { throw Failure("Bu liste değiştirilemiyor.") }
    let before = describe(item)
    if let title = (fields["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) {
        guard !title.isEmpty else { throw Failure("Anımsatıcının bir başlığı olmalı.") }
        item.title = title
    }
    if let due = fields["due"] as? String {
        if due.isEmpty {
            item.dueDateComponents = nil
        } else {
            guard let when = parseDate(due) else { throw Failure("Tarih okunamadı: \(due)") }
            item.dueDateComponents = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: when)
        }
    }
    if let notes = fields["notes"] as? String { item.notes = notes.isEmpty ? nil : notes }
    if let done = fields["completed"] as? Bool { item.isCompleted = done }
    try eventStore.save(item, commit: true)
    return ["before": before, "after": describe(item)]
}

/// Deletes one reminder the user approved on a card and hands back what it
/// was, so the app can make it again.
func deleteReminder(id: String) throws -> JSON {
    let item = try reminder(id)
    guard item.calendar?.allowsContentModifications == true else { throw Failure("Bu liste değiştirilemiyor.") }
    let snapshot = describe(item)
    try eventStore.remove(item, commit: true)
    return snapshot
}

private func writableCalendar(_ named: String?, for entity: EKEntityType) throws -> EKCalendar? {
    let all = eventStore.calendars(for: entity).filter(\.allowsContentModifications)
    guard let named else {
        return entity == .event ? eventStore.defaultCalendarForNewEvents ?? all.first : eventStore.defaultCalendarForNewReminders() ?? all.first
    }
    guard
        let hit = all.first(where: {
            $0.title.caseInsensitiveCompare(named) == .orderedSame || $0.calendarIdentifier == named
        })
    else {
        throw Failure("\"\(named)\" diye yazılabilir bir takvim yok. Olanlar: \(all.map(\.title).joined(separator: ", ")).")
    }
    return hit
}

/// ISO in, Date out. The TypeScript side formats for people; the helper does not.
func date(_ value: Any?, _ what: String) throws -> Date {
    guard let text = value as? String, let parsed = parseDate(text) else {
        throw Failure("\(what) okunabilir bir tarih değil (ISO 8601 bekleniyor).")
    }
    return parsed
}

func parseDate(_ text: String) -> Date? {
    if let parsed = isoWithFractionalSeconds.date(from: text) { return parsed }
    if let parsed = iso.date(from: text) { return parsed }
    // Times without a zone are the user's local time, which is what a person
    // means when they say "Thursday at three".
    let local = DateFormatter()
    local.locale = Locale(identifier: "en_US_POSIX")
    local.timeZone = .current
    for format in ["yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd HH:mm", "yyyy-MM-dd"] {
        local.dateFormat = format
        if let parsed = local.date(from: text) { return parsed }
    }
    return nil
}
