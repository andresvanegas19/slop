import AppKit

let arguments = CommandLine.arguments
guard arguments.count == 5,
      let input = NSImage(contentsOfFile: arguments[1]),
      let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: 1920,
        pixelsHigh: 1080,
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

let top = try String(contentsOfFile: arguments[3], encoding: .utf8)
let bottom = try String(contentsOfFile: arguments[4], encoding: .utf8)
let context = NSGraphicsContext(bitmapImageRep: bitmap)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context

let canvas = NSRect(x: 0, y: 0, width: 1920, height: 1080)
let imageRatio = input.size.width / input.size.height
let canvasRatio: CGFloat = 1920 / 1080
let imageRect: NSRect
if imageRatio > canvasRatio {
  let width = 1080 * imageRatio
  imageRect = NSRect(x: (1920 - width) / 2, y: 0, width: width, height: 1080)
} else {
  let height = 1920 / imageRatio
  imageRect = NSRect(x: 0, y: (1080 - height) / 2, width: 1920, height: height)
}
input.draw(in: imageRect, from: .zero, operation: .copy, fraction: 1)

let attributes: [NSAttributedString.Key: Any] = [
  .font: NSFont.systemFont(ofSize: 54, weight: .bold),
  .foregroundColor: NSColor.white
]

func draw(_ text: String, y: CGFloat) {
  guard !text.isEmpty else { return }
  let size = (text as NSString).size(withAttributes: attributes)
  let box = NSRect(x: (1920 - size.width) / 2 - 24, y: y - 18, width: size.width + 48, height: size.height + 36)
  NSColor.black.withAlphaComponent(0.55).setFill()
  NSBezierPath(roundedRect: box, xRadius: 8, yRadius: 8).fill()
  (text as NSString).draw(at: NSPoint(x: (1920 - size.width) / 2, y: y), withAttributes: attributes)
}

draw(top, y: 1080 - 120 - 54)
draw(bottom, y: 120)
NSGraphicsContext.restoreGraphicsState()
guard let data = bitmap.representation(using: .png, properties: [:]) else { exit(1) }
try data.write(to: URL(fileURLWithPath: arguments[2]))
