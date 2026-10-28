import Foundation

struct WindowBounds: Equatable, Sendable {
    let x: Double, y: Double, width: Double, height: Double
    func matches(_ other: WindowBounds) -> Bool {
        abs(x-other.x) <= 1 && abs(y-other.y) <= 1 && abs(width-other.width) <= 1 && abs(height-other.height) <= 1
    }
    var json: [String: Double] { ["x":x,"y":y,"width":width,"height":height] }
}
struct WindowCandidate: Sendable {
    let id: UInt32, pid: Int32, title: String, bounds: WindowBounds
}
// Window-server titles may be hidden without Screen Recording. Geometry must
// still identify exactly one window; ambiguity never selects a larger one.
func matchingWindow(pid: Int32, title: String, bounds: WindowBounds, candidates: [WindowCandidate]) -> WindowCandidate? {
    let matches = candidates.filter { $0.pid == pid && $0.bounds.matches(bounds) && ($0.title.isEmpty || title.isEmpty || $0.title == title) }
    return matches.count == 1 ? matches[0] : nil
}

struct AXWindowCandidate { let title: String, bounds: WindowBounds }
func labelledWindows(pid: Int32, ax: [AXWindowCandidate], candidates: [WindowCandidate]) -> [WindowCandidate] {
    ax.compactMap { item in
        guard let matched=matchingWindow(pid:pid,title:item.title,bounds:item.bounds,candidates:candidates) else { return nil }
        return WindowCandidate(id:matched.id,pid:pid,title:item.title,bounds:matched.bounds)
    }
}
