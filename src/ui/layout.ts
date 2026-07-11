/** Reserve more vertical chrome on narrow terminals, where labels wrap sooner. */
export function listRowsForTerminal(rows: number, cols: number): number {
  const chrome = cols < 50 ? 13 : cols < 80 ? 10 : 8;
  return Math.max(4, rows - chrome - 2);
}
