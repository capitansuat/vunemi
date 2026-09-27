// Draws the background of the Vunemi disk image window: where to drag the
// app, and the one extra step a self-signed build needs on first open.
// English only: the image can't follow the Mac's language, and the install
// page already says the same in each language.
// Icon positions must match scripts/dmg-settings.py.
//
//   swift scripts/dmg-background.swift <output folder>
//
// Writes background.png (1x) and background@2x.png; dmgbuild joins them.
import AppKit

let width: CGFloat = 640
let height: CGFloat = 440
let appX: CGFloat = 170
let applicationsX: CGFloat = 470
let iconY: CGFloat = 200  // from the top, as Finder counts

let ink = NSColor(red: 0.165, green: 0.114, blue: 0.086, alpha: 1)  // #2a1d16
let soft = NSColor(red: 0.165, green: 0.114, blue: 0.086, alpha: 0.62)
let accent = NSColor(red: 1.0, green: 0.478, blue: 0.271, alpha: 1)  // #ff7a45
let paper = NSColor(red: 0.984, green: 0.937, blue: 0.886, alpha: 1)  // #fbefe2

func centered(_ text: String, y: CGFloat, size: CGFloat, weight: NSFont.Weight, color: NSColor) {
  let style = NSMutableParagraphStyle()
  style.alignment = .center
  let attrs: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: size, weight: weight),
    .foregroundColor: color,
    .paragraphStyle: style,
  ]
  let s = NSAttributedString(string: text, attributes: attrs)
  let h = s.boundingRect(with: NSSize(width: width - 60, height: 200), options: .usesLineFragmentOrigin).height
  s.draw(with: NSRect(x: 30, y: height - y - h, width: width - 60, height: h), options: .usesLineFragmentOrigin)
}

func draw() {
  paper.setFill()
  NSRect(x: 0, y: 0, width: width, height: height).fill()

  centered("Drag the Vunemi app into the Applications folder", y: 32, size: 22, weight: .semibold, color: ink)
  centered("This installs Vunemi on your Mac.", y: 66, size: 14, weight: .regular, color: soft)

  // Arrow between the two icons.
  let y = height - iconY
  let from = appX + 82
  let to = applicationsX - 82
  let shaft = NSBezierPath()
  shaft.move(to: NSPoint(x: from, y: y))
  shaft.line(to: NSPoint(x: to - 14, y: y))
  shaft.lineWidth = 6
  shaft.lineCapStyle = .round
  accent.setStroke()
  shaft.stroke()
  let head = NSBezierPath()
  head.move(to: NSPoint(x: to, y: y))
  head.line(to: NSPoint(x: to - 22, y: y + 16))
  head.line(to: NSPoint(x: to - 22, y: y - 16))
  head.close()
  accent.setFill()
  head.fill()

  // First open of a build that isn't notarized.
  let box = NSRect(x: 60, y: 30, width: width - 120, height: 76)
  NSColor(white: 1, alpha: 0.7).setFill()
  NSBezierPath(roundedRect: box, xRadius: 14, yRadius: 14).fill()
  centered("Then open Vunemi from Applications.", y: 348, size: 14, weight: .semibold, color: ink)
  centered("If macOS won't open it: System Settings › Privacy & Security › Open Anyway",
           y: 372, size: 12, weight: .regular, color: soft)
}

func write(scale: CGFloat, to path: String) {
  let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: Int(width * scale), pixelsHigh: Int(height * scale),
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  rep.size = NSSize(width: width, height: height)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  draw()
  NSGraphicsContext.restoreGraphicsState()
  try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

let out = CommandLine.arguments[1]
write(scale: 1, to: "\(out)/background.png")
write(scale: 2, to: "\(out)/background@2x.png")
