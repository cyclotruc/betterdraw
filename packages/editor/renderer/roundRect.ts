/**
 * Fills, then strokes, a rectangle with rounded corners, on a new path.
 * The fill uses the context's fill style. The stroke uses `strokeColor` when
 * given, which then stays the context's stroke style, else the current one.
 *
 * Uses the context's own `roundRect` where it has one, and otherwise draws
 * each corner with `arcTo`.
 */
export const roundRect = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  strokeColor?: string,
) => {
  context.beginPath();
  if (context.roundRect) {
    context.roundRect(x, y, width, height, radius);
  } else {
    const right = x + width;
    const bottom = y + height;
    // each arcTo runs along a side, then turns the corner at its end
    context.moveTo(x + radius, y);
    context.arcTo(right, y, right, bottom, radius);
    context.arcTo(right, bottom, x, bottom, radius);
    context.arcTo(x, bottom, x, y, radius);
    context.arcTo(x, y, right, y, radius);
    context.closePath();
  }
  context.fill();
  if (strokeColor) {
    context.strokeStyle = strokeColor;
  }
  context.stroke();
};
