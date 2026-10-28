import XCTest
import Darwin
@testable import VunemiHelper
final class ScheduledDocumentRecipeTests:XCTestCase {
 func testHandleLifetimeRejectsExpiryClockReversalAndNonfiniteAge()throws{
  let created=Date(timeIntervalSince1970:100)
  for age in [0.0,4.999,5.0]{XCTAssertNoThrow(try requireScheduledHandleAge(at:created,now:created.addingTimeInterval(age)))}
  for age in [-0.001,5.001,Double.infinity,-Double.infinity,Double.nan]{XCTAssertThrowsError(try requireScheduledHandleAge(at:created,now:created.addingTimeInterval(age)))}
  // Admission at 4.9s cannot authorize an effect after a slow preflight.
  XCTAssertNoThrow(try requireScheduledHandleAge(at:created,now:created.addingTimeInterval(4.9)))
  XCTAssertThrowsError(try requireScheduledHandleAge(at:created,now:created.addingTimeInterval(6.9)))
 }
 func testLiteralUsesUTF16Bounds() throws {
  XCTAssertNoThrow(try requireScheduledLiteral("\nhello",beforeUnits:10))
  XCTAssertThrowsError(try requireScheduledLiteral("",beforeUnits:0))
  XCTAssertThrowsError(try requireScheduledLiteral(String(repeating:"😀",count:129),beforeUnits:0))
  XCTAssertThrowsError(try requireScheduledLiteral("a",beforeUnits:2000))
 }
 func testSessionIdleAndCounterFailClosed() throws {
  XCTAssertNoThrow(try requireScheduledIdle(idle:10,counter:5,expected:5))
  XCTAssertThrowsError(try requireScheduledIdle(idle:9.99,counter:5,expected:5))
  XCTAssertThrowsError(try requireScheduledIdle(idle:Double.nan,counter:5,expected:5))
  XCTAssertThrowsError(try requireScheduledIdle(idle:100,counter:6,expected:5))
 }
}

extension ScheduledDocumentRecipeTests {
 func testBackupParentSwapCannotRedirectCreation()throws{
  let base=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString),parent=base.appendingPathComponent("approved"),outside=base.appendingPathComponent("outside"),old=base.appendingPathComponent("original")
  try FileManager.default.createDirectory(at:parent,withIntermediateDirectories:true);try FileManager.default.createDirectory(at:outside,withIntermediateDirectories:true)
  defer{try? FileManager.default.removeItem(at:base)}
  let source=parent.appendingPathComponent("a.txt");try Data("fixture".utf8).write(to:source)
  var meta=stat();XCTAssertEqual(lstat(parent.path,&meta),0)
  let path=source.resolvingSymlinksInPath().path,backup=path+".vunemi-before-scheduled-test"
  XCTAssertThrowsError(try createScheduledBackup(path:path,backupPath:backup,before:"fixture",parentDevice:String(meta.st_dev),parentInode:String(meta.st_ino),beforeCreate:{try FileManager.default.moveItem(at:parent,to:old);try FileManager.default.createSymbolicLink(atPath:parent.path,withDestinationPath:outside.path)}))
  XCTAssertFalse(FileManager.default.fileExists(atPath:outside.appendingPathComponent("a.txt.vunemi-before-scheduled-test").path))
 }
}

extension ScheduledDocumentRecipeTests {
 func testForegroundCursorAndSessionChangesRejectEvenWithoutInputCounterChange()throws{
  let original:JSON=["uid":1,"securitySessionId":2,"foregroundPid":3,"x":4.0,"y":5.0]
  XCTAssertNoThrow(try requireScheduledEnvironmentIdentity(current:original,expected:original))
  for key in ["uid","securitySessionId","foregroundPid","x","y"]{var changed=original;changed[key]=999;XCTAssertThrowsError(try requireScheduledEnvironmentIdentity(current:changed,expected:original))}
 }
 func testBoundedBackupIsVerifiedAndNeverOverwrites()throws{
  let raw=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  try FileManager.default.createDirectory(at:raw,withIntermediateDirectories:true);let parent=raw.resolvingSymlinksInPath();defer{try? FileManager.default.removeItem(at:parent)}
  let path=parent.appendingPathComponent("a.txt").path,backup=path+".vunemi-before-scheduled-test";try Data("fixture".utf8).write(to:URL(fileURLWithPath:path))
  var meta=stat();XCTAssertEqual(lstat(parent.path,&meta),0)
  let result=try createScheduledBackup(path:path,backupPath:backup,before:"fixture",parentDevice:String(meta.st_dev),parentInode:String(meta.st_ino))
  XCTAssertEqual(result["status"] as? String,"backup-created");XCTAssertEqual(try String(contentsOfFile:backup,encoding:.utf8),"fixture")
  XCTAssertThrowsError(try createScheduledBackup(path:path,backupPath:backup,before:"different",parentDevice:String(meta.st_dev),parentInode:String(meta.st_ino)))
  XCTAssertEqual(try String(contentsOfFile:backup,encoding:.utf8),"fixture")
 }
}
