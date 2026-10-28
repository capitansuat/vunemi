import AppKit
import ApplicationServices
import Darwin

/// This metadata route never requests TCC, reads AXValue/selected text, or activates a target.
func validBackgroundIdentityMetadata(pid:Int32,requestedPID:Int32,window:UInt32,requestedWindow:UInt32,startSec:UInt64,startUsec:UInt64,bundle:String,executable:String,bundleExecutable:String,bounds:WindowBounds)->Bool {
    pid>0 && pid==requestedPID && window>0 && window==requestedWindow && startSec>0 && startUsec<1_000_000 && !bundle.isEmpty && !executable.isEmpty && executable==bundleExecutable && bounds.x.isFinite && bounds.y.isFinite && bounds.width.isFinite && bounds.height.isFinite && bounds.width>0 && bounds.height>0
}
func protectedBackgroundIdentity(bundle:String,name:String)->Bool {
    let prefixes=["com.apple.Terminal","com.googlecode.iterm2","co.zeit.hyper","dev.warp.Warp","net.kovidgoyal.kitty","io.alacritty","com.github.wez.wezterm","com.apple.keychainaccess","com.apple.Passwords","com.1password","com.agilebits.onepassword","com.bitwarden","com.dashlane","com.github.Electron","com.vunemi","com.openai.codex","com.apple.systempreferences","com.apple.SystemSettings","com.apple.ScriptEditor2","com.apple.Automator","com.apple.dt.Xcode"]
    let lower=bundle.lowercased(),label=name.lowercased()
    return prefixes.contains{lower.hasPrefix($0.lowercased())} || ["vunemi", "codex", "terminal", "iterm", "warp", "kitty", "alacritty", "wezterm", "ghostty", "keychain access", "anahtar zinciri erişimi", "schlüsselbundverwaltung", "trousseaux d’accès", "trousseaux d'accès", "acceso a llaveros", "accesso portachiavi", "acesso às chaves", "связка ключей", "钥匙串访问", "キーチェーンアクセス", "키체인 접근", "passwords", "parolalar", "passwörter", "mots de passe", "contraseñas", "senhas", "пароли", "密码", "パスワード", "암호", "1password", "bitwarden", "dashlane", "system settings", "sistem ayarları", "systemeinstellungen", "réglages système", "ajustes del sistema", "impostazioni di sistema", "ajustes do sistema", "системные настройки", "系统设置", "システム設定", "시스템 설정", "ターミナル", "终端", "터미널", "терминал", "system preferences", "script editor", "automator", "electron"].contains{label.contains($0)}
}
func backgroundTargetIdentity(_ args:JSON)throws->JSON {
    guard Set(args.keys)==Set(["app","windowId"]),let raw=args["app"] as? String,let pid=Int32(raw),pid>0,String(pid)==raw,
          let number=args["windowId"] as? NSNumber,CFGetTypeID(number) != CFBooleanGetTypeID(),number.doubleValue.rounded()==number.doubleValue,number.doubleValue>0,number.doubleValue<=Double(UInt32.max) else {throw Failure("Exact numeric PID and window identity required.")}
    let requestedWindow=number.uint32Value
    try checkBackgroundSession()
    guard AXIsProcessTrusted() else {throw Failure("Accessibility is unavailable; no permission prompt opened.")}
    try requireBackgroundTarget(target:pid,foreground:focusedApplicationPID())
    guard let app=NSRunningApplication(processIdentifier:pid),let bundle=app.bundleIdentifier,let url=app.bundleURL,let executable=Bundle(url:url)?.executableURL?.path,
          !protectedBackgroundIdentity(bundle:bundle,name:app.localizedName ?? "") else {throw Failure("Protected or unavailable target.")}
    var info=proc_bsdinfo(),path=[CChar](repeating:0,count:Int(4*MAXPATHLEN))
    guard proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,Int32(MemoryLayout<proc_bsdinfo>.size))==MemoryLayout<proc_bsdinfo>.size,info.pbi_uid==getuid(),proc_pidpath(pid,&path,UInt32(path.count))>0 else{throw Failure("Public process identity unavailable.")}
    let root=try selectedAXWindow(pid:pid,windowId:requestedWindow,allowActivation:false)
    let window=try windowForAX(root,pid:pid)
    guard validBackgroundIdentityMetadata(pid:Int32(info.pbi_pid),requestedPID:pid,window:window.id,requestedWindow:requestedWindow,startSec:info.pbi_start_tvsec,startUsec:info.pbi_start_tvusec,bundle:bundle,executable:String(cString:path),bundleExecutable:executable,bounds:window.bounds) else{throw Failure("Window or process identity changed.")}
    var after=proc_bsdinfo(),afterPath=[CChar](repeating:0,count:Int(4*MAXPATHLEN))
    let currentRoot=try selectedAXWindow(pid:pid,windowId:requestedWindow,allowActivation:false)
    let currentWindow=try windowForAX(currentRoot,pid:pid)
    guard proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&after,Int32(MemoryLayout<proc_bsdinfo>.size))==MemoryLayout<proc_bsdinfo>.size,
          after.pbi_pid==info.pbi_pid,after.pbi_uid==info.pbi_uid,after.pbi_start_tvsec==info.pbi_start_tvsec,after.pbi_start_tvusec==info.pbi_start_tvusec,
          proc_pidpath(pid,&afterPath,UInt32(afterPath.count))>0,String(cString:afterPath)==String(cString:path),
          NSRunningApplication(processIdentifier:pid)?.bundleIdentifier==bundle,
          currentWindow.id==window.id,currentWindow.bounds==window.bounds,CFEqual(root,currentRoot) else{throw Failure("Process or window incarnation changed during identity check.")}
    try checkBackgroundSession()
    try requireBackgroundTarget(target:pid,foreground:focusedApplicationPID())
    let result:JSON=["version":1,"controlMode":"backgroundStrict","bundleId":bundle,"pid":Int(pid),"startSec":String(info.pbi_start_tvsec),"startUsec":String(info.pbi_start_tvusec),"windowId":Int(window.id),"appName":String((app.localizedName ?? "").prefix(2048)),"windowTitle":String(window.title.prefix(4096))]
    guard let data=try? JSONSerialization.data(withJSONObject:result),data.count<=20480 else{throw Failure("Identity metadata exceeds bounded response.")}
    return result
}

/// Only trusted JS metadata is attached to describe, never a model-visible argument.
func requireBackgroundTaskPermissionIdentity(_ expected:JSON,pid:Int32,windowId:UInt32?)throws {
    guard Set(expected.keys)==Set(["kind","bundleId","pid","startSec","startUsec","windowId","controlMode"]),
          expected["kind"] as? String == "native-window",expected["controlMode"] as? String == "backgroundStrict",
          let windowId,let expectedPID=expected["pid"] as? Int,expectedPID==Int(pid),
          let expectedWindow=expected["windowId"] as? Int,expectedWindow==Int(windowId) else{throw Failure("Invalid prepared window authority.")}
    let current=try backgroundTargetIdentity(["app":String(pid),"windowId":Int(windowId)])
    for key in ["bundleId","startSec","startUsec"] {
        guard let value=expected[key] as? String,current[key] as? String==value else{throw Failure("Prepared process identity changed before observation.")}
    }
}
