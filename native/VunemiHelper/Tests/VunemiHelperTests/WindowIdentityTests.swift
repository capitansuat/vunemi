import XCTest
@testable import VunemiHelper

final class WindowIdentityTests: XCTestCase {
    func testWindowListUsesAXTitlesAndExcludesTransientWindows() {
        let b=WindowBounds(x:10,y:20,width:300,height:200)
        let popup=WindowBounds(x:12,y:25,width:66,height:20)
        let result=labelledWindows(pid:42,ax:[.init(title:"Small target window",bounds:b)],candidates:[.init(id:1,pid:42,title:"",bounds:b),.init(id:2,pid:42,title:"",bounds:popup)])
        XCTAssertEqual(result.count,1)
        XCTAssertEqual(result.first?.id,1)
        XCTAssertEqual(result.first?.title,"Small target window")
    }
    func testMatchesGeometryRatherThanLargestWindow() {
        let selected = WindowBounds(x: 10, y: 20, width: 300, height: 200)
        let candidates = [WindowCandidate(id: 1, pid: 42, title: "A", bounds: selected), WindowCandidate(id: 2, pid: 42, title: "B", bounds: .init(x: 0, y: 0, width: 1000, height: 800))]
        XCTAssertEqual(matchingWindow(pid: 42, title: "A", bounds: selected, candidates: candidates)?.id, 1)
        XCTAssertNil(matchingWindow(pid: 43, title: "A", bounds: selected, candidates: candidates))
    }
    func testAmbiguousMovedAndClosedWindowsAreRefused() {
        let b = WindowBounds(x: 10, y: 20, width: 300, height: 200)
        let c = WindowCandidate(id: 1, pid: 42, title: "", bounds: b)
        XCTAssertNil(matchingWindow(pid: 42, title: "", bounds: b, candidates: [c, .init(id: 2, pid: 42, title: "", bounds: b)]))
        XCTAssertNil(matchingWindow(pid: 42, title: "", bounds: .init(x: 100, y: 20, width: 300, height: 200), candidates: [c]))
        XCTAssertNil(matchingWindow(pid: 42, title: "", bounds: b, candidates: []))
    }
}
