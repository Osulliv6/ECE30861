const prefix = '<!doctype html><html lang="en"><head><title>Schedule</title></head><body>';
const suffix = '</body></html>';

export function htmlElementBoundary(count) {
  return Buffer.from(prefix + '<i></i>'.repeat(count - 4) + suffix);
}

export function htmlByteBoundary() {
  const body = '<h1>Course schedule</h1>' +
    '<p style="color:#202020">Course schedule and laboratory information.</p>'.repeat(110_000);
  const padding = 10 * 1024 * 1024 - Buffer.byteLength(prefix + body + '<!---->' + suffix);
  return Buffer.from(prefix + body + '<!--' + '<x>'.repeat(Math.floor(padding / 3)) + ' '.repeat(padding % 3) + '-->' + suffix);
}
