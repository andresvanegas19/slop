import AppKit

// Renders a subtle lower-third caption (bottom-left) onto a transparent 1920x1080 PNG, to be overlaid on video.
// Usage: swift render-caption.swift <output.png> <title.txt> <subtitle.txt> [width height]
let arguments = CommandLine.arguments
let width = arguments.count >= 6 ? Int(arguments[4]) ?? 1920 : 1920
let height = arguments.count >= 6 ? Int(arguments[5]) ?? 1080 : 1080
guard arguments.count == 4 || arguments.count == 6,
      let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: width,
        pixelsHigh: height,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bitmapFormat: .alphaFirst,
        bytesPerRow: 0,
        bitsPerPixel: 0
      ) else {
  exit(1)
}

let title = (try? String(contentsOfFile: arguments[2], encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
let subtitle = (try? String(contentsOfFile: arguments[3], encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
let context = NSGraphicsContext(bitmapImageRep: bitmap)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
NSColor.clear.setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()

// Soft darkening in the bottom-left corner only, for legibility without a box.
let gradient = NSGradient(colors: [NSColor.black.withAlphaComponent(0.38), NSColor.black.withAlphaComponent(0.0)])!
gradient.draw(in: NSRect(x: 0, y: 0, width: width, height: 320), angle: 90)

let shadow = NSShadow()
shadow.shadowColor = NSColor.black.withAlphaComponent(0.55)
shadow.shadowBlurRadius = 8
shadow.shadowOffset = NSSize(width: 0, height: -1)

let paragraph = NSMutableParagraphStyle()
paragraph.alignment = .left
let titleAttributes: [NSAttributedString.Key: Any] = [
  .font: NSFont.systemFont(ofSize: 40, weight: .semibold),
  .foregroundColor: NSColor.white.withAlphaComponent(0.96),
  .kern: 0.4,
  .shadow: shadow,
  .paragraphStyle: paragraph,
]
let subtitleAttributes: [NSAttributedString.Key: Any] = [
  .font: NSFont.systemFont(ofSize: 26, weight: .regular),
  .foregroundColor: NSColor.white.withAlphaComponent(0.82),
  .kern: 0.3,
  .shadow: shadow,
  .paragraphStyle: paragraph,
]

let left: CGFloat = width < height ? 72 : 104
var baseline: CGFloat = width < height ? 200 : 92
let bottom = baseline
if !subtitle.isEmpty {
  (subtitle as NSString).draw(at: NSPoint(x: left + 18, y: baseline), withAttributes: subtitleAttributes)
  baseline += 40
}
if !title.isEmpty {
  let size = (title as NSString).size(withAttributes: titleAttributes)
  (title as NSString).draw(at: NSPoint(x: left + 18, y: baseline), withAttributes: titleAttributes)
  // Thin accent rule to the left of the text block.
  NSColor.white.withAlphaComponent(0.85).setFill()
  NSBezierPath(rect: NSRect(x: left, y: (subtitle.isEmpty ? baseline : bottom) + 6, width: 3, height: baseline - (subtitle.isEmpty ? baseline : bottom) + size.height - 12)).fill()
}
NSGraphicsContext.restoreGraphicsState()
guard let data = bitmap.representation(using: .png, properties: [:]) else { exit(1) }
try data.write(to: URL(fileURLWithPath: arguments[1]))
