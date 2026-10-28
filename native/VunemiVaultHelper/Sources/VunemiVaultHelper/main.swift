// Narrow Keychain broker. No desktop, shell, input, TCC or networking APIs.
import Foundation

typealias JSON = [String: Any]
struct Failure: Error { let message: String; init(_ message: String) { self.message = message } }

func vaultResponse(request: JSON, callerAllowed: Bool, loadKey: (Bool, Bool) throws -> JSON) -> JSON {
 let id = request["id"] ?? NSNull()
 guard callerAllowed else { return ["id":id,"ok":false,"error":"Kasa anahtarı yalnız Vunemi'ye verilir."] }
 guard request["op"] as? String == "vault_key" else { return ["id":id,"ok":false,"error":"Bilinmeyen Kasa işlemi."] }
 let args = request["args"] as? JSON ?? [:]
 do { return ["id":id,"ok":true,"result":try loadKey(args["create"] as? Bool ?? false, args["interactive"] as? Bool ?? false)] }
 catch let failure as Failure { return ["id":id,"ok":false,"error":failure.message] }
 catch { return ["id":id,"ok":false,"error":"Kasa anahtarı alınamadı."] }
}

// Validate the parent before accepting input. Never echo a request or key to stderr.
let callerAllowed = callerIsVunemi()
while let line = readLine() {
 guard let bytes = line.data(using:.utf8), bytes.count <= 65_536,
       let request = (try? JSONSerialization.jsonObject(with:bytes)) as? JSON else { continue }
 let response = vaultResponse(request:request,callerAllowed:callerAllowed,loadKey:vaultKey)
 if let data = try? JSONSerialization.data(withJSONObject:response) {
  FileHandle.standardOutput.write(data);FileHandle.standardOutput.write(Data([10]))
 }
}
